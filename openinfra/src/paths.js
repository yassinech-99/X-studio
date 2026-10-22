/**
 * Where things live. Every path is derived from OPENINFRA_HOME (or ~/.openinfra) so tests get a temp home and
 * never touch the developer's real state.
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export function home() {
  return process.env.OPENINFRA_HOME || path.join(os.homedir(), '.openinfra')
}

export function ensureHome() {
  const h = home()
  fs.mkdirSync(h, { recursive: true, mode: 0o700 })
  return h
}

export const paths = {
  get home() {
    return home()
  },
  get db() {
    return path.join(home(), 'openinfra.db')
  },
  get secrets() {
    return path.join(home(), 'secrets.json')
  },
  get providers() {
    return path.join(home(), 'providers.toml')
  },
  get registry() {
    return path.join(home(), 'workspaces.json')
  },
  get artifacts() {
    return path.join(home(), 'artifacts')
  },
  get leases() {
    return path.join(home(), 'leases')
  },
  get runs() {
    return path.join(home(), 'runs')
  },
  get toolchains() {
    return path.join(home(), 'toolchains')
  },
  get sessions() {
    return path.join(home(), 'sessions')
  },
  get cost() {
    return path.join(home(), 'cost.json')
  },
}

export function workspacePaths(root) {
  const meta = path.join(root, '.openinfra')
  return {
    root,
    meta,
    config: path.join(meta, 'config.toml'),
    schedule: path.join(meta, 'schedule.toml'),
    lock: path.join(root, 'openinfra.lock'),
    changes: path.join(meta, 'changes'),
    runs: path.join(meta, 'runs'),
    sessions: path.join(meta, 'sessions'),
    evidence: path.join(meta, 'evidence'),
    drift: path.join(meta, 'drift'),
    cache: path.join(meta, 'cache'),
  }
}
