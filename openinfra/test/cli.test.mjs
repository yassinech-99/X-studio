import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runCli, tmpHome, tmpDir } from './helpers.mjs'
import { EXIT } from '../src/exit.js'

function freshWorkspace(template = 'lab') {
  const home = tmpHome('oi-cli')
  const dir = tmpDir()
  const root = path.join(dir, 'ws')
  return { home, dir, root, args: ['workspace', 'new', 'demo', '--template', template, '--dir', root] }
}

test('workspace new / list / show / path', async () => {
  const { home, root, args } = freshWorkspace()
  const created = await runCli(args, { cwd: home })
  assert.equal(created.code, 0, created.stderr)
  assert.match(created.stdout, /created demo/)
  const list = await runCli(['workspace', 'list', '--json'], { cwd: home })
  assert.equal(list.json.workspaces[0].name, 'demo')
  const show = await runCli(['workspace', 'show'], { cwd: root })
  assert.match(show.stdout, /demo/)
  const p = await runCli(['workspace', 'path'], { cwd: root })
  assert.equal(p.stdout.trim(), root)
})

test('doctor is honest and machine readable', async () => {
  const { home, root, args } = freshWorkspace()
  await runCli(args, { cwd: home })
  const res = await runCli(['doctor', '--json'], { cwd: root })
  assert.ok(res.json.checks.length > 5)
  assert.equal(res.json.counts.fail, 0)
  assert.ok(res.json.checks.find((c) => c.id === 'workspace' && c.status === 'ok'))
})

test('outside a workspace the workspace verbs fail with exit 9', async () => {
  tmpHome('oi-cli')
  const dir = tmpDir()
  const res = await runCli(['doctor', '--json'], { cwd: dir })
  assert.ok(res.json)
  assert.equal(res.code, EXIT.OK, 'doctor outside a workspace is a warning, not a failure')
  const drift = await runCli(['drift', 'check'], { cwd: dir })
  assert.equal(drift.code, EXIT.WORKSPACE)
})

test('providers add fake, list it, and chat through it', async () => {
  const { home, root, args } = freshWorkspace()
  await runCli(args, { cwd: home })
  const add = await runCli(['providers', 'add', 'fake'], { cwd: root })
  assert.equal(add.code, 0, add.stderr)
  const list = await runCli(['providers', 'list', '--json'], { cwd: root })
  assert.equal(list.json.providers[0].id, 'fake')
  const chat = await runCli(['chat', '-p', 'RUN: echo cli-works', '--mode', 'execute'], { cwd: root })
  assert.equal(chat.code, 0, chat.stderr)
  assert.match(chat.stdout, /cli-works/)
  const sessions = fs.readdirSync(path.join(root, '.openinfra', 'sessions'))
  assert.equal(sessions.length, 1)
})

test('an agent cannot change infrastructure through bash', async () => {
  const { home, root, args } = freshWorkspace()
  await runCli(args, { cwd: home })
  await runCli(['providers', 'add', 'fake'], { cwd: root })
  const res = await runCli(['bash', '-c', 'tofu apply -auto-approve', '--json'], { cwd: root })
  assert.equal(res.json.isError, true)
  assert.equal(res.json.meta.verdict, 'deny')
  assert.match(res.json.content, /oi change/)
})

test('classify prints the tier and the verdict', async () => {
  const { home, root, args } = freshWorkspace()
  await runCli(args, { cwd: home })
  const res = await runCli(['classify', '-c', 'kubectl delete pod x', '--json'], { cwd: root })
  assert.equal(res.json.tier, 'infra-write')
  assert.equal(res.json.verdict, 'deny')
})

test('drift: exit 0 clean, exit 2 with drift, and it remembers transitions', async () => {
  const { home, root, args } = freshWorkspace()
  await runCli(args, { cwd: home })
  const driftDir = path.join(root, '.openinfra', 'drift')
  fs.mkdirSync(driftDir, { recursive: true })
  const observed = (hostname) =>
    fs.writeFileSync(path.join(driftDir, 'observed.json'), JSON.stringify({ objects: { 'devices.lab-sw-01': { hostname, site: 'lab', 'interfaces.Gi0/1.description': 'uplink' } } }))
  observed('lab-sw-01')
  const clean = await runCli(['drift', 'check'], { cwd: root })
  assert.equal(clean.code, EXIT.OK)
  observed('lab-sw-01-renamed')
  const dirty = await runCli(['drift', 'check', '--json'], { cwd: root })
  assert.equal(dirty.code, EXIT.DRIFT)
  assert.equal(dirty.json.summary.bySeverity.high, 1)
  const show = await runCli(['drift', 'show'], { cwd: root })
  assert.match(show.stdout, /hostname differs/)
  const transitions = await runCli(['drift', 'transitions'], { cwd: root })
  assert.match(transitions.stdout, /new/)
})

