/**
 * Anthropic, over the native Messages API. Deliberately not their OpenAI-compatible layer: that path is
 * documented as evaluation-only, ignores prompt caching and ignores several parameters — which would quietly
 * make long agent turns much more expensive.
 */
import { sseFrames } from '../sse.js'

export const ANTHROPIC_VERSION = '2023-06-01'

export function toAnthropic({ system, messages, tools, maxTokens = 4096 }) {
  const out = []
  for (const m of messages) {
    if (m.role === 'user') {
      const blocks = m.content.filter((c) => c.type === 'text').map((c) => ({ type: 'text', text: c.text }))
      if (blocks.length) out.push({ role: 'user', content: blocks })
    } else if (m.role === 'assistant') {
      const blocks = []
      for (const c of m.content) {
        if (c.type === 'text' && c.text) blocks.push({ type: 'text', text: c.text })
        if (c.type === 'tool_use') blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input || {} })
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks })
    } else if (m.role === 'tool') {
      const blocks = m.content
        .filter((c) => c.type === 'tool_result')
        .map((c) => ({
          type: 'tool_result',
          tool_use_id: c.id,
          content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content),
          ...(c.is_error ? { is_error: true } : {}),
        }))
      if (blocks.length) out.push({ role: 'user', content: blocks })
    }
  }
  const body = { model: null, max_tokens: maxTokens, messages: out }
  if (system) body.system = system
  if (tools?.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
  }
  return body
}

export function fromAnthropic(data) {
  const blocks = data.content || []
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')
  const toolCalls = blocks
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input || {} }))
  return {
    text,
    toolCalls,
    stopReason: data.stop_reason || null,
    servedModel: data.model || null,
    usage: {
      input: data.usage?.input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
      cacheRead: data.usage?.cache_read_input_tokens ?? 0,
      cacheWrite: data.usage?.cache_creation_input_tokens ?? 0,
    },
  }
}

export function anthropicProvider({ id, baseUrl = 'https://api.anthropic.com', apiKey, headers = {}, defaultModel, fetchImpl = fetch }) {
  const call = async (path, init = {}) => {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey || '',
        'anthropic-version': ANTHROPIC_VERSION,
        ...headers,
        ...(init.headers || {}),
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err = new Error(`anthropic ${res.status}: ${truncate(text)}`)
      err.status = res.status
      err.retryable = res.status === 429 || res.status >= 500
      throw err
    }
    return res
  }

  return {
    id,
    kind: 'anthropic',
    baseUrl,
    async complete(req) {
      const body = toAnthropic(req)
      body.model = req.model || defaultModel
      body.stream = false
      const res = await call('/v1/messages', { method: 'POST', body: JSON.stringify(body), signal: req.signal })
      return fromAnthropic(await res.json())
    },
    async stream(req, onDelta = () => {}) {
      const body = toAnthropic(req)
      body.model = req.model || defaultModel
      body.stream = true
      const res = await call('/v1/messages', { method: 'POST', body: JSON.stringify(body), signal: req.signal })
      let text = ''
      const toolCalls = []
      let current = null
      let stopReason = null
      let model = null
      const usage = { input: 0, output: 0 }
      for await (const frame of sseFrames(res.body, req.signal)) {
        const ev = frame.event
        const d = frame.data
        if (!d) continue
        if (ev === 'message_start') {
          model = d.message?.model || null
          usage.input = d.message?.usage?.input_tokens ?? 0
          usage.cacheRead = d.message?.usage?.cache_read_input_tokens ?? 0
        } else if (ev === 'content_block_start') {
          if (d.content_block?.type === 'tool_use') {
            current = { id: d.content_block.id, name: d.content_block.name, input: {}, json: '' }
            toolCalls.push(current)
          } else if (d.content_block?.type === 'text') {
            current = null
          }
        } else if (ev === 'content_block_delta') {
          if (d.delta?.type === 'text_delta') {
            text += d.delta.text
            onDelta(d.delta.text)
          } else if (d.delta?.type === 'input_json_delta' && current) {
            current.json += d.delta.partial_json || ''
          }
        } else if (ev === 'content_block_stop') {
          if (current?.json) {
            try {
              current.input = JSON.parse(current.json)
            } catch {
              current.input = {}
            }
          }
          current = null
        } else if (ev === 'message_delta') {
          stopReason = d.delta?.stop_reason || stopReason
          if (d.usage?.output_tokens) usage.output = d.usage.output_tokens
        } else if (ev === 'error') {
          throw new Error(`anthropic stream error: ${d.error?.message || 'unknown'}`)
        }
      }
      return {
        text,
        toolCalls: toolCalls.map((t) => ({ id: t.id, name: t.name, input: t.input })),
        stopReason,
        servedModel: model,
        usage,
      }
    },
    async models() {
      const res = await call('/v1/models?limit=100')
      const data = await res.json()
      return (data.data || []).map((m) => ({ id: m.id, display: m.display_name || m.id, created: m.created_at || null }))
    },
  }
}

function truncate(s, n = 300) {
  return String(s).replace(/\s+/g, ' ').slice(0, n)
}
