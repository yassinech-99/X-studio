import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { anthropicProvider } from '../src/providers/anthropic.js'
import { openaiProvider } from '../src/providers/openai.js'
import { createProvider, probeProvider, estimateCost, withRetry } from '../src/providers/index.js'
import { fakeProvider } from '../src/providers/fake.js'

/** A local server that speaks both protocols. No network access, no keys, no flakiness. */
async function mockServer(handler) {
  const server = http.createServer(handler)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) }
}

function sse(res, frames) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const f of frames) res.write(f)
  res.end()
}

const req = (text = 'hi') => ({
  system: 'sys',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  tools: [{ name: 'bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } }],
  maxTokens: 100,
  model: 'test-model',
})

test('anthropic: converts the canonical request to Messages API shape', async (t) => {
  let seen = null
  const srv = await mockServer((rq, res) => {
    let body = ''
    rq.on('data', (c) => (body += c))
    rq.on('end', () => {
      seen = { body: JSON.parse(body), headers: rq.headers }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id: 'msg_1', model: 'claude-test', content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 3 } }))
    })
  })
  t.after(() => srv.close())
  const p = anthropicProvider({ id: 'anthropic', baseUrl: srv.url, apiKey: 'sk-ant-test', defaultModel: 'test-model' })
  const out = await p.complete(req())
  assert.equal(out.text, 'hello')
  assert.equal(out.usage.input, 12)
  assert.equal(seen.headers['x-api-key'], 'sk-ant-test')
  assert.equal(seen.headers['anthropic-version'], '2023-06-01')
  assert.equal(seen.body.max_tokens, 100)
  assert.equal(seen.body.system, 'sys')
  assert.equal(seen.body.tools[0].input_schema.type, 'object')
})

