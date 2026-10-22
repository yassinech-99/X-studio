/**
 * The scheduler.
 *
 * `oi schedule tick` is stateless and idempotent: run it from systemd, cron, launchd or a Kubernetes CronJob as
 * often as you like. All the state that matters (when a job last ran, what it exited with) is in the store, and
 * overlap is decided by a lease file with an owner token — so two ticks one second apart cannot both start a job.
 *
 * Safety rules implemented here, not in documentation:
 *   - a scheduled *write* needs a standing approval that has not expired
 *   - the approval is re-checked against the plan hash at run time; a changed hash refuses the run (exit 7)
 *   - overlap is explicit: skip (default) | queue | replace
 *   - missed runs are explicit: skip (default) | once
 *   - every run is a run record with a journal, so "what happened at 03:00" is answerable
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseToml } from './toml.js'
import { workspacePaths, paths } from './paths.js'
import { parseCron, nextRun, occurrencesBetween, isValidTimezone } from './cron.js'
import { runCommand, baseEnv } from './jobs.js'
import { Journal } from './journal.js'
import { EXIT } from './exit.js'
import { toolEnv } from './toolchain.js'
import { redact } from './redact.js'
import { appendLine } from './fsutil.js'

export const JOB_KINDS = ['drift', 'bash', 'python', 'ansible', 'tofu']
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

export function scheduleFile(root) {
  return workspacePaths(root).schedule
}

export function loadSchedule(root) {
  const file = scheduleFile(root)
  if (!fs.existsSync(file)) return { file, exists: false, defaults: {}, jobs: [], errors: [] }
  let tree
  try {
    tree = parseToml(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return { file, exists: true, defaults: {}, jobs: [], errors: [{ job: null, message: err.message }] }
  }
  const defaults = tree.defaults || {}
  const jobs = (tree.job || []).map((j) => normalizeJob(j, defaults))
  const errors = validateSchedule({ defaults, jobs })
  return { file, exists: true, defaults, jobs, errors }
}

function normalizeJob(raw, defaults) {
  return {
    name: raw.name,
    kind: raw.kind,
    cron: raw.cron,
    enabled: raw.enabled !== false,
    timezone: raw.timezone || defaults.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    overlap: raw.overlap || defaults.overlap || 'skip',
    missed: raw.missed || defaults.missed || 'skip',
    timeout: raw.timeout || defaults.timeout || '30m',
    jitter_s: Number(raw.jitter_s ?? defaults.jitter_s ?? 0),
    notify: raw.notify || defaults.notify || [],
    fail_on: raw.fail_on || null,
    approval: raw.approval || null,
    // kind specific
    command: raw.command || null,
    script: raw.script || null,
    args: raw.args || [],
    playbook: raw.playbook || null,
    mode: raw.mode || 'check',
    limit: raw.limit || null,
    inventory: raw.inventory || null,
    dir: raw.dir || null,
    observed: raw.observed || null,
    sources: raw.sources || [],
    raw,
  }
}

export function validateSchedule({ jobs, defaults }) {
  const errors = []
  const seen = new Set()
  for (const j of jobs) {
    const where = j.name ? `job "${j.name}"` : 'job with no name'
    if (!j.name) errors.push({ job: null, message: 'a job needs a name' })
    else if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(j.name)) errors.push({ job: j.name, message: `${where}: name must be lowercase [a-z0-9_-]` })
    else if (seen.has(j.name)) errors.push({ job: j.name, message: `${where}: duplicate name` })
    seen.add(j.name)
    if (!JOB_KINDS.includes(j.kind)) errors.push({ job: j.name, message: `${where}: kind must be one of ${JOB_KINDS.join(', ')}` })
    try {
      parseCron(j.cron)
    } catch (err) {
      errors.push({ job: j.name, message: `${where}: ${err.message}` })
    }
    if (!isValidTimezone(j.timezone)) errors.push({ job: j.name, message: `${where}: unknown timezone ${j.timezone}` })
    if (!['skip', 'queue', 'replace'].includes(j.overlap)) errors.push({ job: j.name, message: `${where}: overlap must be skip|queue|replace` })
    if (!['skip', 'once'].includes(j.missed)) errors.push({ job: j.name, message: `${where}: missed must be skip|once` })
    if (!parseDuration(j.timeout)) errors.push({ job: j.name, message: `${where}: timeout "${j.timeout}" is not a duration (30s, 10m, 2h)` })
    if (j.kind === 'bash' && !j.command) errors.push({ job: j.name, message: `${where}: bash jobs need command` })
    if (j.kind === 'python' && !j.script) errors.push({ job: j.name, message: `${where}: python jobs need script` })
    if (j.kind === 'ansible' && !j.playbook) errors.push({ job: j.name, message: `${where}: ansible jobs need playbook` })
    if (j.kind === 'tofu' && !j.command) errors.push({ job: j.name, message: `${where}: tofu jobs need command (eg. plan -detailed-exitcode)` })
    if (isWriteJob(j) && !j.approval) {
      errors.push({
        job: j.name,
        message: `${where}: this job changes infrastructure, so it needs approval = "standing:<change-id>" (see docs/phased.md 10.2)`,
      })
    }
  }
  if (defaults?.timezone && !isValidTimezone(defaults.timezone)) errors.push({ job: null, message: `defaults.timezone is unknown: ${defaults.timezone}` })
  return errors
}

export function isWriteJob(job) {
  if (job.kind === 'ansible') return job.mode !== 'check'
  if (job.kind === 'tofu') return /(^|\s)(apply|destroy|import|taint)(\s|$)/.test(job.command || '')
  return false
}

export function parseDuration(text) {
  const m = /^(\d+)(s|m|h|d)?$/.exec(String(text ?? '').trim())
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2] || 's'
  return n * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]
}

// ---- leases --------------------------------------------------------------------------------------------------

export function leasePath(root, jobName) {
  const id = crypto.createHash('sha256').update(root).digest('hex').slice(0, 12)
  return path.join(paths.leases, `${id}-${jobName}.lock`)
}

export function acquireLease(file, { ttlMs = DEFAULT_TIMEOUT_MS + 60_000, now = Date.now(), owner = `${process.pid}` } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const token = `${owner}-${crypto.randomUUID()}`
  const body = JSON.stringify({ token, pid: process.pid, acquired_at: new Date(now).toISOString(), ttl_ms: ttlMs })
  try {
    const fd = fs.openSync(file, 'wx')
    fs.writeSync(fd, body)
    fs.closeSync(fd)
    return { token, file, release: () => releaseLease(file, token) }
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
  // stale?
  let held = null
  try {
    held = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    held = null
  }
  const stale = !held || now - Date.parse(held.acquired_at) > (held.ttl_ms || ttlMs) || !isPidAlive(held.pid)
  if (stale) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* someone else won */
    }
    return acquireLease(file, { ttlMs, now, owner })
  }
  return { token: null, file, held, release: () => {} }
}

