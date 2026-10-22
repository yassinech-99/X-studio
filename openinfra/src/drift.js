/**
 * Drift: compare what you declared (intent) with what is actually there (observed snapshots).
 *
 * This module is deliberately adapter-free. Adapters (SSH/NETCONF, Kubernetes, cloud, Terraform plan) collect an
 * `observed` tree and hand it here; the comparison, fingerprinting, severity and transition logic are identical
 * whichever adapter produced the tree. That is what makes it testable without a lab, and what lets us add a
 * source later without touching the engine.
 *
 *   intent/state.toml            [devices.sw-core-01] hostname = "sw-core-01" ...
 *   observed.json (or a folder)  { "objects": { "devices.sw-core-01": { ... } } }
 *
 * Findings carry a fingerprint that is stable across runs — stable enough that "same drift seen twice" is one
 * finding with occurrences=2, and "drift went away" is a single resolved transition.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { parseToml } from './toml.js'
import { workspacePaths } from './paths.js'

export const SEVERITIES = ['low', 'medium', 'high', 'critical']
const SEV_RANK = { low: 0, medium: 1, high: 2, critical: 3 }
export const worse = (a, b) => (SEV_RANK[a] >= SEV_RANK[b] ? a : b)

const HIGH_PATTERNS = [
  /(^|\.)hostname$/i,
  /(^|\.)routes?\./i,
  /(^|\.)bgp\./i,
  /(^|\.)acl/i,
  /(^|\.)firewall/i,
  /(^|\.)nat\./i,
  /(^|\.)vlan(s)?\./i,
  /(^|\.)interfaces?\..*\.(ip|address|mtu|speed|state)/i,
  /security/i,
  /encryption/i,
  /public/i,
]
const LOW_PATTERNS = [/(^|\.)description$/i, /(^|\.)snmp\..*contact/i, /(^|\.)banner/i, /(^|\.)comment/i]

export function loadIntent(root) {
  const dir = path.join(root, 'intent')
  const files = []
  const objects = {}
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.toml')) continue
      const file = path.join(dir, name)
      const tree = parseToml(fs.readFileSync(file, 'utf8'))
      files.push(file)
      flattenInto(objects, tree)
    }
  }
  const single = path.join(root, 'intent.toml')
  if (!files.length && fs.existsSync(single)) {
    files.push(single)
    flattenInto(objects, parseToml(fs.readFileSync(single, 'utf8')))
  }
  return { objects, files }
}

function flattenInto(objects, tree) {
  // Two levels: `[devices.sw-core-01]` is one object. A table of scalars is one object too.
  for (const [k, v] of Object.entries(tree)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const children = Object.entries(v)
      const allScalars = children.every(([, x]) => x === null || typeof x !== 'object' || Array.isArray(x))
      if (allScalars) {
        objects[k] = { ...v }
        continue
      }
      for (const [k2, v2] of children) {
        const id = `${k}.${k2}`
        if (v2 && typeof v2 === 'object' && !Array.isArray(v2)) {
          const leaves = {}
          collectLeaves(v2, '', leaves)
          objects[id] = leaves
        } else {
          objects[id] = { value: v2 }
        }
      }
    } else {
      objects[k] = { value: v }
    }
  }
}

function collectLeaves(node, prefix, out) {
  for (const [k, v] of Object.entries(node)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) collectLeaves(v, key, out)
    else out[key] = v
  }
}

export function loadObserved(input) {
  const files = []
  const objects = {}
  const visit = (p) => {
    if (!fs.existsSync(p)) return
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(p).sort()) if (name.endsWith('.json')) visit(path.join(p, name))
      return
    }
    const data = JSON.parse(fs.readFileSync(p, 'utf8'))
    files.push(p)
    const bag = data.objects || data
    for (const [k, v] of Object.entries(bag)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const leaves = {}
        collectLeaves(v, '', leaves)
        objects[k] = { ...(objects[k] || {}), ...leaves }
      } else objects[k] = { value: v }
    }
  }
  if (!input) return { objects, files }
  if (Array.isArray(input)) input.forEach(visit)
  else visit(input)
  return { objects, files }
}

export function defaultSeverity(key, intent, observed) {
  if (LOW_PATTERNS.some((re) => re.test(key))) return 'low'
  if (HIGH_PATTERNS.some((re) => re.test(key))) return 'high'
  if (typeof intent === 'boolean' || typeof observed === 'boolean') return 'high'
  const looksLikeInfra = /(ip|address|mask|prefix|route|next_hop|peer|acl|policy|port|vlan)/i.test(key)
  return looksLikeInfra ? 'high' : 'medium'
}

export function fingerprintOf({ object, key, intent, observed }) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([object, key, intent ?? null, observed ?? null]))
    .digest('hex')
}

function canonical(v) {
  if (Array.isArray(v)) return JSON.stringify([...v].map(canonical).sort())
  if (v && typeof v === 'object') {
    return JSON.stringify(Object.keys(v).sort().map((k) => [k, JSON.parse(canonical(v[k]) ?? 'null')]))
  }
  return JSON.stringify(v ?? null)
}

export function loadPolicy(root) {
  const file = path.join(root, 'rules', 'drift-policy.toml')
  const rules = []
  let failOn = 'high'
  if (fs.existsSync(file)) {
    const tree = parseToml(fs.readFileSync(file, 'utf8'))
    for (const r of tree.rule || []) if (r.path) rules.push({ match: new RegExp(r.path), severity: r.severity || 'medium' })
    if (tree.fail_on) failOn = tree.fail_on
  }
  return {
    file,
    failOn,
    severity(key, intent, observed) {
      for (const r of rules) if (r.match.test(key)) return r.severity
      return defaultSeverity(key, intent, observed)
    },
  }
}

/**
 * Compare intent with observed. Pure: no store, no I/O beyond the trees passed in.
 * Returns findings plus the coverage matrix, which is the honest answer to "what did we not look at".
 */
