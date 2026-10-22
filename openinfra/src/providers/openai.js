/**
 * OpenAI Chat Completions — and everything that speaks it: OpenAI itself, NVIDIA NIM's hosted catalogue,
 * OpenRouter, vLLM, Ollama, LiteLLM and corporate gateways.
 *
 * One adapter instead of four is a deliberate choice: four near-identical code paths is four places for a
 * tool-call bug to hide. The differences that are real (base URL, auth header, model discovery, routing and
 * attribution headers, where the price shows up) are parameters, not forks.
 */
import { sseFrames } from '../sse.js'

export function toOpenAI({ system, messages, tools, maxTokens = 4096, temperature = null }) {
  const out = []
  if (system) out.push({ role: 'system', content: system })
  for (const m of messages) {
    if (m.role === 'user') {
      const text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      if (text) out.push({ role: 'user', content: text })
    } else if (m.role === 'assistant') {
      const text = m.content.filter((c) => c.type === 'text').map((c) => c.text).join('')
      const calls = m.content.filter((c) => c.type === 'tool_use')
      const msg = { role: 'assistant', content: text || null }
      if (calls.length) {
        msg.tool_calls = calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input || {}) },
        }))
      }
      if (text || calls.length) out.push(msg)
    } else if (m.role === 'tool') {
      for (const c of m.content) {
        if (c.type !== 'tool_result') continue
        out.push({
          role: 'tool',
          tool_call_id: c.id,
          content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content),
        })
      }
    }
  }
  const body = { model: null, messages: out, max_tokens: maxTokens }
  if (temperature != null) body.temperature = temperature
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    body.tool_choice = 'auto'
  }
  return body
}

export function fromOpenAI(data) {
  const choice = data.choices?.[0]
  const msg = choice?.message || {}
  const toolCalls = (msg.tool_calls || []).map((c) => ({
    id: c.id,
    name: c.function?.name,
    input: parseArgs(c.function?.arguments),
  }))
  return {
    text: msg.content || '',
    toolCalls,
    stopReason: choice?.finish_reason || null,
    servedModel: data.model || null,
    usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0, cost: data.usage?.cost ?? null },
  }
}

function parseArgs(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function openaiProvider({
  id,
  baseUrl,
  apiKey,
  headers = {},
  defaultModel,
  attribution = null,
  routing = null,
  fetchImpl = fetch,
  discoverModels = true,
  label = 'openai',
  extraBody = null,
}) {
  const root = baseUrl.replace(/\/$/, '')
  const authHeaders = () => (apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  const attrib = () => {
    const h = {}
    if (attribution?.referer) h['HTTP-Referer'] = attribution.referer
    if (attribution?.title) h['X-OpenRouter-Title'] = attribution.title
    if (attribution?.categories) h['X-OpenRouter-Categories'] = attribution.categories
    return h
  }

  const call = async (path, init = {}) => {
    const res = await fetchImpl(`${root}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...authHeaders(),
        ...attrib(),
        ...headers,
        ...(init.headers || {}),
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const err = new Error(`${label} ${res.status}: ${truncate(text)}`)
      err.status = res.status
      err.retryable = res.status === 429 || res.status >= 500
      throw err
    }
    return res
  }

  const withRouting = (body) => {
    if (!routing) return body
    const out = { ...body }
    for (const [k, v] of Object.entries(routing)) {
      if (['sort', 'allow_fallbacks', 'only', 'ignore', 'order', 'require_parameters', 'data_collection', 'zdr', 'quantizations', 'max_price'].includes(k)) {
        out.provider = { ...(out.provider || {}), [k]: v }
      } else if (k === 'models') out.models = v
      else if (k === 'suffix') out.model = `${out.model}${v}`
    }
    return out
  }

  return {
    id,
    kind: 'openai-compatible',
    baseUrl: root,
    async complete(req) {
      const body = withRouting({ ...toOpenAI(req), model: req.model || defaultModel })
      if (extraBody) Object.assign(body, extraBody)
      const res = await call('/chat/completions', { method: 'POST', body: JSON.stringify(body), signal: req.signal })
      return fromOpenAI(await res.json())
    },
    async stream(req, onDelta = () => {}) {
      const body = withRouting({ ...toOpenAI(req), model: req.model || defaultModel, stream: true, stream_options: { include_usage: true } })
      if (extraBody) Object.assign(body, extraBody)
      const res = await call('/chat/completions', { method: 'POST', body: JSON.stringify(body), signal: req.signal })
      let text = ''
      const calls = []
      let stopReason = null
      let model = null
      let usage = { input: 0, output: 0, cost: null }
      for await (const frame of sseFrames(res.body, req.signal)) {
        const d = frame.data
        if (!d) continue
        if (d.error) throw new Error(`${label} stream error: ${d.error.message || d.error.type || 'unknown'}`)
        if (d.usage) usage = { input: d.usage.prompt_tokens ?? 0, output: d.usage.completion_tokens ?? 0, cost: d.usage.cost ?? null }
        if (d.model) model = d.model
        const choice = d.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason) stopReason = choice.finish_reason
        const delta = choice.delta || {}
        if (delta.content) {
          text += delta.content
          onDelta(delta.content)
        }
        for (const tc of delta.tool_calls || []) {
          const idx = tc.index ?? 0
          if (!calls[idx]) calls[idx] = { id: tc.id || `call_${idx}`, name: '', args: '' }
          if (tc.id) calls[idx].id = tc.id
          if (tc.function?.name) calls[idx].name += tc.function.name
          if (tc.function?.arguments) calls[idx].args += tc.function.arguments
        }
      }
      const toolCalls = calls
        .filter(Boolean)
        .map((c) => ({ id: c.id, name: c.name, input: parseArgs(c.args) }))
      return { text, toolCalls, stopReason, servedModel: model, usage }
    },
    async models() {
      const res = await call('/models')
      const data = await res.json()
      const list = data.data || data.models || []
      return list.map((m) => ({ id: m.id || m.name, display: m.name || m.id, created: m.created || null, context: m.context_length || null }))
    },
    discoverModels,
  }
}

function truncate(s, n = 300) {
  return String(s).replace(/\s+/g, ' ').slice(0, n)
}