export function releaseLease(file, token) {
  try {
    const held = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (held.token === token) fs.unlinkSync(file)
    return held.token === token
  } catch {
    return false
  }
}

export function leaseHeld(file, now = Date.now()) {
  try {
    const held = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (now - Date.parse(held.acquired_at) > (held.ttl_ms || DEFAULT_TIMEOUT_MS)) return null
    if (!isPidAlive(held.pid)) return null
    return held
  } catch {
    return null
  }
}

function isPidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// ---- approvals ----------------------------------------------------------------------------------------------

export function approvalFile(root, id) {
  return path.join(workspacePaths(root).meta, 'approvals', `${id}.json`)
}

export function loadStandingApproval(root, ref, now = Date.now()) {
  const id = String(ref || '').replace(/^standing:/, '')
  if (!id) return { ok: false, reason: 'no approval id' }
  const file = approvalFile(root, id)
  if (!fs.existsSync(file)) return { ok: false, reason: `approval ${id} not found at ${file}` }
  let rec
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    return { ok: false, reason: `approval ${id} is unreadable: ${err.message}` }
  }
  if (rec.revoked) return { ok: false, reason: `approval ${id} was revoked` }
  if (rec.expires && Date.parse(rec.expires) < now) return { ok: false, reason: `approval ${id} expired at ${rec.expires}` }
  return { ok: true, id, record: rec }
}

