/**
 * `oi doctor` answers one question honestly: what can this machine actually do right now?
 *
 * It never needs a network and never needs a provider key — a missing key is a finding, not a crash. Exit code is
 * 0 when everything required is fine, 8 when a toolchain is the problem, 9 when the workspace is.
 */
import fs from 'node:fs'
import path from 'node:path'
import { which } from './jobs.js'
import { readLock, verifyLock, toolEnv } from './toolchain.js'
import { loadConfig, modeSelection } from './config.js'
import { resolveSecret } from './secrets.js'
import { loadSchedule } from './scheduler.js'
import { loadIntent, loadPolicy } from './drift.js'
import { workspacePaths } from './paths.js'
import { EXIT } from './exit.js'
import { redact } from './redact.js'

export const TOOLS_OF_INTEREST = ['tofu', 'terraform', 'ansible', 'ansible-playbook', 'kubectl', 'helm', 'uv', 'python3', 'git', 'jq', 'rg', 'ssh']

export function doctor({ root = null, home = null, store = null, now = new Date() } = {}) {
  const checks = []
  const add = (id, status, detail, extra = {}) => checks.push({ id, status, detail, ...extra })

  // workspace
  let ws = null
  if (root) {
    ws = workspacePaths(root)
    const exists = fs.existsSync(ws.config)
    add('workspace', exists ? 'ok' : 'fail', exists ? root : `no .openinfra/config.toml at ${root}`)
  } else {
    add('workspace', 'warn', 'not in a workspace; run `oi workspace new <name>`')
  }

  // config
  let cfg = null
  try {
    const loaded = loadConfig({ workspaceRoot: root, home: home || undefined })
    cfg = loaded.config
    add('config', 'ok', loaded.sources.length ? `read ${loaded.sources.length} file(s)` : 'defaults')
  } catch (err) {
    add('config', 'fail', redact(err.message))
  }

  // providers
  const providers = cfg?.providers || {}
  const ids = Object.keys(providers).filter((k) => k !== 'default_provider')
  if (!ids.length) {
    add('providers', 'warn', 'none configured — the agent needs one; `oi providers add fake` works offline')
  } else {
    for (const id of ids) {
      const p = providers[id]
      const key = p.kind === 'fake' ? 'none needed' : resolveSecret(p.api_key_ref) ? 'present' : 'MISSING'
      add(`provider:${id}`, key === 'MISSING' ? 'fail' : 'ok', `${p.kind}${p.base_url ? ` ${p.base_url}` : ''}; key ${key}`, { provider: id })
    }
    const sel = modeSelection(cfg, cfg.agent?.mode || 'explore')
    add('agent.mode', sel.provider ? 'ok' : 'warn', `${sel.mode} → ${sel.provider || 'none'}/${sel.model || 'default'}`)
  }

  // toolchain
  if (root) {
    const lock = readLock(root)
    const verified = verifyLock(root)
    if (!lock.tools.length) add('toolchain', 'warn', 'no openinfra.lock yet; `oi tools install` then `oi tools lock`')
    else if (!verified.ok) add('toolchain', 'fail', verified.problems.map((p) => `${p.tool}: ${p.problem}`).join('; '))
    else add('toolchain', 'ok', `${lock.tools.length} pinned tool(s) present`)
  }
  const found = {}
  for (const t of TOOLS_OF_INTEREST) {
    const p = which(t)
    found[t] = p
    add(`tool:${t}`, p ? 'ok' : 'warn', p || 'not on PATH')
  }

  // schedule
  if (root) {
    const sched = loadSchedule(root)
    if (!sched.exists) add('schedule', 'warn', 'no .openinfra/schedule.toml')
    else if (sched.errors.length) add('schedule', 'fail', sched.errors.map((e) => e.message).join('; '))
    else add('schedule', 'ok', `${sched.jobs.filter((j) => j.enabled).length} enabled job(s) of ${sched.jobs.length}`)
  }

  // intent
  if (root) {
    const intent = loadIntent(root)
    if (!intent.files.length) add('intent', 'warn', 'no intent/*.toml; drift has nothing to compare against')
    else {
      const observed = path.join(workspacePaths(root).drift, 'observed.json')
      add('intent', 'ok', `${Object.keys(intent.objects).length} object(s) from ${intent.files.length} file(s)`)
      add('observed', fs.existsSync(observed) ? 'ok' : 'warn', fs.existsSync(observed) ? observed : 'no observation yet; drift will report everything as unknown')
      const policy = loadPolicy(root)
      add('drift-policy', fs.existsSync(policy.file) ? 'ok' : 'info', fs.existsSync(policy.file) ? policy.file : `defaults (fail on ${policy.failOn})`)
    }
  }

  // store
  if (store) {
    try {
      const runs = store.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n
      const stale = store.reconcileRuns()
      add('store', 'ok', `${runs} run record(s)${stale.length ? `, ${stale.length} reconciled` : ''}`)
    } catch (err) {
      add('store', 'fail', redact(err.message))
    }
  }

  const counts = { ok: 0, warn: 0, fail: 0, info: 0 }
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1
  const failed = checks.filter((c) => c.status === 'fail')
  let exitCode = EXIT.OK
  if (failed.some((c) => c.id.startsWith('workspace'))) exitCode = EXIT.WORKSPACE
  else if (failed.some((c) => c.id === 'toolchain' || c.id.startsWith('tool:'))) exitCode = EXIT.TOOLCHAIN
  else if (failed.length) exitCode = EXIT.ERROR

  return {
    ok: failed.length === 0,
    exitCode,
    workspace: root,
    home: home || undefined,
    generated_at: now.toISOString(),
    counts,
    checks,
    tools: found,
    env: root ? toolEnv(root) : { env: {}, path: [] },
    summary: failed.length ? `${failed.length} blocking problem(s)` : `${counts.warn} warning(s)`,
  }
}

export function renderDoctor(report, { color = true } = {}) {
  const mark = { ok: '[ok]  ', warn: '[warn]', fail: '[fail]', info: '[info]' }
  const paint = (s, c) => (color ? `\x1b[${c}m${s}\x1b[0m` : s)
  const lines = [`OpenInfra doctor — ${report.workspace || '(no workspace)'}`]
  for (const c of report.checks) {
    const m = mark[c.status] || '[????]'
    const colored = c.status === 'fail' ? paint(m, '31') : c.status === 'warn' ? paint(m, '33') : paint(m, '32')
    lines.push(`${colored} ${c.id.padEnd(22)} ${c.detail}`)
  }
  lines.push('')
  lines.push(`${report.counts.ok} ok, ${report.counts.warn} warn, ${report.counts.fail} fail — ${report.summary}`)
  return lines.join('\n')
}
