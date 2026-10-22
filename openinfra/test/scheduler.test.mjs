import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  loadSchedule,
  validateSchedule,
  tick,
  runJob,
  exportSchedule,
  acquireLease,
  releaseLease,
  leaseHeld,
  leasePath,
  isWriteJob,
  approvalFile,
  parseDuration,
} from '../src/scheduler.js'
import { Store } from '../src/store.js'
import { workspacePaths } from '../src/paths.js'
import { makeWorkspace } from './helpers.mjs'

function writeSchedule(root, body) {
  fs.mkdirSync(workspacePaths(root).meta, { recursive: true })
  fs.writeFileSync(workspacePaths(root).schedule, body)
}

const BASH_JOB = `
[defaults]
timezone = "UTC"
overlap = "skip"
timeout = "10s"

[[job]]
name = "echoer"
kind = "bash"
cron = "*/5 * * * *"
command = "echo ran-$((1+1))"
`

test('a due job runs on tick and records state', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  writeSchedule(ws.root, BASH_JOB)
  const store = new Store()
  const res = await tick({ root: ws.root, store, now: new Date('2026-10-22T10:05:10Z') })
  assert.equal(res.ran, 1)
  assert.equal(res.runs[0].status, 'success')
  const journal = fs.readFileSync(path.join(workspacePaths(ws.root).runs, res.runs[0].id, 'journal.ndjson'), 'utf8')
  assert.match(journal, /job.output/)
  const state = store.scheduleState(ws.root, 'echoer')
  assert.equal(state.last_status, 'success')
  assert.equal(state.last_exit, 0)
  store.close()
})

test('tick is idempotent: the same instant twice runs the job once', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  writeSchedule(ws.root, BASH_JOB)
  const store = new Store()
  const at = new Date('2026-10-22T10:15:00Z')
  const first = await tick({ root: ws.root, store, now: at })
  const second = await tick({ root: ws.root, store, now: new Date(at.getTime() + 1000) })
  assert.equal(first.ran, 1)
  assert.equal(second.ran, 0)
  assert.equal(second.skipped.find((s) => s.job === 'echoer').reason, 'not due')
  store.close()
})

test('nothing runs before the first due time, and no history is backfilled', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  writeSchedule(ws.root, BASH_JOB)
  const store = new Store()
  const res = await tick({ root: ws.root, store, now: new Date('2026-10-22T10:02:30Z') })
  assert.equal(res.ran, 0)
  store.close()
})

test('a missed window beyond the grace period is skipped, not replayed', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  writeSchedule(ws.root, BASH_JOB)
  const store = new Store()
  // pretend we ticked at 09:00, then the machine slept until 12:30
  store.saveScheduleState({ workspace: ws.root, job: 'echoer', lastTick: '2026-10-22T09:00:00.000Z' })
  const res = await tick({ root: ws.root, store, now: new Date('2026-10-22T12:30:00Z') })
  assert.equal(res.ran, 0)
  assert.equal(res.skipped.find((s) => s.job === 'echoer').reason, 'missed')
  store.close()
})

test('missed = "once" runs a single catch-up instead of a flood', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  writeSchedule(ws.root, BASH_JOB.replace('timeout = "10s"', 'timeout = "10s"\nmissed = "once"'))
  const store = new Store()
  store.saveScheduleState({ workspace: ws.root, job: 'echoer', lastTick: '2026-10-22T09:00:00.000Z' })
  const res = await tick({ root: ws.root, store, now: new Date('2026-10-22T12:30:00Z') })
  assert.equal(res.ran, 1)
  assert.equal(res.runs[0].missed, true)
  store.close()
})

test('overlap: a held lease means skip, with the holder reported', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  writeSchedule(ws.root, BASH_JOB)
  const store = new Store()
  const lease = acquireLease(leasePath(ws.root, 'echoer'), { ttlMs: 60_000 })
  assert.ok(lease.token)
  const res = await tick({ root: ws.root, store, now: new Date('2026-10-22T10:05:10Z') })
  assert.equal(res.ran, 0)
  assert.equal(res.skipped.find((s) => s.job === 'echoer').reason, 'overlap')
  lease.release()
  const after = await tick({ root: ws.root, store, now: new Date('2026-10-22T10:05:20Z') })
  assert.equal(after.ran, 1)
  store.close()
})

