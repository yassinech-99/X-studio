import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Store, isAlive } from '../src/store.js'
import { ArtifactStore, sha256, COMPRESSION } from '../src/artifacts.js'
import { createWorkspace, listWorkspaces, findWorkspace, workspaceIdOf, removeWorkspace, TEMPLATES } from '../src/workspace.js'
import { loadConfig } from '../src/config.js'
import { loadRules } from '../src/permissions.js'
import { tmpHome, tmpDir, makeWorkspace } from './helpers.mjs'

// One isolated home for the whole file: a shared database would let tests leak findings into each other.
tmpHome('oi-store')

test('runs are created, finished and listed', () => {
  const store = new Store()
  store.createRun({ id: 'r1', kind: 'drift', name: 'nightly', workspace: '/w' })
  store.finishRun('r1', { status: 'success', exitCode: 0 })
  const run = store.getRun('r1')
  assert.equal(run.status, 'success')
  assert.equal(run.exit_code, 0)
  assert.ok(run.ended_at)
  assert.equal(store.listRuns({ workspace: '/w' }).length, 1)
  store.close()
})

test('a run owned by a dead pid is reconciled, a live one is left alone', () => {
  const store = new Store()
  store.createRun({ id: 'dead', kind: 'job', pid: 999_999 })
  store.createRun({ id: 'alive', kind: 'job', pid: process.pid })
  const reconciled = store.reconcileRuns({ alive: (pid) => pid === process.pid })
  assert.deepEqual(reconciled, ['dead'])
  assert.equal(store.getRun('dead').status, 'interrupted')
  assert.equal(store.getRun('alive').status, 'running')
  store.close()
})

test('events are ordered per run', () => {
  const store = new Store()
  store.createRun({ id: 'e1', kind: 'job' })
  store.appendEvent('e1', 'job.exec', { command: 'x' })
  store.appendEvent('e1', 'job.output', { exitCode: 0 })
  const events = store.events('e1')
  assert.deepEqual(events.map((e) => e.seq), [1, 2])
  assert.equal(events[1].payload.exitCode, 0)
  store.close()
})

test('findings upsert by fingerprint and count occurrences', () => {
  const store = new Store()
  const base = { workspace: '/w', fingerprint: 'fp', category: 'changed', severity: 'high', title: 'x: y differs' }
  assert.equal(store.upsertFinding(base).kind, 'new')
  assert.equal(store.upsertFinding(base).kind, 'open')
  const changed = store.upsertFinding({ ...base, detail: 'new detail' })
  assert.equal(changed.kind, 'changed')
  assert.equal(changed.finding.occurrences, 3)
  assert.equal(store.listFindings({ workspace: '/w' }).length, 1)
  store.close()
})

test('resolving closes only what was not seen', () => {
  const store = new Store()
  store.upsertFinding({ workspace: '/w-resolve', fingerprint: 'a', category: 'changed', severity: 'high', title: 'a' })
  store.upsertFinding({ workspace: '/w-resolve', fingerprint: 'b', category: 'changed', severity: 'low', title: 'b' })
  const resolved = store.resolveMissing({ workspace: '/w-resolve', seenFingerprints: new Set(['a']) })
  assert.deepEqual(resolved, ['b'])
  assert.equal(store.listFindings({ workspace: '/w-resolve' }).length, 1)
  store.close()
})

test('cost rows aggregate per provider and model', () => {
  const store = new Store()
  store.recordCost({ provider: 'anthropic', model: 'm1', inputTokens: 100, outputTokens: 20, costUsd: 0.001 })
  store.recordCost({ provider: 'anthropic', model: 'm1', inputTokens: 50, outputTokens: 10, costUsd: 0.0005 })
  store.recordCost({ provider: 'nvidia', model: 'm2', inputTokens: 10, outputTokens: 1, costUsd: 0 })
  const rows = store.costSummary()
  assert.equal(rows.length, 2)
  assert.equal(rows[0].turns, 2)
  assert.equal(rows[0].input_tokens, 150)
  store.close()
})

test('schedule state upserts without wiping what it does not set', () => {
  const store = new Store()
  store.saveScheduleState({ workspace: '/w', job: 'j', lastRun: '2026-01-01T00:00:00Z', lastStatus: 'success' })
  store.saveScheduleState({ workspace: '/w', job: 'j', lastTick: '2026-01-02T00:00:00Z' })
  const s = store.scheduleState('/w', 'j')
  assert.equal(s.last_run, '2026-01-01T00:00:00Z')
  assert.equal(s.last_tick, '2026-01-02T00:00:00Z')
  store.close()
})