/** A scheduled write must match the approved plan hash, or it does not run. */
export function approvalMatchesPlan(approval, planHash) {
  if (!approval?.ok) return { ok: false, reason: approval?.reason || 'no approval' }
  if (!approval.record.plan_hash) return { ok: false, reason: 'approval has no plan hash; standing approvals must pin one' }
  if (approval.record.plan_hash !== planHash) {
    return { ok: false, reason: `plan changed since approval (approved ${approval.record.plan_hash.slice(0, 12)}, now ${String(planHash).slice(0, 12)})`, changed: true }
  }
  return { ok: true }
}

// ---- running a job -------------------------------------------------------------------------------------------

export function newRunId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `run_${stamp}_${crypto.randomBytes(3).toString('hex')}`
}

export async function runJob({ job, root, store, now = new Date(), runId = null, dryRun = false, workspaceId = null }) {
  const id = runId || newRunId(now)
  const ws = workspacePaths(root)
  const dir = path.join(ws.runs, id)
  const journal = new Journal({ runId: id, dir, store })
  const workspace = workspaceId || root
  const timeoutMs = parseDuration(job.timeout) || DEFAULT_TIMEOUT_MS
  const started = Date.now()

  // Scheduled writes: approval first, before anything spawns.
  if (isWriteJob(job)) {
    const approval = loadStandingApproval(root, job.approval, now.getTime())
    if (!approval.ok) {
      journal.write('job.refused', { reason: approval.reason, approval: job.approval })
      store?.createRun({ id, workspace, name: job.name, kind: job.kind, status: 'refused', job: job.name, meta: { reason: approval.reason } })
      store?.finishRun(id, { status: 'refused', exitCode: EXIT.UNAPPROVED, reason: approval.reason })
      return { id, ok: false, exitCode: EXIT.UNAPPROVED, status: 'refused', reason: approval.reason, durationMs: 0 }
    }
    const planHash = job.raw?.plan_hash || approval.record.plan_hash
    const match = approvalMatchesPlan(approval, planHash)
    if (!match.ok) {
      journal.write('job.refused', { reason: match.reason, approval: job.approval })
      store?.createRun({ id, workspace, name: job.name, kind: job.kind, status: 'refused', job: job.name, meta: { reason: match.reason } })
      store?.finishRun(id, { status: 'refused', exitCode: EXIT.HASH_MISMATCH, reason: match.reason })
      return { id, ok: false, exitCode: EXIT.HASH_MISMATCH, status: 'refused', reason: match.reason, durationMs: 0 }
    }
    journal.write('job.approval', { approval: approval.id, plan_hash: planHash })
  }

  if (dryRun) {
    return { id, ok: true, dryRun: true, exitCode: 0, status: 'dry-run', command: describeJob(job), durationMs: 0 }
  }

  store?.createRun({ id, workspace, name: job.name, kind: job.kind, status: 'running', job: job.name, meta: { cron: job.cron, timezone: job.timezone } })
  journal.start({ job: job.name, kind: job.kind, cron: job.cron, timezone: job.timezone, timeout: job.timeout })

  let result
  try {
    result = await executeJob({ job, root, journal, timeoutMs, runId: id, store, now })
  } catch (err) {
    journal.write('job.error', { error: redact(err.message) })
    result = { ok: false, exitCode: EXIT.ERROR, status: 'failed', error: redact(err.message), summary: redact(err.message) }
  }

  const durationMs = Date.now() - started
  const status = result.status || (result.ok ? 'success' : 'failed')
  journal.finish(status, result.exitCode, { durationMs, summary: result.summary || null })
  store?.finishRun(id, { status, exitCode: result.exitCode, reason: result.reason || null })
  const message = notifyMessage(job, status, result, durationMs)
  if (status !== 'success' && job.notify?.length) await deliver(job.notify, message)
  return { id, durationMs, ...result, status, notified: job.notify || [] }
}

function describeJob(job) {
  switch (job.kind) {
    case 'bash':
      return job.command
    case 'python':
      return `python3 ${job.script} ${(job.args || []).join(' ')}`.trim()
    case 'ansible':
      return `ansible-playbook ${job.mode === 'apply' ? '' : '--check --diff '}-i ${job.inventory || 'inventory'} ${job.playbook}${job.limit ? ` --limit ${job.limit}` : ''}`
    case 'tofu':
      return `tofu ${job.command}${job.dir ? `  (in ${job.dir})` : ''}`
    case 'drift':
      return `oi drift check${job.observed ? ` --observed ${job.observed}` : ''}`
    default:
      return job.kind
  }
}

