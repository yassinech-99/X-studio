import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runTool, globToRegExp } from '../src/tools.js'
import { makeWorkspace, tmpHome } from './helpers.mjs'

function ctxFor(root, extra = {}) {
  return { workspace: root, mode: 'execute', readFiles: new Set(), ...extra }
}

test('bash runs and returns exit status, duration and tier', async () => {
  const ws = makeWorkspace()
  const ctx = ctxFor(ws.root)
  const res = await runTool('bash', { command: 'echo hello' }, ctx)
  assert.equal(res.ok, true)
  assert.match(res.content, /hello/)
  assert.match(res.content, /\[exit 0/)
  assert.equal(res.meta.tier, 'read')
  assert.equal(res.meta.verdict, 'allow')
})

test('a denied command is never spawned', async () => {
  const ws = makeWorkspace()
  tmpHome()
  const probe = path.join(ws.root, 'should-not-exist')
  const res = await runTool('bash', { command: `sudo touch ${probe}` }, ctxFor(ws.root))
  assert.equal(res.isError, true)
  assert.match(res.content, /refused/)
  assert.equal(fs.existsSync(probe), false, 'the process must not have run')
})

test('infra writes are refused and tell the model what to do instead', async () => {
  const ws = makeWorkspace()
  const res = await runTool('bash', { command: 'tofu apply -auto-approve' }, ctxFor(ws.root))
  assert.equal(res.isError, true)
  assert.equal(res.meta.verdict, 'deny')
  assert.match(res.content, /oi change/)
})

test('an ask without an approver is a refusal, not an allow', async () => {
  const ws = makeWorkspace()
  const res = await runTool('bash', { command: 'frobnicate --now' }, ctxFor(ws.root, { mode: 'explore' }))
  assert.equal(res.meta.verdict, 'ask')
  assert.equal(res.isError, true)
})

test('an approver turns ask into allow', async () => {
  const ws = makeWorkspace()
  const res = await runTool('bash', { command: 'printf "unknown-but-approved"' }, {
    ...ctxFor(ws.root, { mode: 'explore' }),
    approve: () => true,
  })
  assert.equal(res.isError, false)
})

test('timeout kills the process group', async () => {
  const ws = makeWorkspace()
  const started = Date.now()
  const res = await runTool('bash', { command: 'sleep 20', timeout_s: 1 }, ctxFor(ws.root))
  const elapsed = Date.now() - started
  assert.ok(elapsed < 6000, `took ${elapsed}ms`)
  assert.equal(res.meta.timedOut, true)
  assert.match(res.content, /timed out/)
})

test('large output is truncated and stored as an artifact', async () => {
  const ws = makeWorkspace()
  const res = await runTool('bash', { command: 'seq 1 60000' }, ctxFor(ws.root))
  assert.equal(res.meta.truncated, true)
  assert.ok(res.meta.artifacts.length >= 1, 'should have spilled to an artifact')
  assert.match(res.content, /truncated: full stdout is artifact/)
})

test('cwd cannot escape the workspace', async () => {
  const ws = makeWorkspace()
  const res = await runTool('bash', { command: 'ls', cwd: '/etc' }, ctxFor(ws.root))
  assert.equal(res.isError, true)
  assert.match(res.content, /outside the workspace/)
})

test('read numbers lines and requires the file to exist', async () => {
  const ws = makeWorkspace()
  fs.writeFileSync(path.join(ws.root, 'notes.txt'), 'alpha\nbeta\ngamma\n')
  const res = await runTool('read', { path: 'notes.txt' }, ctxFor(ws.root))
  assert.match(res.content, /1\talpha/)
  assert.match(res.content, /3\tgamma/)
  const missing = await runTool('read', { path: 'nope.txt' }, ctxFor(ws.root))
  assert.equal(missing.isError, true)
})

test('write refuses to overwrite a file the model has not read', async () => {
  const ws = makeWorkspace()
  fs.writeFileSync(path.join(ws.root, 'f.txt'), 'original')
  const ctx = ctxFor(ws.root, { mode: 'plan' })
  const refused = await runTool('write', { path: 'f.txt', content: 'new' }, ctx)
  assert.match(refused.content, /read f.txt before overwriting/)
  assert.equal(fs.readFileSync(path.join(ws.root, 'f.txt'), 'utf8'), 'original')
  await runTool('read', { path: 'f.txt' }, ctx)
  const ok = await runTool('write', { path: 'f.txt', content: 'new' }, ctx)
  assert.equal(ok.ok, true)
  assert.equal(fs.readFileSync(path.join(ws.root, 'f.txt'), 'utf8'), 'new')
})

test('edit fails on a non-unique or missing match and changes nothing', async () => {
  const ws = makeWorkspace()
  const file = path.join(ws.root, 'a.txt')
  fs.writeFileSync(file, 'x\nx\n')
  const ctx = ctxFor(ws.root, { mode: 'plan' })
  await runTool('read', { path: 'a.txt' }, ctx)
  const dup = await runTool('edit', { path: 'a.txt', old_string: 'x', new_string: 'y' }, ctx)
  assert.equal(dup.isError, true)
  assert.match(dup.content, /appears 2 times/)
  assert.equal(fs.readFileSync(file, 'utf8'), 'x\nx\n')
  const absent = await runTool('edit', { path: 'a.txt', old_string: 'zzz', new_string: 'y' }, ctx)
  assert.match(absent.content, /not found/)
  const all = await runTool('edit', { path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true }, ctx)
  assert.equal(all.ok, true)
  assert.equal(fs.readFileSync(file, 'utf8'), 'y\ny\n')
})

test('writes are denied in explore mode', async () => {
  const ws = makeWorkspace()
  const res = await runTool('write', { path: 'new.txt', content: 'x' }, ctxFor(ws.root, { mode: 'explore' }))
  assert.equal(res.isError, true)
  assert.equal(fs.existsSync(path.join(ws.root, 'new.txt')), false)
})

test('reading a secret path is denied even when reading is normally fine', async () => {
  const ws = makeWorkspace()
  fs.writeFileSync(path.join(ws.root, '.env'), 'API_KEY=secret')
  const res = await runTool('read', { path: '.env' }, ctxFor(ws.root))
  assert.equal(res.isError, true)
  assert.match(res.content, /secret file/)
})

test('grep and glob find things without a shell', async () => {
  const ws = makeWorkspace()
  fs.mkdirSync(path.join(ws.root, 'inventory'), { recursive: true })
  fs.writeFileSync(path.join(ws.root, 'inventory', 'sites.yaml'), 'site: bldg-c\nrole: core\n')
  const g = await runTool('grep', { pattern: 'bldg-c' }, ctxFor(ws.root))
  assert.match(g.content, /sites\.yaml/)
  const l = await runTool('glob', { pattern: '**/*.yaml' }, ctxFor(ws.root))
  assert.match(l.content, /inventory\/sites\.yaml/)
})

test('globToRegExp handles ** and single-star correctly', () => {
  assert.ok(globToRegExp('**/*.yaml').test('a/b/c.yaml'))
  assert.ok(!globToRegExp('*.yaml').test('a/c.yaml'))
  assert.ok(globToRegExp('a/*.txt').test('a/x.txt'))
})