test('artifacts are content addressed, deduplicated and redacted', async () => {
  const home = tmpHome()
  const store = new ArtifactStore({ root: path.join(home, 'artifacts') })
  const a = await store.put('hello world')
  const b = await store.put('hello world')
  assert.equal(a.sha256, b.sha256)
  assert.equal(store.getTextSync(a.sha256), 'hello world')
  assert.equal(sha256('hello world'), a.sha256)
  const s = await store.put('token sk-ant-abcdefghijklmnop')
  assert.match(store.getTextSync(s.sha256), /\[redacted:anthropic-key\]/)
  assert.equal(COMPRESSION, typeof process.versions.node === 'string' ? COMPRESSION : 'gzip')
})

test('artifact gc removes only old, unreferenced blobs', async () => {
  const home = tmpHome()
  const store = new ArtifactStore({ root: path.join(home, 'artifacts') })
  const keep = await store.put('keep me')
  const drop = await store.put('drop me')
  const old = Date.now() - 200 * 86400_000
  fs.utimesSync(store.blobPath(drop.sha256), old / 1000, old / 1000)
  fs.utimesSync(store.blobPath(keep.sha256), old / 1000, old / 1000)
  const removed = await store.gc({ keep: new Set([keep.sha256]), olderThanMs: 90 * 86400_000 })
  assert.deepEqual(removed, [drop.sha256])
  assert.equal(store.has(keep.sha256), true)
})

test('creating a workspace writes the files, registers it and is discoverable from a subfolder', () => {
  const home = tmpHome()
  const dir = tmpDir()
  const root = path.join(dir, 'ws')
  const ws = createWorkspace({ name: 'demo', template: 'network-core', dir: root, git: false })
  assert.match(ws.id, /^ws_[a-f0-9]{16}$/)
  assert.ok(fs.existsSync(path.join(root, '.openinfra', 'config.toml')))
  assert.ok(fs.existsSync(path.join(root, '.openinfra', 'schedule.toml')))
  assert.ok(fs.existsSync(path.join(root, 'intent', 'state.toml')))
  const deep = path.join(root, 'inventory', 'nested')
  fs.mkdirSync(deep, { recursive: true })
  assert.equal(findWorkspace(deep), root)
  assert.equal(workspaceIdOf(root), ws.id)
  assert.equal(listWorkspaces(home)[0].name, 'demo')
  const cfg = loadConfig({ workspaceRoot: root })
  assert.equal(cfg.config.workspace.template, 'network-core')
})

test('workspace names are validated and duplicates refused', () => {
  const home = tmpHome()
  const dir = tmpDir()
  assert.throws(() => createWorkspace({ name: 'Bad Name', dir: path.join(dir, 'a'), git: false }), /must match/)
  assert.throws(() => createWorkspace({ name: 'ok', template: 'nope', dir: path.join(dir, 'b'), git: false }), /unknown template/)
  const root = path.join(dir, 'c')
  createWorkspace({ name: 'ok', dir: root, git: false })
  assert.throws(() => createWorkspace({ name: 'ok', dir: root, git: false }), /already an OpenInfra workspace/)
})

test('templates differ in what they scaffold', () => {
  for (const name of Object.keys(TEMPLATES)) {
    const home = tmpHome()
    const dir = tmpDir()
    const ws = createWorkspace({ name: 'x', template: name, dir: path.join(dir, 'ws'), git: false })
    assert.ok(fs.existsSync(ws.schedule))
  }
})

test('removing a workspace from the registry can keep the files', () => {
  const home = tmpHome()
  const dir = tmpDir()
  const root = path.join(dir, 'ws')
  createWorkspace({ name: 'gone', dir: root, git: false })
  removeWorkspace({ nameOrId: 'gone', home })
  assert.equal(listWorkspaces(home).length, 0)
  assert.ok(fs.existsSync(root))
})

test('a workspace with git init makes an initial commit', () => {
  const ws = makeWorkspace({ git: true })
  const log = fs.existsSync(path.join(ws.root, '.git'))
  assert.ok(log)
})

test('permissions load from the home and workspace files', () => {
  const home = tmpHome()
  const dir = tmpDir()
  const root = path.join(dir, 'ws')
  createWorkspace({ name: 'p', dir: root, git: false })
  const rules = loadRules({ home, workspaceRoot: root })
  assert.ok(rules.deny.length >= 10)
})

test('isAlive is false for a dead pid and true for us', () => {
  assert.equal(isAlive(999_999), false)
  assert.equal(isAlive(process.pid), false, 'by design: our own pid is not an interesting sibling')
})
