/**
 * Configuration: global providers.toml + per-workspace .openinfra/config.toml.
 *
 * Two rules that matter more than convenience:
 *  1. Unknown keys are errors. A typo that silently turns a limit into a no-op is how people ship outages.
 *  2. Keys are references, never values. `api_key_ref` may be `keychain:…`, `env:NAME`, or `file:…`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseToml, stringifyToml } from './toml.js'
import { paths, workspacePaths } from './paths.js'
import { OiError, EXIT, usage } from './exit.js'

export const DEFAULT_CONFIG = Object.freeze({
  workspace: {},
  agent: { mode: 'explore', max_steps: 40, sandbox: 'allow-workspace', tools: {} },
  providers: {},
  doctor: { timeout_s: 8, concurrency: 25 },
  change: { require_signed_approval: true, allow_model_fallback: false },
  schedule: {},
})

const SCHEMA = {
  default_provider: 'string',
  workspace: { id: 'string', name: 'string', template: 'string', created: 'string' },
  agent: {
    mode: 'string',
    max_steps: 'number',
    sandbox: 'string',
    tools: 'object',
    modes: 'table-dynamic',
    reasoning: 'string',
    budget_usd: 'number',
  },
  providers: 'table-dynamic',
  doctor: { timeout_s: 'number', concurrency: 'number' },
  change: { require_signed_approval: 'boolean', allow_model_fallback: 'boolean', waves: 'array' },
  schedule: { timezone: 'string', notify: 'array' },
  cloud: { provider: 'string', role_arn: 'string', account: 'string', region: 'string', subscription: 'string', project: 'string' },
  kubernetes: { context: 'string', kubeconfig: 'string', read_only: 'boolean' },
  sources: { netbox: 'object', inventory: 'array' },
}

const PROVIDER_KEYS = {
  kind: 'string',
  api_key_ref: 'string',
  base_url: 'string',
  models: 'array',
  attribution: 'object',
  routing: 'object',
  headers: 'object',
  max_context: 'number',
  max_output: 'number',
  price_in: 'number',
  price_out: 'number',
}

function typeName(v) {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  return typeof v
}

function checkKeys(obj, schema, where) {
  for (const [k, v] of Object.entries(obj)) {
    const spec = schema[k]
    if (spec === undefined) throw usage(`unknown key ${where}${k}`)
    if (spec === 'table-dynamic') continue
    if (typeof spec === 'object' && spec !== null) {
      if (typeName(v) !== 'object') throw usage(`${where}${k} must be a table`)
      checkKeys(v, spec, `${where}${k}.`)
      continue
    }
    const actual = typeName(v)
    if (actual !== spec) throw usage(`${where}${k} must be ${spec}, got ${actual}`)
  }
}

export function validateConfig(raw) {
  checkKeys(raw, SCHEMA, '')
  for (const [id, p] of Object.entries(raw.providers || {})) {
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) throw usage(`provider id "${id}" must be lowercase [a-z0-9_-]`)
    if (typeof p !== 'object' || p === null) throw usage(`providers.${id} must be a table`)
    checkKeys(p, PROVIDER_KEYS, `providers.${id}.`)
    if (!p.kind) throw usage(`providers.${id}.kind is required`)
    if (!PROVIDER_KINDS.includes(p.kind)) {
      throw usage(`providers.${id}.kind must be one of ${PROVIDER_KINDS.join(', ')}`)
    }
    if (p.kind === 'openai-compatible' && !p.base_url) throw usage(`providers.${id}.base_url is required`)
  }
  for (const mode of ['explore', 'plan', 'execute', 'incident']) {
    const picked = raw.agent?.[mode] || raw.agent?.modes?.[mode]
    if (picked?.provider && !raw.providers?.[picked.provider]) {
      throw usage(`agent.${mode}.provider "${picked.provider}" is not a configured provider`)
    }
  }
  if (raw.default_provider && !raw.providers?.[raw.default_provider]) {
    throw usage(`default_provider "${raw.default_provider}" is not a configured provider`)
  }
  return raw
}

export const PROVIDER_KINDS = ['anthropic', 'openai', 'openrouter', 'openai-compatible', 'fake']

export function readTomlFile(file) {
  if (!fs.existsSync(file)) return null
  try {
    return parseToml(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new OiError(`${file}: ${err.message}`, EXIT.USAGE)
  }
}

export function writeTomlFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, stringifyToml(value) + '\n')
}

/** Shallow merge of nested tables; arrays replace. */
export function mergeConfig(base, extra) {
  const out = { ...base }
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeConfig(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

export function loadConfig({ workspaceRoot = null, home = paths.home } = {}) {
  const sources = []
  let cfg = structuredClone(DEFAULT_CONFIG)
  const globalFile = path.join(home, 'providers.toml')
  const global = readTomlFile(globalFile)
  if (global) {
    cfg = mergeConfig(cfg, global)
    sources.push(globalFile)
  }
  let ws = null
  if (workspaceRoot) {
    ws = workspacePaths(workspaceRoot)
    const local = readTomlFile(ws.config)
    if (local) {
      cfg = mergeConfig(cfg, local)
      sources.push(ws.config)
    }
  }
  cfg = normalizeModes(cfg)
  validateConfig(cfg)
  return { config: cfg, sources, workspace: ws }
}

/** `[agent.explore] provider/model` is sugar for `agent.modes.<mode>`. Keep both readable in code. */
function normalizeModes(cfg) {
  const agent = { ...(cfg.agent || {}) }
  const modes = { ...(agent.modes || {}) }
  for (const m of ['explore', 'plan', 'execute', 'incident']) {
    if (agent[m] && typeof agent[m] === 'object') {
      modes[m] = { ...(modes[m] || {}), ...agent[m] }
      delete agent[m]
    }
  }
  agent.modes = modes
  return { ...cfg, agent }
}

export function modeSelection(config, mode = null) {
  const wanted = mode || config.agent?.mode || 'explore'
  const picked = config.agent?.modes?.[wanted] || {}
  const provider = picked.provider || config.providers?.default_provider || null
  const model = picked.model || null
  return { mode: wanted, provider, model, ...picked }
}

export function resolveRef(ref, { env = process.env } = {}) {
  if (!ref) return null
  if (ref === 'none') return null
  if (ref.startsWith('env:')) return env[ref.slice(4)] || null
  if (ref.startsWith('${env:')) return env[ref.slice(6, -1)] || null
  if (ref.startsWith('keychain:') || ref.startsWith('file:')) return { ref }
  return { literal: ref }
}

export function redactedConfig(config) {
  const clone = structuredClone(config)
  for (const p of Object.values(clone.providers || {})) {
    if (p.api_key_ref) p.api_key_ref = p.api_key_ref.startsWith('keychain:') ? p.api_key_ref : '[reference]'
  }
  return clone
}
