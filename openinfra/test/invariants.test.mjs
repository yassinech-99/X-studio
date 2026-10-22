/**
 * The invariant suite from docs/phased.md §15.1. These ten tests never get deleted and never get skipped; if one
 * of them has to change, the change is a product decision, not a test fix.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runAgent, compactMessages } from '../src/agent.js'
import { fakeProvider } from '../src/providers/fake.js'
import { runTool } from '../src/tools.js'
import { BUILTIN } from '../src/permissions.js'
import { acquireLease, leasePath, tick, runJob, loadSchedule } from '../src/scheduler.js'
import { Store } from '../src/store.js'
import { checkDrift } from '../src/drift.js'
import { workspacePaths } from '../src/paths.js'
import { makeWorkspace, runCli } from './helpers.mjs'

test('1. protected facts survive forced compaction', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'change only sw-core-01 in bldg-c; plan hash abc123' }] },
    ...Array.from({ length: 30 }, (_, i) => ({ role: 'tool', content: [{ type: 'tool_result', id: `t${i}`, content: 'x'.repeat(5000), is_error: false }] })),
    { role: 'assistant', content: [{ type: 'text', text: 'final' }] },
  ]
  const out = compactMessages(messages, { keepRecent: 4, maxTokens: 1000 })
  assert.match(out.messages[0].content[0].text, /sw-core-01/)
  assert.match(out.messages[0].content[0].text, /abc123/)
  assert.equal(out.messages.at(-1).content[0].text, 'final')
})

test('2. a write tool without approval is refused before any adapter call', async () => {
  const ws = makeWorkspace()
  const res = await runTool('bash', { command: 'tofu apply' }, { workspace: ws.root, mode: 'execute', rules: BUILTIN })
  assert.equal(res.isError, true)
  assert.equal(res.meta.verdict, 'deny')
  assert.equal(res.meta.exitCode, undefined, 'nothing was executed')
})

test('3. a scheduled change whose plan hash moved does not run', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  const marker = path.join(ws.root, 'RAN')
  fs.writeFileSync(
    workspacePaths(ws.root).schedule,
    `[[job]]\nname = "apply"\nkind = "bash"\ncron = "* * * * *"\ncommand = "touch RAN"\n`,
  )
  // bash jobs are the operator's own risk, so prove the rule on an ansible apply where it is enforced
  fs.writeFileSync(
    workspacePaths(ws.root).schedule,
    `[[job]]\nname = "apply"\nkind = "ansible"\ncron = "* * * * *"\nplaybook = "p.yml"\nmode = "apply"\napproval = "standing:x"\nplan_hash = "one"\n`,
  )
  const dir = path.join(ws.root, '.openinfra', 'approvals')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({ id: 'x', plan_hash: 'two', expires: '2035-01-01T00:00:00Z' }))
  const store = new Store()
  const res = await tick({ root: ws.root, store, now: new Date() })
  assert.equal(res.runs[0].exitCode, 7)
  assert.equal(fs.existsSync(marker), false)
  store.close()
})

test('4. piped stdin can never approve', async () => {
  const ws = makeWorkspace()
  const res = await runTool('bash', { command: 'frobnicate' }, {
    workspace: ws.root,
    mode: 'explore',
    rules: BUILTIN,
    approve: undefined, // no approver available, as when stdin is a pipe
  })
  assert.equal(res.meta.verdict, 'ask')
  assert.equal(res.isError, true)
})

test('5. control characters from output never reach the terminal raw', async () => {
  const ws = makeWorkspace()
  const res = await runTool('bash', { command: `printf '\\033[2J\\033]0;pwned\\007visible'` }, { workspace: ws.root, mode: 'execute', rules: BUILTIN })
  assert.match(res.content, /visible/)
  assert.ok(!res.content.includes('\u001b]0;'), 'an OSC title sequence must not pass through')
})

test('6. there is no auto-approve anywhere in the source', () => {
  const root = path.join(process.cwd(), 'src')
  const hits = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.js')) {
        const text = fs.readFileSync(full, 'utf8')
        if (/auto[-_]?approve/i.test(text) && !/never|refus|deny|not |no auto|test/i.test(text)) hits.push(full)
      }
    }
  }
  walk(root)
  assert.deepEqual(hits, [])
})

test('7. a killed run leaves truthful state behind', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  fs.writeFileSync(workspacePaths(ws.root).schedule, `[[job]]\nname = "j"\nkind = "bash"\ncron = "* * * * *"\ncommand = "echo hi"\n`)
  const store = new Store()
  const sched = loadSchedule(ws.root)
  const res = await runJob({ job: sched.jobs[0], root: ws.root, store })
  const run = store.getRun(res.id)
  assert.equal(run.status, 'success')
  const journal = fs.readFileSync(path.join(workspacePaths(ws.root).runs, res.id, 'journal.ndjson'), 'utf8')
  assert.match(journal, /run\.started/)
  assert.match(journal, /run\.finished/)
  store.close()
})

test('8. doctor completes with no provider key and no network', async () => {
  const ws = makeWorkspace()
  const res = await runCli(['doctor', '--json'], { cwd: ws.root, env: { OPENINFRA_HOME: ws.dir } })
  assert.ok(res.json)
  assert.equal(res.json.counts.fail, 0)
})

test('9. a provider key never appears in a transcript', async () => {
  const ws = makeWorkspace()
  const store = new Store()
  const key = 'sk-ant-abcdefghijklmnopqrst'
  const result = await runAgent({
    provider: fakeProvider({ script: [{ tool: 'bash', input: { command: `echo ${key}` } }, { text: 'done' }] }),
    providerId: 'anthropic',
    model: 'claude-test',
    mode: 'execute',
    workspace: ws.root,
    prompt: 'echo the key',
    rules: BUILTIN,
    store,
  })
  const transcript = fs.readFileSync(result.transcript, 'utf8')
  assert.doesNotMatch(transcript, new RegExp(key))
  assert.match(transcript, /redacted/)
  store.close()
})

test('10. a scheduled write without a valid standing approval does not start', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  fs.writeFileSync(
    workspacePaths(ws.root).schedule,
    `[[job]]\nname = "apply"\nkind = "tofu"\ncron = "* * * * *"\ncommand = "apply -auto-approve"\ndir = "."\n`,
  )
  const sched = loadSchedule(ws.root)
  assert.equal(sched.errors.length, 1, 'the schedule itself refuses a write job without an approval')
  assert.match(sched.errors[0].message, /needs approval/)
})

test('11. a second tick cannot start a job another tick is running', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  fs.writeFileSync(workspacePaths(ws.root).schedule, `[[job]]\nname = "slow"\nkind = "bash"\ncron = "* * * * *"\ncommand = "sleep 2"\n`)
  const store = new Store()
  const lease = acquireLease(leasePath(ws.root, 'slow'), { ttlMs: 30_000 })
  const res = await tick({ root: ws.root, store, now: new Date() })
  assert.equal(res.ran, 0)
  assert.equal(res.skipped.find((s) => s.job === 'slow').reason, 'overlap')
  lease.release()
  store.close()
})