export function compareTrees(intent, observed, { policy = loadPolicy(process.cwd()), sources = [] } = {}) {
  const findings = []
  const coverage = { objects: 0, compared: 0, unobserved: [], extra: [], fields: 0 }
  for (const [objectId, desired] of Object.entries(intent.objects)) {
    coverage.objects++
    const actual = observed.objects[objectId]
    if (!actual) {
      coverage.unobserved.push(objectId)
      findings.push({
        object: objectId,
        key: '*',
        category: 'unreadable',
        severity: 'medium',
        title: `${objectId}: no observation`,
        detail: 'declared in intent but no source returned data for it — treated as unknown, not as matching',
        fingerprint: fingerprintOf({ object: objectId, key: '*', intent: 'declared', observed: null }),
      })
      continue
    }
    coverage.compared++
    for (const [key, want] of Object.entries(desired)) {
      coverage.fields++
      const have = actual[key]
      if (canonical(want) === canonical(have)) continue
      const severity = policy.severity(key, want, have)
      findings.push({
        object: objectId,
        key,
        category: have === undefined ? 'missing' : 'changed',
        severity,
        title: `${objectId}: ${key} ${have === undefined ? 'is not set' : 'differs'}`,
        detail: `expected ${JSON.stringify(want) ?? 'unset'}, observed ${JSON.stringify(have) ?? 'unset'}`,
        desired: want,
        observed: have,
        fingerprint: fingerprintOf({ object: objectId, key, intent: want, observed: have }),
      })
    }
  }
  for (const objectId of Object.keys(observed.objects)) {
    if (!intent.objects[objectId]) coverage.extra.push(objectId)
  }
  findings.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || a.title.localeCompare(b.title))
  return { findings, coverage, sources }
}

export function summarize(findings) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 }
  const byCategory = {}
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1
    byCategory[f.category] = (byCategory[f.category] || 0) + 1
  }
  return { total: findings.length, bySeverity, byCategory }
}

/** Full run: read intent + observed, compare, persist findings and transitions, return a report. */
export function checkDrift({ root, store, runId = null, observed: observedInput = null, workspaceId = null }) {
  const paths = workspacePaths(root)
  const intent = loadIntent(root)
  if (!intent.files.length) {
    return {
      ok: false,
      reason: 'no intent',
      hint: 'create intent/*.toml (or intent.toml) describing the desired state',
      files: [],
      findings: [],
      coverage: { objects: 0, compared: 0, unobserved: [], extra: [], fields: 0 },
    }
  }
  const observedDir = path.join(paths.drift, 'observed.json')
  const observed = loadObserved(observedInput || (fs.existsSync(observedDir) ? observedDir : path.join(paths.drift, 'observed')))
  const policy = loadPolicy(root)
  const { findings, coverage } = compareTrees(intent, observed, { policy })
  const workspace = workspaceId || root

  let transitions = { new: 0, changed: 0, resolved: 0, unchanged: 0 }
  if (store) {
    const seen = new Set()
    for (const f of findings) {
      seen.add(f.fingerprint)
      const res = store.upsertFinding({
        workspace,
        fingerprint: f.fingerprint,
        category: f.category,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        source: f.object,
        target: f.key,
        runId,
      })
      if (res.kind === 'new') transitions.new++
      else if (res.kind === 'changed') transitions.changed++
      else transitions.unchanged++
    }
    const resolved = store.resolveMissing({ workspace, seenFingerprints: seen, runId })
    transitions.resolved = resolved.length
  }

  const summary = summarize(findings)
  const failOn = policy.failOn === 'any' ? 'low' : policy.failOn
  const shouldFail = findings.some((f) => SEV_RANK[f.severity] >= (SEV_RANK[failOn] ?? 2) && f.category !== 'unreadable')
  return {
    ok: true,
    files: { intent: intent.files, observed: observed.files },
    findings,
    summary,
    coverage,
    transitions,
    failOn,
    drift: shouldFail,
    policy: policy.file,
  }
}
