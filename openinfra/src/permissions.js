/**
 * Permission rules, in the shape Claude Code uses so an existing `permissions.json` mostly just works:
 *
 *   { "deny": ["Bash(rm -rf:*)", "Read(./.env)"], "ask": [...], "allow": [...] }
 *
 * Precedence is deny > ask > allow, and a deny beats a narrower allow. That ordering is the whole contract:
 * without it, one broad allow silently punches a hole through every deny above it.
 */
import fs from 'node:fs'
import path from 'node:path'
import { classifyCommand, decide, higherTier } from './classify.js'
import { paths, workspacePaths } from './paths.js'

export const BUILTIN = Object.freeze({
  deny: [
    'Bash(rm -rf /:*)',
    'Bash(sudo:*)',
    'Bash(curl * | sh)',
    'Bash(curl * | bash)',
    'Bash(wget * | sh)',
    'Bash(mkfs:*)',
    'Bash(dd if=:*of=/dev/*)',
    'Bash(shutdown:*)',
    'Bash(reboot:*)',
    'Read(~/.ssh/id_*)',
    'Read(~/.aws/credentials)',
    'Read(~/.openinfra/secrets.json)',
    'Read(./.env)',
    'Read(./**/.env)',
    'Read(./.openinfra/secrets*)',
  ],
  ask: ['Bash(git push:*)'],
  allow: [],
})

const SECRET_PATH = /(^|\/)(\.env(\..*)?|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|credentials|\.netrc|\.pgpass|secrets\.(json|ya?ml|toml))$|\.pem$|\.p12$|\.pfx$/

export function globToRegex(glob) {
  let out = '^'
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(out + '$')
}

export function parseRule(rule) {
  const m = /^([A-Za-z_]+)\((.*)\)$/.exec(String(rule).trim())
  if (!m) return { tool: '*', pattern: String(rule), raw: rule }
  return { tool: m[1], pattern: m[2], raw: rule }
}

export function matchesRule(rule, subject) {
  const { tool, pattern } = parseRule(rule)
  if (tool !== '*' && tool.toLowerCase() !== String(subject.tool).toLowerCase()) {
    // Read/Write/Edit share the file matcher; Bash is its own thing
    const fileTools = ['read', 'write', 'edit', 'grep', 'glob']
    if (!(fileTools.includes(tool.toLowerCase()) && fileTools.includes(String(subject.tool).toLowerCase()))) return false
  }
  if (tool.toLowerCase() === 'bash') {
    const prefix = pattern.endsWith(':*') ? pattern.slice(0, -2) : pattern
    const cmd = String(subject.command || '')
    if (pattern.includes('*') && !pattern.endsWith(':*')) {
      return globToRegex(pattern.replace(/\s+/g, ' ')).test(cmd.replace(/\s+/g, ' '))
    }
    return cmd === prefix || cmd.startsWith(prefix + ' ') || cmd.startsWith(prefix)
  }
  const target = String(subject.path || subject.command || '')
  if (pattern.startsWith('./') || pattern.startsWith('~/')) {
    const norm = pattern.startsWith('~/') ? pattern.replace(/^~/, process.env.HOME || '~') : pattern.slice(2)
    const candidates = [target, path.resolve(target)]
    return candidates.some((c) => globToRegex(norm).test(c) || globToRegex(`**/${norm}`).test(c))
  }
  return globToRegex(pattern).test(target) || globToRegex(`**/${pattern}`).test(target)
}

export function loadRules({ home = paths.home, workspaceRoot = null } = {}) {
  const rules = { deny: [...BUILTIN.deny], ask: [...BUILTIN.ask], allow: [...BUILTIN.allow] }
  const files = [path.join(home, 'permissions.json')]
  if (workspaceRoot) files.push(path.join(workspacePaths(workspaceRoot).meta, 'permissions.json'))
  for (const f of files) {
    if (!fs.existsSync(f)) continue
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(f, 'utf8'))
    } catch (err) {
      throw new Error(`${f}: ${err.message}`)
    }
    for (const bucket of ['deny', 'ask', 'allow']) {
      if (Array.isArray(parsed[bucket])) rules[bucket].push(...parsed[bucket])
    }
  }
  return rules
}

/**
 * Decide a tool call. Returns { verdict, reason, rule?, tier }.
 * `ask` is a real answer: a non-interactive caller must refuse rather than assume yes.
 */
export function evaluate({ tool = 'Bash', command = null, path: target = null, mode = 'explore', rules = BUILTIN, workspace = null }) {
  const subject = { tool, command, path: target }
  const hit = (bucket) => (rules[bucket] || []).find((r) => matchesRule(r, subject))

  if (target && SECRET_PATH.test(String(target))) {
    return { verdict: 'deny', reason: 'secret file', rule: 'builtin:secret-file', tier: 'dangerous' }
  }

  const deny = hit('deny')
  if (deny) return { verdict: 'deny', reason: 'deny rule', rule: deny, tier: 'dangerous' }

  let tier = null
  if (tool.toLowerCase() === 'bash') {
    const c = classifyCommand(command || '', { workspace })
    tier = c.tier
    const askRule = hit('ask')
    if (askRule) return { verdict: 'ask', reason: 'ask rule', rule: askRule, tier }
    // A command that is dangerous by classification cannot be allowed by an allow rule.
    const allow = (rules.allow || []).find((r) => matchesRule(r, subject))
    if (allow) return { verdict: 'allow', reason: 'allow rule', rule: allow, tier }
    const d = decide(c.tier, { mode })
    return { verdict: d.verdict, reason: d.reason, tier: c.tier, classification: c }
  }

  const askRule = hit('ask')
  if (askRule) return { verdict: 'ask', reason: 'ask rule', rule: askRule, tier: 'read' }
  const allow = hit('allow')
  if (allow) return { verdict: 'allow', reason: 'allow rule', rule: allow, tier: 'read' }
  if (tool.toLowerCase() === 'write' || tool.toLowerCase() === 'edit') {
    return { verdict: mode === 'explore' ? 'deny' : 'allow', reason: `file writes are ${mode === 'explore' ? 'denied' : 'allowed'} in ${mode} mode`, tier: 'workspace-write' }
  }
  return { verdict: 'allow', reason: 'read-only tool', tier: 'read' }
}

export function explain(rules) {
  return { deny: rules.deny.length, ask: rules.ask.length, allow: rules.allow.length }
}