test('leases: release is owner-checked and a dead pid is taken over', () => {
  const ws = makeWorkspace({ template: 'empty' })
  const file = leasePath(ws.root, 'x')
  const a = acquireLease(file, { ttlMs: 10_000 })
  assert.equal(a.token != null, true)
  const b = acquireLease(file, { ttlMs: 10_000 })
  assert.equal(b.token, null)
  assert.equal(releaseLease(file, 'not-the-token'), false)
  assert.equal(releaseLease(file, a.token), true)
  // stale lease from a process that no longer exists
  fs.writeFileSync(file, JSON.stringify({ token: 'dead', pid: 999_999, acquired_at: new Date().toISOString(), ttl_ms: 10_000 }))
  assert.equal(leaseHeld(file), null)
  const c = acquireLease(file, { ttlMs: 10_000 })
  assert.ok(c.token)
  c.release()
})

test('a scheduled write without a standing approval never starts', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  const marker = path.join(ws.root, 'APPLIED')
  writeSchedule(
    ws.root,
    `
[[job]]
name = "apply-bad"
kind = "ansible"
cron = "0 3 * * *"
playbook = "site.yml"
mode = "apply"
approval = "standing:nope"
`,
  )
  const store = new Store()
  const sched = loadSchedule(ws.root)
  const res = await tick({ root: ws.root, store, now: new Date('2026-10-22T03:00:10Z') })
  assert.equal(res.ran, 1)
  assert.equal(res.runs[0].exitCode, 4)
  assert.equal(res.runs[0].status, 'refused')
  assert.equal(fs.existsSync(marker), false)
  assert.match(res.runs[0].reason, /not found/)
  store.close()
})

test('a standing approval with the wrong plan hash refuses with exit 7', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  writeSchedule(
    ws.root,
    `
[[job]]
name = "apply-tofu"
kind = "tofu"
cron = "0 3 * * *"
command = "apply -auto-approve"
approval = "standing:appr_1"
plan_hash = "aaaa1111"
`,
  )
  fs.mkdirSync(path.dirname(approvalFile(ws.root, 'appr_1')), { recursive: true })
  fs.writeFileSync(approvalFile(ws.root, 'appr_1'), JSON.stringify({ id: 'appr_1', plan_hash: 'bbbb2222', expires: '2030-01-01T00:00:00Z' }))
  const store = new Store()
  const res = await tick({ root: ws.root, store, now: new Date('2026-10-22T03:00:10Z') })
  assert.equal(res.runs[0].exitCode, 7)
  assert.match(res.runs[0].reason, /plan changed since approval/)
  store.close()
})

test('an expired approval refuses with exit 4', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  writeSchedule(
    ws.root,
    `
[[job]]
name = "apply-tofu"
kind = "tofu"
cron = "0 3 * * *"
command = "apply -auto-approve"
approval = "standing:old"
plan_hash = "abc"
`,
  )
  fs.mkdirSync(path.dirname(approvalFile(ws.root, 'old')), { recursive: true })
  fs.writeFileSync(approvalFile(ws.root, 'old'), JSON.stringify({ id: 'old', plan_hash: 'abc', expires: '2020-01-01T00:00:00Z' }))
  const store = new Store()
  const res = await tick({ root: ws.root, store, now: new Date('2026-10-22T03:00:10Z') })
  assert.equal(res.runs[0].exitCode, 4)
  assert.match(res.runs[0].reason, /expired/)
  store.close()
})

