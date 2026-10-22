/**
 * Secret redaction. Everything that leaves the process — transcripts, artifacts, logs, events, tool results,
 * error messages — goes through `redact()`. Tested with fixtures in test/redact.test.mjs and enforced by the
 * invariant suite (keys never appear in a transcript).
 */

const PATTERNS = [
  // provider key shapes, most specific first
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[redacted:anthropic-key]'],
  [/\bsk-or-v1-[A-Za-z0-9_-]{8,}/g, '[redacted:openrouter-key]'],
  [/\bsk-proj-[A-Za-z0-9_-]{8,}/g, '[redacted:openai-key]'],
  [/\bsk-[A-Za-z0-9_-]{20,}/g, '[redacted:openai-key]'],
  [/\bnvapi-[A-Za-z0-9_-]{10,}/g, '[redacted:nvidia-key]'],
  [/\bghp_[A-Za-z0-9]{20,}/g, '[redacted:github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted:github-token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[redacted:slack-token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted:aws-key-id]'],
  [/\bASIA[0-9A-Z]{16}\b/g, '[redacted:aws-key-id]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted:jwt]'],
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, '$1[redacted]$2'],
]

const KEYED = [
  // key = value / "key": "value" for anything that looks like a credential
  [/((?:api[_-]?key|apikey|secret|token|password|passwd|authorization|private[_-]?key)["']?\s*[:=]\s*)(["']?)([^\s"',;}]{6,})/gi, '$1$2[redacted]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/g, '$1[redacted]'],
]

export function redact(input) {
  if (input == null) return input
  let s = typeof input === 'string' ? input : String(input)
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep)
  for (const [re, rep] of KEYED) s = s.replace(re, rep)
  return s
}

/** Redact every string inside a JSON-ish value (used for events, config echoes, tool results). */
export function redactDeep(value) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) out[k] = '[redacted]'
      else out[k] = redactDeep(v)
    }
    return out
  }
  return value
}

export function isSecretKey(k) {
  return /^(api[_-]?key|apikey|secret|token|password|passwd|authorization|private[_-]?key|api_key_ref_value)$/i.test(k)
}

/** True when `text` still contains something that looks like a live credential (used by tests and doctor). */
export function looksSecret(text) {
  const probe = 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa nvapi-aaaaaaaaaaaa sk-or-v1-aaaaaaaaaaaaaaaa ghp_aaaaaaaaaaaaaaaaaaaa'
  const leaks = probe.split(' ').filter((p) => redact(`x ${p} y`) === `x ${p} y`)
  if (leaks.length) return true
  return typeof text === 'string' && redact(text) !== text
}
