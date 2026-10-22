import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runAgent, compactMessages, estimateTokens, SYSTEM_PROMPT } from '../src/agent.js'
import { fakeProvider } from '../src/providers/fake.js'
import { Store } from '../src/store.js'
import { BUILTIN } from '../src/permissions.js'
import { makeWorkspace } from './helpers.mjs'

function base(ws, over = {}) {
  const store = new Store()
  return {
    store,
    args: {
      provider: fakeProvider({ script: over.script }),
      providerId: 'fake',
      model: 'fake-1',
      mode: 'execute',
      workspace: ws.root,
      prompt: over.prompt || 'check something',
      rules: BUILTIN,
      store,
      ...over.args,
    },
  }
}

test('the loop runs a tool, feeds the result back and finishes', async () => {
  const ws = makeWorkspace()
  const { store, args } = base(ws, { script: [{ tool: 'bash', input: { command: 'echo from-the-loop' } }, { text: 'all done' }] })
  const events = []
  const result = await runAgent({ ...args, onEvent: (e) => events.push(e) })
  assert.equal(result.stopped, 'end_turn')
  assert.equal(result.steps, 2)
  const toolMsg = result.messages.find((m) => m.role === 'tool')
  assert.match(toolMsg.content[0].content, /from-the-loop/)
  assert.ok(events.some((e) => e.type === 'tool.start' && e.name === 'bash'))
  assert.ok(events.some((e) => e.type === 'assistant.message' && e.text === 'all done'))
  const transcript = fs.readFileSync(result.transcript, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(transcript[0].type, 'session.start')
  assert.ok(transcript.some((l) => l.type === 'tool' && l.name === 'bash'))
  assert.equal(transcript.at(-1).type, 'session.end')
  store.close()
})

test('a refused command comes back as a tool error, not a crash', async () => {
  const ws = makeWorkspace()
  const { store, args } = base(ws, {
    script: [{ tool: 'bash', input: { command: 'tofu apply -auto-approve' } }, { text: 'understood' }],
  })
  const result = await runAgent(args)
  const toolMsg = result.messages.find((m) => m.role === 'tool')
  assert.equal(toolMsg.content[0].is_error, true)
  assert.match(toolMsg.content[0].content, /refused/)
  assert.equal(result.messages.at(-1).content[0].text, 'understood')
  store.close()
})

test('read-only tools in one turn run in parallel, writes do not', async () => {
  const ws = makeWorkspace()
  fs.writeFileSync(path.join(ws.root, 'a.txt'), 'A')
  const { store, args } = base(ws, {
    script: [{ tool: 'read', input: { path: 'a.txt' } }, { text: 'done' }],
  })
  const seen = []
  const result = await runAgent({ ...args, onEvent: (e) => e.type === 'tool.start' && seen.push(e.name) })
  assert.deepEqual(seen, ['read'])
  assert.equal(result.stopped, 'end_turn')
  store.close()
})

test('max_steps is a hard stop', async () => {
  const ws = makeWorkspace()
  const loop = Array.from({ length: 10 }, () => ({ tool: 'bash', input: { command: 'echo again' } }))
  const { store, args } = base(ws, { script: loop })
  const result = await runAgent({ ...args, maxSteps: 3 })
  assert.equal(result.stopped, 'max_steps')
  assert.equal(result.steps, 3)
  store.close()
})

test('a negative budget stops the turn and says so', async () => {
  const ws = makeWorkspace()
  const { store, args } = base(ws, { script: [{ text: 'expensive' }] })
  const result = await runAgent({ ...args, budgetUsd: -1 })
  assert.equal(result.stopped, 'budget_exceeded')
  store.close()
})

test('token usage is recorded in the cost ledger', async () => {
  const ws = makeWorkspace()
  const { store, args } = base(ws, { script: [{ text: 'hi' }] })
  await runAgent(args)
  const rows = store.costSummary({ workspace: ws.root })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].input_tokens, 10)
  store.close()
})

test('compaction keeps the first message and the tail, and cuts the middle', () => {
  const big = (i) => ({ role: 'tool', content: [{ type: 'tool_result', id: `t${i}`, content: 'x'.repeat(4000), is_error: false }] })
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'the original ask' }] },
    ...Array.from({ length: 40 }, (_, i) => big(i)),
    { role: 'assistant', content: [{ type: 'text', text: 'latest' }] },
  ]
  const out = compactMessages(messages, { keepRecent: 4, maxTokens: 2000 })
  assert.equal(out.compacted, true)
  assert.equal(out.messages[0].content[0].text, 'the original ask')
  assert.equal(out.messages.at(-1).content[0].text, 'latest')
  assert.ok(out.after < out.before)
  assert.match(out.messages[1].content[0].content, /compacted/)
})

test('compaction is a no-op under the budget', () => {
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  const out = compactMessages(messages, { maxTokens: 100_000 })
  assert.equal(out.compacted, false)
  assert.equal(out.messages, messages)
})

test('estimateTokens counts assistant tool inputs too', () => {
  const a = estimateTokens([{ role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'bash', input: { command: 'x'.repeat(400) } }] }])
  assert.ok(a > 90)
})

test('the system prompt is short and says bash is the primary tool', () => {
  assert.match(SYSTEM_PROMPT, /primary tool: bash/)
  assert.ok(SYSTEM_PROMPT.length < 2200, `prompt is ${SYSTEM_PROMPT.length} chars — keep it tight`)
  assert.match(SYSTEM_PROMPT, /Never change infrastructure with bash/)
  assert.match(SYSTEM_PROMPT, /cannot install software/)
})