test('validation catches the mistakes that would fail at 03:00', () => {
  const errors = validateSchedule({
    jobs: [
      { name: 'Bad Name', kind: 'bash', cron: '* * * * *', timezone: 'UTC', overlap: 'skip', missed: 'skip', timeout: '1m' },
      { name: 'nocmd', kind: 'bash', cron: '* * * * *', timezone: 'UTC', overlap: 'skip', missed: 'skip', timeout: '1m' },
      { name: 'badcron', kind: 'bash', cron: '99 * * * *', command: 'x', timezone: 'UTC', overlap: 'skip', missed: 'skip', timeout: '1m' },
      { name: 'badtz', kind: 'bash', cron: '* * * * *', command: 'x', timezone: 'Mars/Olympus', overlap: 'skip', missed: 'skip', timeout: '1m' },
      { name: 'write-no-approval', kind: 'ansible', cron: '0 3 * * *', playbook: 'p.yml', mode: 'apply', timezone: 'UTC', overlap: 'skip', missed: 'skip', timeout: '1m' },
    ],
    defaults: {},
  })
  const messages = errors.map((e) => e.message).join('\n')
  assert.match(messages, /name must be lowercase/)
  assert.match(messages, /bash jobs need command/)
  assert.match(messages, /out of range/)
  assert.match(messages, /unknown timezone/)
  assert.match(messages, /needs approval/)
})

test('isWriteJob separates checks from changes', () => {
  assert.equal(isWriteJob({ kind: 'ansible', mode: 'check' }), false)
  assert.equal(isWriteJob({ kind: 'ansible', mode: 'apply' }), true)
  assert.equal(isWriteJob({ kind: 'tofu', command: 'plan -detailed-exitcode' }), false)
  assert.equal(isWriteJob({ kind: 'tofu', command: 'apply -auto-approve' }), true)
  assert.equal(isWriteJob({ kind: 'bash', command: 'tofu apply' }), false, 'bash jobs are the operator’s own risk; the classifier does not inspect them')
})

test('a failing job records its exit code and does not throw', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  writeSchedule(ws.root, `[[job]]\nname = "boom"\nkind = "bash"\ncron = "* * * * *"\ncommand = "exit 42"\n`)
  const store = new Store()
  const sched = loadSchedule(ws.root)
  const res = await runJob({ job: sched.jobs[0], root: ws.root, store })
  assert.equal(res.ok, false)
  assert.equal(res.exitCode, 1)
  assert.equal(res.exit_code, 42)
  store.close()
})

test('a job whose tool is missing fails as a toolchain problem (exit 8)', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  writeSchedule(ws.root, `[[job]]\nname = "nothere"\nkind = "python"\ncron = "* * * * *"\nscript = "no-such.py"\n`)
  const store = new Store()
  const sched = loadSchedule(ws.root)
  // python3 exists, but the script does not: that is an ordinary failure, not exit 8
  const res = await runJob({ job: sched.jobs[0], root: ws.root, store })
  assert.equal(res.ok, false)
  const tofuJob = { ...sched.jobs[0], kind: 'tofu', command: 'plan', name: 'tofu-missing' }
  const t2 = await runJob({ job: tofuJob, root: ws.root, store })
  if (t2.status === 'tool-missing') assert.equal(t2.exitCode, 8)
  else assert.equal(t2.ok, true) // a machine that happens to have tofu
  store.close()
})

test('the scheduler refuses a schedule with errors instead of guessing', async () => {
  const ws = makeWorkspace({ template: 'empty' })
  writeSchedule(ws.root, `[[job]]\nname = "x"\nkind = "bash"\ncron = "* * * * *"\n`)
  const store = new Store()
  const res = await tick({ root: ws.root, store, now: new Date() })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'schedule has errors')
  store.close()
})

test('exports all call the same tick, so behaviour cannot diverge', () => {
  const ws = makeWorkspace({ template: 'lab' })
  for (const format of ['systemd', 'cron', 'launchd', 'k8s']) {
    const out = exportSchedule({ root: ws.root, format })
    assert.match(out.content, /tick/)
    if (format === 'k8s') assert.match(out.content, /concurrencyPolicy: Forbid/)
    if (format === 'launchd') assert.match(out.content, /StartInterval/)
  }
  assert.throws(() => exportSchedule({ root: ws.root, format: 'cronjob' }), /unknown format/)
})

test('durations parse, and nonsense durations are rejected', () => {
  assert.equal(parseDuration('30s'), 30_000)
  assert.equal(parseDuration('10m'), 600_000)
  assert.equal(parseDuration('2h'), 7_200_000)
  assert.equal(parseDuration('nope'), null)
})
