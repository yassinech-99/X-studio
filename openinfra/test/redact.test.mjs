import test from 'node:test'
import assert from 'node:assert/strict'
import { redact, redactDeep, looksSecret } from '../src/redact.js'
import { Store } from '../src/store.js'
import { ArtifactStore } from '../src/artifacts.js'
import { tmpHome } from './helpers.mjs'
import path from 'node:path'

const FIXTURES = [
  'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
  'sk-or-v1-0123456789abcdef0123456789abcdef',
  'nvapi-AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  'sk-proj-abcdefghijklmnopqrstuvwx',
  'ghp_0123456789abcdefghijklmnopqrstuvwx',
  'AKIAIOSFODNN7EXAMPLE',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  'Authorization: Bearer abcdef1234567890abcdef',
  'password: hunter2hunter2',
]

test('every credential shape is redacted', () => {
  for (const f of FIXTURES) {
    const out = redact(`prefix ${f} suffix`)
    assert.doesNotMatch(out, new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), f)
    assert.match(out, /redacted/)
  }
})

test('redaction does not mangle ordinary text', () => {
  const text = 'sw-core-01 has 3 routes and an uptime of 41 days'
  assert.equal(redact(text), text)
  assert.equal(redact('sk-learn is not a key'), 'sk-learn is not a key')
})

test('redactDeep walks objects and arrays and kills secret-named keys outright', () => {
  const value = { api_key: 'anything', nested: { authorization: 'Bearer x', note: 'nvapi-abcdefghijkl' }, list: ['sk-ant-abcdefghijklmnop'] }
  const out = redactDeep(value)
  assert.equal(out.api_key, '[redacted]')
  assert.equal(out.nested.authorization, '[redacted]')
  assert.match(out.nested.note, /redacted/)
  assert.match(out.list[0], /redacted/)
})

test('looksSecret spots a leak and ignores clean text', () => {
  assert.equal(looksSecret('nothing here'), false)
  assert.equal(looksSecret('key sk-ant-abcdefghijklmnop'), true)
})

test('artifacts store redacted content', async () => {
  const home = tmpHome('oi-redact')
  const store = new ArtifactStore({ root: path.join(home, 'a') })
  const desc = await store.put('token=nvapi-ABCDEFGHIJKLMNOP1234')
  assert.doesNotMatch(store.getTextSync(desc.sha256), /nvapi-ABCDEF/)
})

test('a provider key never reaches the run record or an event', () => {
  const home = tmpHome('oi-redact')
  const store = new Store()
  store.createRun({ id: 'r', kind: 'agent' })
  store.appendEvent('r', 'provider.request', { authorization: 'Bearer sk-ant-abcdefghijklmnop' })
  const events = store.events('r')
  assert.doesNotMatch(JSON.stringify(events), /sk-ant-abcdefghijklmnop/)
  store.close()
})
