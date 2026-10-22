/**
 * A run's journal: append-only NDJSON, fsynced per line, mirrored into SQLite for querying.
 *
 * The NDJSON file is the truth. If SQLite is corrupt or deleted, `oi run show` still reconstructs the run from
 * the journal — that is the whole point of writing it this way.
 */
import path from 'node:path'
import { appendLineSync, readLines } from './fsutil.js'
import { redactDeep } from './redact.js'
import { nowIso } from './store.js'

export class Journal {
  constructor({ runId, dir, store = null }) {
    this.runId = runId
    this.dir = dir
    this.file = path.join(dir, 'journal.ndjson')
    this.store = store
    this.seq = 0
  }

  write(type, payload = null) {
    this.seq += 1
    const entry = { seq: this.seq, ts: nowIso(), run_id: this.runId, type, payload: payload == null ? null : redactDeep(payload) }
    appendLineSync(this.file, JSON.stringify(entry))
    if (this.store) {
      try {
        this.store.appendEvent(this.runId, type, entry.payload)
      } catch {
        /* the file is the record; the index is a convenience */
      }
    }
    return entry
  }

  start(meta) {
    return this.write('run.started', meta)
  }

  finish(status, exitCode, extra = {}) {
    return this.write('run.finished', { status, exit_code: exitCode, ...extra })
  }
}

export function readJournal(file) {
  return readLines(file)
}

export function summarizeJournal(entries) {
  const out = { started: null, finished: null, events: entries.length, tools: 0, targets: {} }
  for (const e of entries) {
    if (e.type === 'run.started') out.started = e
    if (e.type === 'run.finished') out.finished = e
    if (e.type === 'tool.result') out.tools += 1
    if (e.type === 'target.state') {
      const t = e.payload?.target
      if (t) out.targets[t] = e.payload.state
    }
  }
  return out
}
