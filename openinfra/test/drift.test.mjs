import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { compareTrees, loadIntent, loadObserved, checkDrift, loadPolicy } from '../src/drift.js'
import { Store } from '../src/store.js'
import { makeWorkspace } from './helpers.mjs'

const intent = { objects: { 'devices.sw-01': { hostname: 'sw-01', 'interfaces.Gi1.mtu': 9000, 'routes.static': ['10.0.0.0/8'] } } }

test('identical trees produce no findings', () => {
  const observed = { objects: { 'devices.sw-01': { hostname: 'sw-01', 'interfaces.Gi1.mtu': 9000, 'routes.static': ['10.0.0.0/8'] } } }
  const { findings, coverage } = compareTrees(intent, observed, { policy: { severity: () => 'medium' } })
  assert.equal(findings.length, 0)
  assert.equal(coverage.compared, 1)
})

test('a changed infra value is high severity and carries both sides', () => {
  const observed = { objects: { 'devices.sw-01': { hostname: 'sw-01', 'interfaces.Gi1.mtu': 1500, 'routes.static': ['10.0.0.0/8'] } } }
  const { findings } = compareTrees(intent, observed)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].key, 'interfaces.Gi1.mtu')
  assert.equal(findings[0].severity, 'high')
  assert.equal(findings[0].desired, 9000)
  assert.equal(findings[0].observed, 1500)
  assert.match(findings[0].detail, /expected 9000, observed 1500/)
})

test('array order does not create drift', () => {
  const a = { objects: { x: { 'routes.static': ['10.0.0.0/8', '10.1.0.0/16'] } } }
  const b = { objects: { x: { 'routes.static': ['10.1.0.0/16', '10.0.0.0/8'] } } }
  assert.equal(compareTrees({ objects: a.objects }, b).findings.length, 0)
})

test('an unobserved object is unreadable, never silently matching', () => {
  const { findings, coverage } = compareTrees(intent, { objects: {} })
  assert.equal(coverage.unobserved.length, 1)
  assert.equal(findings[0].category, 'unreadable')
  assert.match(findings[0].detail, /unknown, not as matching/)
})

test('missing keys are distinct from changed keys', () => {
  const { findings } = compareTrees(intent, { objects: { 'devices.sw-01': { hostname: 'sw-01' } } })
  const missing = findings.filter((f) => f.category === 'missing')
  assert.equal(missing.length, 2)
})

test('a policy file overrides severity', () => {
  const ws = makeWorkspace()
  fs.mkdirSync(path.join(ws.root, 'rules'), { recursive: true })
  fs.writeFileSync(path.join(ws.root, 'rules', 'drift-policy.toml'), 'fail_on = "critical"\n\n[[rule]]\npath = "mtu"\nseverity = "low"\n')
  const policy = loadPolicy(ws.root)
  assert.equal(policy.severity('interfaces.Gi1.mtu', 9000, 1500), 'low')
  assert.equal(policy.failOn, 'critical')
  assert.equal(policy.severity('routes.static', 1, 2), 'high')
})

test('fingerprints are stable across runs and differ when the value changes', () => {
  const o1 = { objects: { x: { a: 1 } } }
  const a = compareTrees({ objects: { x: { a: 2 } } }, o1).findings[0]
  const b = compareTrees({ objects: { x: { a: 2 } } }, o1).findings[0]
  const c = compareTrees({ objects: { x: { a: 3 } } }, o1).findings[0]
  assert.equal(a.fingerprint, b.fingerprint)
  assert.notEqual(a.fingerprint, c.fingerprint)
})

test('checkDrift persists new → open → resolved transitions', () => {
  const ws = makeWorkspace()
  fs.mkdirSync(path.join(ws.root, 'intent'), { recursive: true })
  fs.writeFileSync(path.join(ws.root, 'intent', 'state.toml'), '[devices.sw-01]\nhostname = "sw-01"\n"interfaces.Gi1.mtu" = 9000\n')
  const driftDir = path.join(ws.root, '.openinfra', 'drift')
  fs.mkdirSync(driftDir, { recursive: true })
  const observed = (mtu) => {
    fs.writeFileSync(path.join(driftDir, 'observed.json'), JSON.stringify({ objects: { 'devices.sw-01': { hostname: 'sw-01', 'interfaces.Gi1.mtu': mtu } } }))
  }
  const store = new Store()
  observed(1500)
  const first = checkDrift({ root: ws.root, store })
  assert.equal(first.transitions.new, 1)
  assert.equal(first.drift, true)
  const second = checkDrift({ root: ws.root, store })
  assert.equal(second.transitions.new, 0)
  assert.equal(second.transitions.unchanged, 1)
  observed(9000)
  const third = checkDrift({ root: ws.root, store })
  assert.equal(third.transitions.resolved, 1)
  assert.equal(third.drift, false)
  const kinds = store.transitions({ workspace: ws.root }).map((t) => t.kind)
  assert.deepEqual(kinds, ['resolved', 'new'])
  store.close()
})

test('loadIntent flattens two levels into objects', () => {
  const ws = makeWorkspace({ template: 'empty' })
  fs.mkdirSync(path.join(ws.root, 'intent'), { recursive: true })
  fs.writeFileSync(path.join(ws.root, 'intent', 'a.toml'), '[devices.sw-01]\nhostname = "sw-01"\n[devices.sw-02]\nhostname = "sw-02"\n')
  const loaded = loadIntent(ws.root)
  assert.deepEqual(Object.keys(loaded.objects).sort(), ['devices.sw-01', 'devices.sw-02'])
  assert.deepEqual(loaded.objects['devices.sw-02'], { hostname: 'sw-02' })
})

test('loadObserved merges a folder of snapshots and tolerates a missing path', () => {
  const ws = makeWorkspace()
  const dir = path.join(ws.root, 'obs')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ objects: { x: { a: 1 } } }))
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ objects: { x: { b: 2 } } }))
  const merged = loadObserved(dir)
  assert.deepEqual(merged.objects.x, { a: 1, b: 2 })
  assert.deepEqual(loadObserved(path.join(ws.root, 'nope')).objects, {})
})

test('checkDrift without intent explains itself instead of throwing', () => {
  const ws = makeWorkspace({ template: 'empty' })
  fs.rmSync(path.join(ws.root, 'intent'), { recursive: true, force: true })
  const report = checkDrift({ root: ws.root })
  assert.equal(report.ok, false)
  assert.match(report.hint, /intent/)
})