async function executeJob({ job, root, journal, timeoutMs, runId, store, now }) {
  const { path: extraPath } = toolEnv(root)
  const env = { ...baseEnv({ workspace: root, extraPath, tz: job.timezone }) }

  if (job.kind === 'drift') {
    const { checkDrift } = await import('./drift.js')
    const report = checkDrift({ root, store, runId, observed: job.observed ? path.resolve(root, job.observed) : null })
    journal.write('drift.result', { summary: report.summary, coverage: report.coverage, drift: report.drift, transitions: report.transitions })
    if (!report.ok) return { ok: false, exitCode: EXIT.NOTFOUND, status: 'failed', summary: report.reason || 'no intent' }
    return {
      ok: !report.drift,
      exitCode: report.drift ? EXIT.DRIFT : EXIT.OK,
      status: report.drift ? 'drift' : 'success',
      summary: `${report.summary.total} finding(s): ${JSON.stringify(report.summary.bySeverity)}; transitions ${JSON.stringify(report.transitions)}`,
      drift: true,
      artifacts: [],
    }
  }

  let command
  let args
  let cwd = root
  if (job.kind === 'bash') {
    command = job.command
    args = []
  } else if (job.kind === 'python') {
    command = 'python3'
    args = [path.resolve(root, job.script), ...(job.args || [])]
  } else if (job.kind === 'ansible') {
    command = 'ansible-playbook'
    args = [...(job.mode === 'apply' ? [] : ['--check', '--diff']), '-i', job.inventory || 'inventory', path.resolve(root, job.playbook)]
    if (job.limit) args.push('--limit', job.limit)
    if (job.args?.length) args.push(...job.args)
  } else if (job.kind === 'tofu') {
    command = 'tofu'
    args = String(job.command).match(/(?:[^\s"']+|"[^"]*")+/g) || []
    if (job.dir) cwd = path.resolve(root, job.dir)
  } else {
    return { ok: false, exitCode: EXIT.USAGE, status: 'failed', summary: `unknown job kind ${job.kind}` }
  }

  journal.write('job.exec', { command, args, cwd })
  const res = await runCommand({
    command,
    args,
    cwd,
    env,
    timeoutMs,
    shell: job.kind === 'bash' ? '/bin/bash' : false,
    runId,
  })
  journal.write('job.output', {
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    durationMs: res.durationMs,
    stdout: res.stdout.text.slice(0, 2000),
    stderr: res.stderr.text.slice(0, 2000),
    artifacts: [res.stdout.artifact, res.stderr.artifact].filter(Boolean),
  })
  if (res.missing) {
    return { ok: false, exitCode: EXIT.TOOLCHAIN, status: 'tool-missing', summary: `${command} is not installed — run \`oi tools install\`` }
  }
  if (res.timedOut) {
    return { ok: false, exitCode: EXIT.ERROR, status: 'timeout', summary: `timed out after ${job.timeout}` }
  }
  // `tofu plan -detailed-exitcode`: 0 = no changes, 2 = changes (drift), 1 = error
  if (job.kind === 'tofu' && /-detailed-exitcode/.test(job.command)) {
    if (res.exitCode === 2) return { ok: false, exitCode: EXIT.DRIFT, status: 'drift', summary: 'plan has changes', planned: true }
    if (res.exitCode === 0) return { ok: true, exitCode: 0, status: 'success', summary: 'no changes' }
  }
  return {
    ok: res.exitCode === 0,
    exitCode: res.exitCode === 0 ? 0 : EXIT.ERROR,
    status: res.exitCode === 0 ? 'success' : 'failed',
    summary: redact(res.stderr.text.trim().split('\n').slice(-3).join(' | ')) || `exit ${res.exitCode}`,
    exit_code: res.exitCode,
  }
}

function notifyMessage(job, status, result, durationMs) {
  const icon = status === 'success' ? 'ok' : status === 'drift' ? 'drift' : status === 'refused' ? 'refused' : 'FAILED'
  return `[openinfra] ${job.name} ${icon}${result.summary ? ` — ${result.summary}` : ''} (${Math.round(durationMs / 1000)}s)`
}

async function deliver(targets, message) {
  for (const t of targets) {
    if (String(t).startsWith('file:')) await appendLine(String(t).slice(5), JSON.stringify({ ts: new Date().toISOString(), message }))
    else await appendLine(path.join(paths.home, 'notifications.ndjson'), JSON.stringify({ ts: new Date().toISOString(), target: t, message }))
  }
}

// ---- tick ---------------------------------------------------------------------------------------------------

/**
 * One tick. Returns what ran, what was skipped and why. `now` is injectable so a week of scheduling can be
 * tested in a millisecond.
 */
export async function tick({ root, store, now = new Date(), only = null, dryRun = false, workspaceId = null, jitterFor = defaultJitter }) {
  const sched = loadSchedule(root)
  if (!sched.exists) return { ok: false, reason: `no schedule at ${sched.file}`, runs: [], skipped: [] }
  if (sched.errors.length) return { ok: false, reason: 'schedule has errors', errors: sched.errors, runs: [], skipped: [] }

  const workspace = workspaceId || root
  const nowMs = now.getTime()
  const runs = []
  const skipped = []

  for (const job of sched.jobs) {
    if (only && job.name !== only) continue
    if (!job.enabled) {
      skipped.push({ job: job.name, reason: 'disabled' })
      continue
    }
    const parsed = parseCron(job.cron)
    const state = store?.scheduleState(workspace, job.name) || null
    // No prior state means "we just started watching": only an occurrence in the last minute is due. A fresh
    // install must never fire a week of backfill.
    const watermark = state?.last_tick || new Date(nowMs - 60_000).toISOString()
    const due = occurrencesBetween(parsed, watermark, now.toISOString(), job.timezone, { limit: 100 })
    if (!due.length) {
      store?.saveScheduleState({ workspace, job: job.name, lastTick: now.toISOString() })
      skipped.push({ job: job.name, reason: 'not due', next: nextRun(parsed, now, job.timezone)?.toISOString() || null })
      continue
    }

    const latest = due[due.length - 1]
    const jitter = jitterFor(job)
    if (nowMs < latest.getTime() + jitter) {
      skipped.push({ job: job.name, reason: 'jitter', due: latest.toISOString(), jitter_s: Math.round(jitter / 1000) })
      store?.saveScheduleState({ workspace, job: job.name, lastTick: now.toISOString() })
      continue
    }

    const missed = due.length > 1
    if (missed && job.missed === 'skip') {
      // "skip" means skip. No makeup run, no queue of stale firings — the next scheduled occurrence is the one
      // that counts. A tick that was late by a whole window is exactly the case this exists for.
      store?.saveScheduleState({ workspace, job: job.name, lastTick: now.toISOString(), lastDue: latest.toISOString(), lastStatus: 'skipped-missed' })
      skipped.push({ job: job.name, reason: 'missed', occurrences: due.length })
      continue
    }

    const lease = acquireLease(leasePath(root, job.name), { ttlMs: (parseDuration(job.timeout) || DEFAULT_TIMEOUT_MS) + 60_000, now: nowMs })
    if (!lease.token) {
      if (job.overlap === 'replace') {
        try {
          fs.unlinkSync(leasePath(root, job.name))
        } catch {
          /* gone already */
        }
        const retry = acquireLease(leasePath(root, job.name), { ttlMs: (parseDuration(job.timeout) || DEFAULT_TIMEOUT_MS) + 60_000, now: nowMs })
        if (!retry.token) {
          skipped.push({ job: job.name, reason: 'overlap' })
          continue
        }
        return finishRun({ retry, job, root, store, now, workspace, runs, skipped, dryRun, due: latest, missed, workspaceId: workspace })
      }
      if (job.overlap === 'queue') {
        skipped.push({ job: job.name, reason: 'overlap-queued' })
        continue
      }
      skipped.push({ job: job.name, reason: 'overlap', held_by: lease.held?.pid ?? null })
      continue
    }
    await finishRun({ retry: lease, job, root, store, now, workspace, runs, skipped, dryRun, due: latest, missed, workspaceId: workspace })
  }

  return { ok: true, file: sched.file, jobs: sched.jobs.length, ran: runs.length, skipped, runs }
}

async function finishRun({ retry, job, root, store, now, workspace, runs, skipped, dryRun, due, missed, workspaceId }) {
  try {
    const result = await runJob({ job, root, store, now, dryRun, workspaceId })
    runs.push({ job: job.name, ...result, due: due.toISOString(), missed })
    store?.saveScheduleState({
      workspace,
      job: job.name,
      lastTick: now.toISOString(),
      lastDue: due.toISOString(),
      lastRun: new Date().toISOString(),
      lastStatus: result.status,
      lastExit: result.exitCode,
      lastDurationMs: result.durationMs,
    })
    if (missed) await appendLine(path.join(paths.home, 'scheduler.ndjson'), JSON.stringify({ ts: new Date().toISOString(), job: job.name, event: 'missed-consolidated', occurrences: missed }))
  } finally {
    retry.release()
  }
}

function defaultJitter(job) {
  if (!job.jitter_s) return 0
  const h = crypto.createHash('sha256').update(job.name).digest()[0]
  return (h / 255) * job.jitter_s * 1000
}

export function nextRuns(sched, now = new Date(), limit = 5) {
  const out = []
  for (const job of sched.jobs) {
    if (!job.enabled) continue
    const parsed = parseCron(job.cron)
    const next = nextRun(parsed, now, job.timezone)
    out.push({ job: job.name, kind: job.kind, cron: job.cron, timezone: job.timezone, next: next?.toISOString() || null, human: next ? describeWhen(next, now) : null })
  }
  return out.sort((a, b) => String(a.next).localeCompare(String(b.next)))
}

function describeWhen(when, now) {
  const ms = when.getTime() - now.getTime()
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `in ${mins}m`
  if (mins < 48 * 60) return `in ${Math.round(mins / 60)}h`
  return `in ${Math.round(mins / 1440)}d`
}

// ---- exporters ----------------------------------------------------------------------------------------------

export function exportSchedule({ root, format = 'systemd', sched = null, oiPath = null }) {
  const s = sched || loadSchedule(root)
  if (!s.jobs.length) throw new Error('no jobs to export')
  const bin = oiPath || 'oi'
  if (format === 'systemd') {
    const lines = []
    for (const job of s.jobs) {
      lines.push(`# ${job.name} — ${job.kind}, ${job.cron} (${job.timezone})`)
      lines.push(`# install: systemctl --user link \$PWD/openinfra-${job.name}.{service,timer}`)
      lines.push('')
    }
    // One timer calling tick every minute is the correct shape: job schedules live in schedule.toml, not in units.
    lines.push('[Unit]', 'Description=OpenInfra scheduler tick', '', '[Service]', 'Type=oneshot', `ExecStart=${bin} schedule tick --workspace ${root}`, '')
    lines.push('[Unit]', 'Description=OpenInfra scheduler tick (every minute)', '', '[Timer]', 'OnCalendar=*-*-* *:*:00', 'AccuracySec=10s', 'Persistent=true', '', '[Install]', 'WantedBy=timers.target')
    return { format, files: { 'openinfra-tick.service': true }, content: lines.join('\n') + '\n' }
  }
  if (format === 'cron') {
    const lines = [
      '# openinfra: one line, one lock, all schedules live in schedule.toml.',
      '# flock stops overlapping ticks at the cron level; tick also takes a per-job lease.',
      `* * * * * flock -n ${root}/.openinfra/tick.lock ${bin} schedule tick --workspace ${root} >> ${root}/.openinfra/tick.log 2>&1`,
    ]
    return { format, content: lines.join('\n') + '\n' }
  }
  if (format === 'launchd') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.openinfra.tick</string>
  <key>ProgramArguments</key><array><string>${bin}</string><string>schedule</string><string>tick</string><string>--workspace</string><string>${root}</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>${root}/.openinfra/tick.log</string>
</dict></plist>
`
    return { format, content: plist }
  }
  if (format === 'k8s') {
    const content = `apiVersion: batch/v1
kind: CronJob
metadata:
  name: openinfra-tick
spec:
  schedule: "* * * * *"
  concurrencyPolicy: Forbid
  startingDeadlineSeconds: 55
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      activeDeadlineSeconds: 300
      backoffLimit: 0
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: oi
              image: ghcr.io/openinfra/oi:0.1.0
              args: ["schedule", "tick", "--workspace", "/workspace"]
              volumeMounts:
                - { name: ws, mountPath: /workspace }
          volumes:
            - name: ws
              persistentVolumeClaim: { claimName: openinfra-workspace }
`
    return { format, content }
  }
  throw new Error(`unknown format ${format}; use systemd|cron|launchd|k8s`)
}