test('anthropic: streams text and tool_use blocks into a canonical response', async (t) => {
  const srv = await mockServer((rq, res) =>
    sse(res, [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 20 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Running it.' } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'bash' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ls"}' } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } })}\n\n`,
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]),
  )
  t.after(() => srv.close())
  const p = anthropicProvider({ id: 'anthropic', baseUrl: srv.url, apiKey: 'k', defaultModel: 'm' })
  const deltas = []
  const out = await p.stream(req(), (d) => deltas.push(d))
  assert.equal(out.text, 'Running it.')
  assert.deepEqual(out.toolCalls, [{ id: 'toolu_1', name: 'bash', input: { command: 'ls' } }])
  assert.equal(out.stopReason, 'tool_use')
  assert.equal(out.usage.output, 7)
  assert.deepEqual(deltas, ['Running it.'])
})

test('anthropic: a 429 is marked retryable, a 400 is not', async (t) => {
  let status = 429
  const srv = await mockServer((rq, res) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: status === 429 ? 'rate limited' : 'bad request' } }))
  })
  t.after(() => srv.close())
  const p = anthropicProvider({ id: 'a', baseUrl: srv.url, apiKey: 'k', defaultModel: 'm' })
  await assert.rejects(p.complete(req()), (err) => err.status === 429 && err.retryable === true)
  status = 400
  await assert.rejects(p.complete(req()), (err) => err.status === 400 && err.retryable === false)
})

test('openai-compatible: maps tool calls and usage, including streamed argument fragments', async (t) => {
  let seen = null
  const srv = await mockServer((rq, res) => {
    let body = ''
    rq.on('data', (c) => (body += c))
    rq.on('end', () => {
      seen = JSON.parse(body)
      sse(res, [
        `data: ${JSON.stringify({ model: 'served-model', choices: [{ delta: { content: 'ok ' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'bash', arguments: '{"comm' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ finish_reason: 'tool_calls', delta: {} }], usage: { prompt_tokens: 30, completion_tokens: 9, cost: 0.00042 } })}\n\n`,
        'data: [DONE]\n\n',
      ])
    })
  })
  t.after(() => srv.close())
  const p = openaiProvider({ id: 'nvidia', baseUrl: srv.url, apiKey: 'nvapi-x', defaultModel: 'meta/llama-3.3-70b-instruct' })
  const out = await p.stream(req(), () => {})
  assert.equal(out.text, 'ok ')
  assert.deepEqual(out.toolCalls, [{ id: 'call_a', name: 'bash', input: { command: 'ls' } }])
  assert.equal(out.servedModel, 'served-model')
  assert.equal(out.usage.cost, 0.00042)
  assert.equal(seen.tools[0].type, 'function')
  assert.equal(seen.model, 'test-model')
  assert.equal(seen.stream, true)
})

test('openrouter: sends attribution headers and passes routing through', async (t) => {
  let headers = null
  let body = null
  const srv = await mockServer((rq, res) => {
    let raw = ''
    rq.on('data', (c) => (raw += c))
    rq.on('end', () => {
      headers = rq.headers
      body = JSON.parse(raw)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'anthropic/claude-test', choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } }))
    })
  })
  t.after(() => srv.close())
  const p = openaiProvider({
    id: 'openrouter',
    baseUrl: srv.url,
    apiKey: 'sk-or-v1-test',
    attribution: { referer: 'https://openinfra.dev', title: 'OpenInfra' },
    routing: { sort: 'latency', allow_fallbacks: true },
  })
  const out = await p.complete(req())
  assert.equal(headers['http-referer'], 'https://openinfra.dev')
  assert.equal(headers['x-openrouter-title'], 'OpenInfra')
  assert.deepEqual(body.provider, { sort: 'latency', allow_fallbacks: true })
  assert.equal(out.usage.cost, 0.001)
})

test('model discovery uses /models and never hard-codes ids', async (t) => {
  const srv = await mockServer((rq, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'meta/llama-3.3-70b-instruct' }, { id: 'nvidia/nemotron-test' }] }))
  })
  t.after(() => srv.close())
  const p = openaiProvider({ id: 'nvidia', baseUrl: srv.url, apiKey: 'k' })
  const models = await p.models()
  assert.deepEqual(models.map((m) => m.id), ['meta/llama-3.3-70b-instruct', 'nvidia/nemotron-test'])
})

test('createProvider picks the right transport and refuses without a key', () => {
  const missing = () => createProvider('openai', { kind: 'openai', api_key_ref: 'keychain:openinfra/nonexistent' }, { env: {} })
  assert.throws(missing, /no key found/)
  const p = createProvider('local', { kind: 'openai-compatible', base_url: 'http://127.0.0.1:1/v1', api_key_ref: 'none' })
  assert.equal(p.kind, 'openai-compatible')
  const fake = createProvider('fake', { kind: 'fake' })
  assert.equal(fake.kind, 'fake')
})

test('the probe reports tools and streaming, and records the served model', async (t) => {
  const srv = await mockServer((rq, res) => {
    let body = ''
    rq.on('data', (c) => (body += c))
    rq.on('end', () => {
      const parsed = JSON.parse(body)
      if (parsed.stream) {
        sse(res, [`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' } }] })}\n\n`, 'data: [DONE]\n\n'])
      } else if (parsed.tools) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            model: 'served-x',
            choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ping', arguments: '{"value":"pong"}' } }] }, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }),
        )
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }))
      }
    })
  })
  t.after(() => srv.close())
  const p = openaiProvider({ id: 'x', baseUrl: srv.url, apiKey: 'k', defaultModel: 'm' })
  const probe = await probeProvider(p, 'm')
  assert.equal(probe.reachable, true)
  assert.equal(probe.tools, true)
  assert.equal(probe.streaming, true)
  assert.equal(probe.served_model, 'served-x')
  assert.equal(typeof probe.latency_ms, 'number')
})

test('cost comes from config when the provider does not report it', () => {
  assert.equal(estimateCost({ price_in: 3, price_out: 15 }, { input: 1_000_000, output: 1_000_000 }), 18)
  assert.equal(estimateCost({ price_in: 3 }, { input: 100, output: 100, cost: 0.5 }), 0.5)
  assert.equal(estimateCost({}, { input: 5, output: 5 }), null)
})

test('retry backs off for retryable failures and gives up immediately otherwise', async () => {
  let calls = 0
  const flaky = async () => {
    calls++
    if (calls < 3) throw Object.assign(new Error('429'), { status: 429, retryable: true })
    return 'ok'
  }
  assert.equal(await withRetry(flaky, { baseMs: 1 }), 'ok')
  assert.equal(calls, 3)

  let hard = 0
  await assert.rejects(
    withRetry(async () => {
      hard++
      throw Object.assign(new Error('400'), { status: 400, retryable: false })
    }, { baseMs: 1 }),
  )
  assert.equal(hard, 1)
})

test('the fake provider follows a script and never calls the network', async () => {
  const p = fakeProvider({ script: [{ text: 'first' }, { tool: 'bash', input: { command: 'echo hi' } }, { text: 'done' }] })
  assert.equal((await p.complete(req())).text, 'first')
  assert.equal((await p.complete(req())).toolCalls[0].name, 'bash')
  assert.equal((await p.complete(req())).text, 'done')
})