test('schedule list, tick, run, status and export', async () => {
  const { home, root, args } = freshWorkspace()
  await runCli(args, { cwd: home })
  const list = await runCli(['schedule', 'list'], { cwd: root })
  assert.match(list.stdout, /lab-smoke/)
  const run = await runCli(['schedule', 'run', 'lab-smoke'], { cwd: root })
  assert.equal(run.code, EXIT.OK, run.stdout + run.stderr)
  assert.match(run.stdout, /success/)
  const status = await runCli(['schedule', 'status', '--json'], { cwd: root })
  assert.equal(status.json.ok, true)
  const exported = await runCli(['schedule', 'export', '--format', 'systemd'], { cwd: root })
  assert.match(exported.stdout, /schedule tick/)
  const history = await runCli(['run', 'list'], { cwd: root })
  assert.match(history.stdout, /success/)
})

test('schedule disable/enable edits the source, not hidden state', async () => {
  const { home, root, args } = freshWorkspace()
  await runCli(args, { cwd: home })
  const res = await runCli(['schedule', 'disable', 'lab-smoke'], { cwd: root })
  assert.equal(res.code, EXIT.OK)
  const file = fs.readFileSync(path.join(root, '.openinfra', 'schedule.toml'), 'utf8')
  assert.match(file, /enabled = false/)
  const list = await runCli(['schedule', 'list'], { cwd: root })
  assert.doesNotMatch(list.stdout, /lab-smoke/)
})

test('schedule approve writes a standing approval that a scheduled apply can find', async () => {
  const { home, root, args } = freshWorkspace()
  await runCli(args, { cwd: home })
  const res = await runCli(['schedule', 'approve', 'x', '--plan-hash', 'abc123', '--id', 'appr_test'], { cwd: root })
  assert.equal(res.code, EXIT.OK)
  const file = path.join(root, '.openinfra', 'approvals', 'appr_test.json')
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(rec.plan_hash, 'abc123')
  assert.ok(Date.parse(rec.expires) > Date.now())
})

test('a broken config is a usage error, not a stack trace', async () => {
  const { home, root, args } = freshWorkspace()
  await runCli(args, { cwd: home })
  const cfg = path.join(root, '.openinfra', 'config.toml')
  fs.writeFileSync(cfg, '[agent]\nmax_step = 4\n') // typo: max_step
  const res = await runCli(['config', 'validate'], { cwd: root })
  assert.equal(res.code, EXIT.USAGE)
  assert.match(res.stderr, /unknown key agent\.max_step/)
})

test('unknown verbs and the missing TUI explain themselves', async () => {
  tmpHome('oi-cli')
  const a = await runCli(['wat'], { cwd: tmpDir() })
  assert.equal(a.code, EXIT.USAGE)
  assert.match(a.stderr, /unknown command/)
  const b = await runCli(['tui'], { cwd: tmpDir() })
  assert.equal(b.code, EXIT.USAGE)
  assert.match(b.stderr, /P8/)
})

test('--version and help do not need a workspace', async () => {
  tmpHome('oi-cli')
  const dir = tmpDir()
  assert.equal((await runCli(['--version'], { cwd: dir })).stdout.trim(), '0.1.0')
  assert.match((await runCli(['--help'], { cwd: dir })).stdout, /oi doctor/)
})

test('run show prints the journal of the run', async () => {
  const { home, root, args } = freshWorkspace()
  await runCli(args, { cwd: home })
  const run = await runCli(['schedule', 'run', 'lab-smoke', '--json'], { cwd: root })
  const id = run.json.id
  const show = await runCli(['run', 'show', id], { cwd: root })
  assert.match(show.stdout, /run\.started/)
  assert.match(show.stdout, /job\.output/)
  const json = await runCli(['run', 'show', id, '--json'], { cwd: root })
  assert.ok(json.json.journal.length >= 3)
})

test('cost reports what was spent, even when that is zero', async () => {
  const { home, root, args } = freshWorkspace()
  await runCli(args, { cwd: home })
  await runCli(['providers', 'add', 'fake'], { cwd: root })
  await runCli(['chat', '-p', 'hello'], { cwd: root })
  const res = await runCli(['cost', '--json'], { cwd: root })
  assert.equal(res.json.total_usd, 0)
  assert.equal(res.json.rows[0].turns, 1)
})
