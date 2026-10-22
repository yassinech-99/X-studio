/**
 * The local store. SQLite in WAL mode, synchronous API, one file per machine at ~/.openinfra/openinfra.db.
 * It holds run records, drift findings and their transitions, schedule state, provider capability probes and
 * cost ledger entries. Big payloads never go in here — they are artifacts, referenced by sha256.
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from './sqlite.js'
import { redactDeep } from './redact.js'
import { paths } from './paths.js'

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS runs (
     id TEXT PRIMARY KEY,
     workspace TEXT,
     name TEXT,
     kind TEXT NOT NULL,
     status TEXT NOT NULL,
     exit_code INTEGER,
     started_at TEXT NOT NULL,
     ended_at TEXT,
     job TEXT,
     pid INTEGER,
     reason TEXT,
     meta TEXT
   );
   CREATE INDEX IF NOT EXISTS runs_ws ON runs(workspace, started_at DESC);
   CREATE TABLE IF NOT EXISTS events (
     run_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     ts TEXT NOT NULL,
     type TEXT NOT NULL,
     payload TEXT,
     PRIMARY KEY (run_id, seq)
   );
   CREATE TABLE IF NOT EXISTS findings (
     id TEXT PRIMARY KEY,
     workspace TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     category TEXT NOT NULL,
     severity TEXT NOT NULL,
     title TEXT NOT NULL,
     detail TEXT,
     source TEXT,
     target TEXT,
     first_seen TEXT NOT NULL,
     last_seen TEXT NOT NULL,
     occurrences INTEGER NOT NULL DEFAULT 1,
     status TEXT NOT NULL DEFAULT 'open',
     muted_reason TEXT,
     evidence TEXT,
     UNIQUE (workspace, fingerprint)
   );
   CREATE TABLE IF NOT EXISTS transitions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     workspace TEXT NOT NULL,
     fingerprint TEXT NOT NULL,
     kind TEXT NOT NULL,
     severity TEXT,
     at TEXT NOT NULL,
     run_id TEXT,
     detail TEXT
   );
   CREATE INDEX IF NOT EXISTS transitions_ws ON transitions(workspace, at DESC);
   CREATE TABLE IF NOT EXISTS schedule_state (
     workspace TEXT NOT NULL,
     job TEXT NOT NULL,
     last_tick TEXT,
     last_due TEXT,
     last_run TEXT,
     last_status TEXT,
     last_exit INTEGER,
     last_duration_ms INTEGER,
     PRIMARY KEY (workspace, job)
   );
   CREATE TABLE IF NOT EXISTS provider_probes (
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     capability TEXT NOT NULL,
     probed_at TEXT NOT NULL,
     PRIMARY KEY (provider, model)
   );
   CREATE TABLE IF NOT EXISTS cost (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     workspace TEXT,
     run_id TEXT,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     input_tokens INTEGER NOT NULL DEFAULT 0,
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL,
     meta TEXT
   );
   CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     workspace TEXT,
     provider TEXT,
     model TEXT,
     mode TEXT,
     started_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     steps INTEGER NOT NULL DEFAULT 0,
     title TEXT
   );`,
]

export class Store {
  constructor(file = paths.db) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  migrate() {
    const version = this.db.prepare('PRAGMA user_version').get().user_version || 0
    if (version < MIGRATIONS.length) {
      for (let i = version; i < MIGRATIONS.length; i++) this.db.exec(MIGRATIONS[i])
      this.db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`)
    }
    return Number(this.db.prepare('PRAGMA user_version').get().user_version)
  }

  close() {
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }

  // ---- runs ----------------------------------------------------------------------------------------------------
  createRun({ id, workspace = null, name = null, kind, status = 'running', job = null, pid = process.pid, meta = null }) {
    this.db
      .prepare(
        `INSERT INTO runs (id, workspace, name, kind, status, started_at, job, pid, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, workspace, name, kind, status, nowIso(), job, pid, meta == null ? null : JSON.stringify(meta))
    return id
  }

  finishRun(id, { status, exitCode = 0, reason = null }) {
    this.db
      .prepare('UPDATE runs SET status = ?, exit_code = ?, ended_at = ?, reason = ? WHERE id = ?')
      .run(status, exitCode, nowIso(), reason, id)
  }

  getRun(id) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id)
    if (!row) return null
    return { ...row, meta: row.meta ? JSON.parse(row.meta) : null }
  }

  listRuns({ workspace = null, limit = 20, kind = null } = {}) {
    let sql = 'SELECT * FROM runs'
    const where = []
    const params = []
    if (workspace) {
      where.push('workspace = ?')
      params.push(workspace)
    }
    if (kind) {
      where.push('kind = ?')
      params.push(kind)
    }
    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' ORDER BY started_at DESC LIMIT ?'
    params.push(limit)
    return this.db.prepare(sql).all(...params).map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }))
  }

  /** Runs left 'running' by a process that died. Called at startup; never guesses, only reports. */
  reconcileRuns({ alive = (pid) => isAlive(pid) } = {}) {
    const rows = this.db.prepare("SELECT id, pid FROM runs WHERE status = 'running'").all()
    const stale = []
    for (const r of rows) {
      if (r.pid && alive(r.pid)) continue
      this.db.prepare("UPDATE runs SET status = 'interrupted', ended_at = ?, reason = 'process exited' WHERE id = ?").run(nowIso(), r.id)
      stale.push(r.id)
    }
    return stale
  }

  appendEvent(runId, type, payload = null) {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?').get(runId)
    const seq = Number(row.seq) + 1
    this.db.prepare('INSERT INTO events (run_id, seq, ts, type, payload) VALUES (?, ?, ?, ?, ?)').run(
      runId,
      seq,
      nowIso(),
      type,
      payload == null ? null : JSON.stringify(redactDeep(payload)),
    )
    return seq
  }

  events(runId, { after = 0 } = {}) {
    return this.db
      .prepare('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq')
      .all(runId, after)
      .map((e) => ({ ...e, payload: e.payload ? JSON.parse(e.payload) : null }))
  }

  // ---- drift ---------------------------------------------------------------------------------------------------
  /**
   * Record a finding. Returns { kind: 'new'|'changed'|'open', finding } and appends a transition when the state
   * actually moved — that transition is what notifications fire on.
   */
  upsertFinding({ workspace, fingerprint, category, severity, title, detail = null, source = null, target = null, evidence = null, runId = null }) {
    const ts = nowIso()
    const existing = this.db
      .prepare('SELECT * FROM findings WHERE workspace = ? AND fingerprint = ?')
      .get(workspace, fingerprint)
    if (!existing) {
      const id = `fnd_${fingerprint.slice(0, 12)}`
      this.db
        .prepare(
          `INSERT INTO findings (id, workspace, fingerprint, category, severity, title, detail, source, target, first_seen, last_seen, occurrences, status, evidence)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'open', ?)`,
        )
        .run(id, workspace, fingerprint, category, severity, title, detail, source, target, ts, ts, evidence)
      this.addTransition({ workspace, fingerprint, kind: 'new', severity, at: ts, runId })
      return { kind: 'new', finding: this.getFinding(workspace, fingerprint) }
    }
    if (existing.status !== 'open') {
      // it came back: that is news, not a quiet reopen
      this.db
        .prepare("UPDATE findings SET status = 'open', muted_reason = NULL, last_seen = ?, severity = ?, title = ?, detail = ?, source = ?, target = ?, evidence = ? WHERE id = ?")
        .run(ts, severity, title, detail, source, target, evidence, existing.id)
      this.addTransition({ workspace, fingerprint, kind: 'new', severity, at: ts, runId, detail: `reopened (was ${existing.status})` })
      return { kind: 'new', finding: this.getFinding(workspace, fingerprint), reopened: true }
    }
    const changed = existing.severity !== severity || existing.detail !== detail
    this.db
      .prepare(
        `UPDATE findings SET last_seen = ?, occurrences = occurrences + 1, severity = ?, title = ?, detail = ?, source = ?, target = ?, evidence = ?
         WHERE id = ?`,
      )
      .run(ts, severity, title, detail, source, target, evidence, existing.id)
    if (changed) {
      this.addTransition({ workspace, fingerprint, kind: 'changed', severity, at: ts, runId, detail })
      return { kind: 'changed', finding: this.getFinding(workspace, fingerprint) }
    }
    return { kind: 'open', finding: this.getFinding(workspace, fingerprint) }
  }

  addTransition({ workspace, fingerprint, kind, severity = null, at = nowIso(), runId = null, detail = null }) {
    this.db
      .prepare('INSERT INTO transitions (workspace, fingerprint, kind, severity, at, run_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(workspace, fingerprint, kind, severity, at, runId, detail)
  }

  getFinding(workspace, fingerprint) {
    return this.db.prepare('SELECT * FROM findings WHERE workspace = ? AND fingerprint = ?').get(workspace, fingerprint) || null
  }

  listFindings({ workspace, status = 'open', severity = null, limit = 100 } = {}) {
    let sql = 'SELECT * FROM findings WHERE workspace = ?'
    const params = [workspace]
    if (status) {
      sql += ' AND status = ?'
      params.push(status)
    }
    if (severity) {
      sql += ' AND severity = ?'
      params.push(severity)
    }
    sql += " ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, last_seen DESC LIMIT ?"
    params.push(limit)
    return this.db.prepare(sql).all(...params)
  }

  /** Findings seen before the current run but absent now are resolved — one transition each, then closed. */
  resolveMissing({ workspace, seenFingerprints, runId = null }) {
    const open = this.db.prepare("SELECT fingerprint, severity FROM findings WHERE workspace = ? AND status = 'open'").all(workspace)
    const resolved = []
    for (const f of open) {
      if (seenFingerprints.has(f.fingerprint)) continue
      this.db.prepare("UPDATE findings SET status = 'resolved' WHERE workspace = ? AND fingerprint = ?").run(workspace, f.fingerprint)
      this.addTransition({ workspace, fingerprint: f.fingerprint, kind: 'resolved', severity: f.severity, runId })
      resolved.push(f.fingerprint)
    }
    return resolved
  }

  muteFinding({ workspace, fingerprint, reason }) {
    return this.db
      .prepare("UPDATE findings SET muted_reason = ?, status = CASE WHEN ? IS NULL THEN status ELSE 'muted' END WHERE workspace = ? AND fingerprint = ?")
      .run(reason, reason, workspace, fingerprint).changes
  }

  transitions({ workspace, limit = 50 }) {
    return this.db.prepare('SELECT * FROM transitions WHERE workspace = ? ORDER BY at DESC, id DESC LIMIT ?').all(workspace, limit)
  }

  // ---- schedules -----------------------------------------------------------------------------------------------
  scheduleState(workspace, job) {
    return this.db.prepare('SELECT * FROM schedule_state WHERE workspace = ? AND job = ?').get(workspace, job) || null
  }

  saveScheduleState({ workspace, job, lastTick, lastDue, lastRun, lastStatus, lastExit, lastDurationMs }) {
    this.db
      .prepare(
        `INSERT INTO schedule_state (workspace, job, last_tick, last_due, last_run, last_status, last_exit, last_duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace, job) DO UPDATE SET
           last_tick = COALESCE(excluded.last_tick, schedule_state.last_tick),
           last_due = COALESCE(excluded.last_due, schedule_state.last_due),
           last_run = COALESCE(excluded.last_run, schedule_state.last_run),
           last_status = COALESCE(excluded.last_status, schedule_state.last_status),
           last_exit = COALESCE(excluded.last_exit, schedule_state.last_exit),
           last_duration_ms = COALESCE(excluded.last_duration_ms, schedule_state.last_duration_ms)`,
      )
      .run(workspace, job, lastTick ?? null, lastDue ?? null, lastRun ?? null, lastStatus ?? null, lastExit ?? null, lastDurationMs ?? null)
  }

  allScheduleStates(workspace) {
    return this.db.prepare('SELECT * FROM schedule_state WHERE workspace = ?').all(workspace)
  }

  // ---- providers and cost --------------------------------------------------------------------------------------
  saveProbe(provider, model, capability) {
    this.db
      .prepare(
        `INSERT INTO provider_probes (provider, model, capability, probed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (provider, model) DO UPDATE SET capability = excluded.capability, probed_at = excluded.probed_at`,
      )
      .run(provider, model, JSON.stringify(capability), nowIso())
  }

  probe(provider, model) {
    const row = this.db.prepare('SELECT * FROM provider_probes WHERE provider = ? AND model = ?').get(provider, model)
    return row ? { ...row, capability: JSON.parse(row.capability) } : null
  }

  recordCost({ workspace = null, runId = null, provider, model, inputTokens = 0, outputTokens = 0, costUsd = null, meta = null }) {
    this.db
      .prepare(
        'INSERT INTO cost (at, workspace, run_id, provider, model, input_tokens, output_tokens, cost_usd, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(nowIso(), workspace, runId, provider, model, inputTokens, outputTokens, costUsd, meta ? JSON.stringify(meta) : null)
  }

  costSummary({ workspace = null, since = null } = {}) {
    const where = []
    const params = []
    if (workspace) {
      where.push('workspace = ?')
      params.push(workspace)
    }
    if (since) {
      where.push('at >= ?')
      params.push(since)
    }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : ''
    return this.db
      .prepare(
        `SELECT provider, model, COUNT(*) AS turns, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
                COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM cost${clause} GROUP BY provider, model ORDER BY cost_usd DESC`,
      )
      .all(...params)
  }

  // ---- sessions ------------------------------------------------------------------------------------------------
  createSession({ id, workspace = null, provider = null, model = null, mode = null, title = null }) {
    const ts = nowIso()
    this.db
      .prepare('INSERT INTO sessions (id, workspace, provider, model, mode, started_at, updated_at, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, workspace, provider, model, mode, ts, ts, title)
    return id
  }

  updateSession(id, { provider, model, mode, steps, title } = {}) {
    this.db
      .prepare(
        `UPDATE sessions SET updated_at = ?, provider = COALESCE(?, provider), model = COALESCE(?, model),
         mode = COALESCE(?, mode), steps = COALESCE(?, steps), title = COALESCE(?, title) WHERE id = ?`,
      )
      .run(nowIso(), provider ?? null, model ?? null, mode ?? null, steps ?? null, title ?? null, id)
  }

  getSession(id) {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) || null
  }
}

export function nowIso() {
  return new Date().toISOString()
}

export function isAlive(pid) {
  if (!pid || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

let singleton = null
export function getStore() {
  if (!singleton) singleton = new Store()
  return singleton
}
export function closeStore() {
  if (singleton) singleton.close()
  singleton = null
}
