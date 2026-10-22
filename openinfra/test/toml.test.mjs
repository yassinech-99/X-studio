import test from 'node:test'
import assert from 'node:assert/strict'
import { parseToml, stringifyToml, TomlError } from '../src/toml.js'

test('parses scalars, arrays, dotted keys and comments', () => {
  const t = parseToml(`
# a comment
name = "openinfra"   # trailing
count = 3
ratio = 0.5
on = true
list = [1, 2, 3]
mixed = ["a", "b"]
nested.key = "value"
when = 2026-10-22
`)
  assert.equal(t.name, 'openinfra')
  assert.equal(t.count, 3)
  assert.equal(t.ratio, 0.5)
  assert.equal(t.on, true)
  assert.deepEqual(t.list, [1, 2, 3])
  assert.deepEqual(t.mixed, ['a', 'b'])
  assert.equal(t.nested.key, 'value')
  assert.equal(t.when, '2026-10-22')
})

test('parses tables, arrays of tables and multi-line arrays', () => {
  const t = parseToml(`
[defaults]
timezone = "UTC"

[[job]]
name = "a"
args = [
  "--one",
  "--two", # comment inside
]

[[job]]
name = "b"
`)
  assert.equal(t.defaults.timezone, 'UTC')
  assert.equal(t.job.length, 2)
  assert.deepEqual(t.job[0].args, ['--one', '--two'])
})

test('parses inline tables', () => {
  const t = parseToml(`routing = { sort = "latency", allow_fallbacks = true }`)
  assert.deepEqual(t.routing, { sort: 'latency', allow_fallbacks: true })
})

test('reports the line number of a bad value', () => {
  assert.throws(
    () => parseToml(`a = 1\nb = @nope\n`),
    (err) => err instanceof TomlError && err.line === 2 && /unrecognised value/.test(err.message),
  )
})

test('refuses duplicate keys instead of silently overwriting', () => {
  assert.throws(() => parseToml(`a = 1\na = 2\n`), /duplicate key/)
})

test('round-trips the config shapes we write', () => {
  const value = {
    default_provider: 'nvidia',
    providers: { nvidia: { kind: 'openai-compatible', base_url: 'https://x/v1', models: ['meta/llama-3.3-70b-instruct'] } },
    agent: { explore: { provider: 'nvidia', model: 'meta/llama-3.3-70b-instruct' } },
  }
  assert.deepEqual(parseToml(stringifyToml(value)), value)
})

test('round-trips arrays of tables (schedule.toml)', () => {
  const value = { defaults: { timezone: 'Africa/Algiers' }, job: [{ name: 'a', kind: 'bash', cron: '*/5 * * * *', command: 'echo hi' }, { name: 'b', kind: 'drift', cron: '0 3 * * *' }] }
  assert.deepEqual(parseToml(stringifyToml(value)), value)
})

test('escapes and unicode survive a round trip', () => {
  const value = { s: 'a "quoted" \\ back\nnewline', u: 'café ☕' }
  assert.deepEqual(parseToml(stringifyToml(value)), value)
})
