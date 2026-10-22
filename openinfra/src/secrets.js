/**
 * Where API keys live.
 *
 * Order of resolution for `keychain:openinfra/anthropic`:
 *   1. `OPENINFRA_KEY_ANTHROPIC` in the environment (opt-in only; never inherited by the agent's bash)
 *   2. the OS keychain via `security` (macOS) or `secret-tool` (Linux), when present
 *   3. `~/.openinfra/secrets.json`, mode 0600
 *
 * The value is never written to config, a transcript, an event or a log. Only a reference is.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { paths } from './paths.js'
import { OiError, EXIT } from './exit.js'

export function envNameFor(ref) {
  const account = ref.replace(/^keychain:/, '').split('/').pop()
  return `OPENINFRA_KEY_${account.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
}

export function readSecrets(file = paths.secrets) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw new OiError(`${file}: ${err.message}`, EXIT.USAGE)
  }
}

export async function writeSecret(ref, value, file = paths.secrets) {
  const all = readSecrets(file)
  all[ref.startsWith('keychain:') ? ref.slice(9) : ref] = value
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
  await fsp.rename(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* best effort on exotic filesystems */
  }
  return file
}

export async function deleteSecret(ref, file = paths.secrets) {
  const key = ref.startsWith('keychain:') ? ref.slice(9) : ref
  const all = readSecrets(file)
  if (!(key in all)) return false
  delete all[key]
  await fsp.writeFile(file, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 })
  return true
}

function keychainLookup(service, account) {
  if (process.platform === 'darwin') {
    const r = spawnSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
    })
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  }
  if (process.platform === 'linux') {
    const r = spawnSync('secret-tool', ['lookup', 'service', service, 'account', account], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  }
  return null
}

export function keychainStore(ref, value) {
  const [service, account] = ref.replace(/^keychain:/, '').split('/')
  if (!service || !account) return false
  if (process.platform === 'darwin') {
    const r = spawnSync('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value], {
      encoding: 'utf8',
    })
    return r.status === 0
  }
  if (process.platform === 'linux') {
    const r = spawnSync('secret-tool', ['store', '--label', `openinfra ${account}`, 'service', service, 'account', account], {
      input: value,
      encoding: 'utf8',
    })
    return r.status === 0
  }
  return false
}

/** Resolve a `keychain:`/`env:`/`file:` reference to the secret value, or null. */
export function resolveSecret(ref, { env = process.env, file = paths.secrets } = {}) {
  if (!ref || ref === 'none') return null
  if (ref.startsWith('env:')) return env[ref.slice(4)] || null
  if (ref.startsWith('file:')) {
    try {
      return fs.readFileSync(ref.slice(5), 'utf8').trim()
    } catch {
      return null
    }
  }
  if (!ref.startsWith('keychain:')) return ref // a literal key in config: allowed, warned about by doctor
  const envName = envNameFor(ref)
  if (env[envName]) return env[envName]
  const [service, account] = ref.slice(9).split('/')
  const fromChain = keychainLookup(service, account)
  if (fromChain) return fromChain
  const all = readSecrets(file)
  return all[`${service}/${account}`] || null
}

export function hasSecret(ref, opts) {
  return Boolean(resolveSecret(ref, opts))
}

export async function storeSecret(ref, value, file = paths.secrets) {
  if (ref.startsWith('keychain:') && keychainStore(ref, value)) return { stored: 'keychain' }
  await writeSecret(ref, value, file)
  return { stored: 'file', file }
}
