/**
 * The provider layer: one interface, four transports, keys from the user.
 *
 *   kind = anthropic          -> native Messages API
 *   kind = openai             -> Chat Completions at api.openai.com
 *   kind = openrouter         -> Chat Completions + attribution + routing + cost in usage
 *   kind = openai-compatible  -> any base URL (NVIDIA NIM's hosted catalogue, vLLM, Ollama, LiteLLM, gateways)
 *   kind = fake               -> deterministic, for tests and offline demos
 */
import { anthropicProvider } from './anthropic.js'
import { openaiProvider } from './openai.js'
import { fakeProvider } from './fake.js'
import { resolveSecret } from '../secrets.js'
import { redact } from '../redact.js'
import { EXIT, OiError } from '../exit.js'

export const DEFAULT_BASE_URLS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
}

/** NVIDIA NIM is not a different protocol — it is an OpenAI-compatible catalogue. It gets a named alias. */
export const PROVIDER_PRESETS = {
  anthropic: { kind: 'anthropic', base_url: DEFAULT_BASE_URLS.anthropic, keyPrefix: 'sk-ant-' },
  openai: { kind: 'openai', base_url: DEFAULT_BASE_URLS.openai, keyPrefix: 'sk-' },
  openrouter: { kind: 'openrouter', base_url: DEFAULT_BASE_URLS.openrouter, keyPrefix: 'sk-or-' },
  nvidia: { kind: 'openai-compatible', base_url: DEFAULT_BASE_URLS.nvidia, keyPrefix: 'nvapi-' },
}

export function createProvider(id, cfg, { env = process.env, fetchImpl = fetch, script = null } = {}) {
  if (cfg.kind === 'fake') return fakeProvider({ id, model: cfg.models?.[0] || 'fake-1', script })
  const apiKey = resolveSecret(cfg.api_key_ref, { env })
  const baseUrl = cfg.base_url || DEFAULT_BASE_URLS[cfg.kind]
  if (!baseUrl) throw new OiError(`provider ${id}: base_url is required for kind ${cfg.kind}`, EXIT.USAGE)
  if (!apiKey && cfg.api_key_ref && cfg.api_key_ref !== 'none') {
    throw new OiError(
      `provider ${id}: no key found for ${cfg.api_key_ref}. Run \`oi providers add ${id}\` or set the matching OPENINFRA_KEY_* variable.`,
      EXIT.USAGE,
    )
  }
  if (cfg.kind === 'anthropic') {
    return anthropicProvider({ id, baseUrl, apiKey, headers: cfg.headers, defaultModel: cfg.models?.[0], fetchImpl })
  }
  return openaiProvider({
    id,
    baseUrl,
    apiKey,
    headers: cfg.headers,
    attribution: cfg.attribution,
    routing: cfg.routing,
    defaultModel: cfg.models?.[0],
    fetchImpl,
    label: cfg.kind === 'openrouter' ? 'openrouter' : id,
  })
}

/** Resolve the provider+model a session should start with, honouring per-mode selection. */
export function selectProvider(config, { mode = null, providerId = null, model = null, env = process.env, fetchImpl = fetch, script = null } = {}) {
  const wantedMode = mode || config.agent?.mode || 'explore'
  const picked = config.agent?.modes?.[wantedMode] || {}
  const id = providerId || picked.provider || config.providers?.default_provider || null
  if (!id) {
    throw new OiError(
      'no provider configured. Run `oi providers add anthropic|openai|nvidia|openrouter`, or `oi providers add fake` to try the harness offline.',
      EXIT.USAGE,
    )
  }
  const cfg = config.providers?.[id]
  if (!cfg) throw new OiError(`provider "${id}" is not configured`, EXIT.USAGE)
  const chosenModel = model || picked.model || cfg.models?.[0] || (cfg.kind === 'fake' ? 'fake-1' : null)
  if (!chosenModel) throw new OiError(`provider ${id} has no model; pass --model or set models in providers.toml`, EXIT.USAGE)
  return {
    provider: createProvider(id, cfg, { env, fetchImpl, script }),
    providerId: id,
    model: chosenModel,
    mode: wantedMode,
    selection: picked,
    cfg,
  }
}

/** Price from config when the provider does not return a cost (OpenAI, NIM); OpenRouter returns it in usage. */
export function estimateCost(cfg, usage) {
  if (usage?.cost != null) return usage.cost
  const inRate = Number(cfg?.price_in || 0)
  const outRate = Number(cfg?.price_out || 0)
  if (!inRate && !outRate) return null
  return ((usage?.input || 0) / 1e6) * inRate + ((usage?.output || 0) / 1e6) * outRate
}

/**
 * Capability probe: one tiny real call. It answers the questions the loop needs to branch on — can this model
 * call a tool at all, does it stream, how big is its context — instead of trusting a hard-coded table.
 */
export async function probeProvider(provider, model, { timeoutMs = 20_000 } = {}) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const tool = {
    name: 'ping',
    description: 'Reply with pong.',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
  }
  const out = {
    provider: provider.id,
    model,
    reachable: false,
    streaming: false,
    tools: false,
    latency_ms: null,
    error: null,
    context: null,
    probed_at: new Date().toISOString(),
  }
  try {
    const res = await provider.complete({
      system: 'You are a capability probe. Call the ping tool exactly once.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
      tools: [tool],
      maxTokens: 64,
      model,
      signal: controller.signal,
    })
    out.reachable = true
    out.tools = (res.toolCalls || []).some((c) => c.name === 'ping') || (res.toolCalls || []).length > 0
    out.served_model = res.servedModel
    out.usage = res.usage
  } catch (err) {
    out.error = redact(err.message)
  } finally {
    clearTimeout(timer)
    out.latency_ms = Date.now() - started
  }
  // streaming support is probed separately: a provider that streams has to produce at least one delta
  if (out.reachable) {
    try {
      let deltas = 0
      await provider.stream(
        { system: 'Say OK.', messages: [{ role: 'user', content: [{ type: 'text', text: 'OK' }] }], maxTokens: 16, model },
        () => deltas++,
      )
      out.streaming = deltas > 0
    } catch (err) {
      out.streaming = false
      out.stream_error = redact(err.message)
    }
  }
  return out
}

/** Retry only what is worth retrying, and never silently switch models mid-turn. */
export async function withRetry(fn, { attempts = 3, baseMs = 500, onRetry = null } = {}) {
  let lastErr = null
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const retryable = err.retryable !== false && (err.status === 429 || err.status >= 500 || err.code === 'ECONNRESET')
      if (!retryable || i === attempts - 1) break
      const delay = baseMs * 2 ** i + Math.random() * 200
      onRetry?.({ attempt: i + 1, delay, error: err })
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}
