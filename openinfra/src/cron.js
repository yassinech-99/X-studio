/**
 * Cron, five fields, in a timezone, with the two things most implementations get wrong handled explicitly:
 *
 *  - DST gap: a wall-clock time that does not exist is skipped, not silently shifted onto a neighbour.
 *  - DST overlap: a wall-clock time that happens twice runs once (the earlier instant).
 *  - "never fires" (e.g. 30 February) is detected and refused at parse time rather than at 3 a.m.
 */
const MONTH_NAMES = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 }
const DOW_NAMES = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 }
const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day of week', min: 0, max: 7, names: DOW_NAMES },
]

export class CronError extends Error {}

function parseField(raw, spec) {
  const text = String(raw).trim()
  if (text === '' ) throw new CronError(`empty ${spec.name} field`)
  const values = new Set()
  let wildcard = false
  for (const part of text.split(',')) {
    const [rangePart, stepPart] = part.split('/')
    const step = stepPart == null ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) throw new CronError(`bad step "${part}" in ${spec.name}`)
    let lo
    let hi
    if (rangePart === '*' || rangePart === '?') {
      lo = spec.min
      hi = spec.max
      wildcard = true
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-')
      lo = toValue(a, spec)
      hi = toValue(b, spec)
    } else {
      lo = toValue(rangePart, spec)
      hi = stepPart == null ? lo : spec.max
    }
    if (spec.name === 'day of week') {
      if (hi === 7) hi = 6
      if (lo === 7) lo = 0
    }
    if (lo > hi) throw new CronError(`${spec.name}: "${part}" has an empty range`)
    if (lo < spec.min || hi > spec.max) throw new CronError(`${spec.name}: "${part}" is out of range ${spec.min}-${spec.max}`)
    for (let v = lo; v <= hi; v += step) values.add(v)
  }
  if (!values.size) throw new CronError(`${spec.name}: "${text}" matches nothing`)
  return { values: [...values].sort((a, b) => a - b), wildcard }
}

function toValue(token, spec) {
  const upper = String(token).trim().toUpperCase()
  if (spec.names && upper in spec.names) return spec.names[upper]
  const n = Number(token)
  if (!Number.isInteger(n)) throw new CronError(`bad value "${token}" in ${spec.name}`)
  return n
}

export function parseCron(expression) {
  let expr = String(expression || '').trim().replace(/\s+/g, ' ')
  if (MACROS[expr.toLowerCase()]) expr = MACROS[expr.toLowerCase()]
  const parts = expr.split(' ')
  if (parts.length !== 5) throw new CronError(`expected 5 fields, got ${parts.length}: "${expression}"`)
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]))
  const parsed = {
    expression: expr,
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    month: month.values,
    dow: dow.values,
    // classic cron: if either day field is restricted, the *other* one is OR'd in
    domRestricted: !dom.wildcard,
    dowRestricted: !dow.wildcard,
  }
  const probe = nextRun(parsed, new Date('2026-01-01T00:00:00Z'), 'UTC', { maxDays: 1500 })
  if (!probe) throw new CronError(`"${expression}" never fires (impossible date combination)`)
  return parsed
}

const formatters = new Map()
function formatterFor(tz) {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    formatters.set(tz, f)
  }
  return f
}

export function isValidTimezone(tz) {
  try {
    formatterFor(tz).format(new Date())
    return true
  } catch {
    return false
  }
}

export function localParts(utcMs, tz = 'UTC') {
  const parts = formatterFor(tz).formatToParts(new Date(utcMs))
  const get = (t) => Number(parts.find((p) => p.type === t)?.value)
  const weekday = parts.find((p) => p.type === 'weekday')?.value
  const dow = DOW_NAMES[(weekday || '').toUpperCase().slice(0, 3)] ?? new Date(utcMs).getUTCDay()
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second'), dow }
}

export function offsetMinutes(utcMs, tz) {
  const p = localParts(utcMs, tz)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return Math.round((asUtc - utcMs) / 60000)
}

/** Wall-clock civil time -> UTC instant. Returns null when that wall time does not exist (DST gap). */
export function wallToUtc(y, m, d, h, mi, tz) {
  const wall = Date.UTC(y, m - 1, d, h, mi)
  let guess = wall
  for (let i = 0; i < 3; i++) {
    const off = offsetMinutes(guess, tz)
    const candidate = wall - off * 60000
    if (candidate === guess) break
    guess = candidate
  }
  const back = localParts(guess, tz)
  if (back.year !== y || back.month !== m || back.day !== d || back.hour !== h || back.minute !== mi) return null
  return guess
}

function dayMatches(p, y, m, d, dow) {
  if (!p.month.includes(m)) return false
  const domOk = p.dom.includes(d)
  const dowOk = p.dow.includes(dow)
  if (p.domRestricted && p.dowRestricted) return domOk || dowOk
  if (p.domRestricted) return domOk
  if (p.dowRestricted) return dowOk
  return true
}

/**
 * Next fire strictly after `from`. Iterates civil days then allowed hours/minutes, which is both exact and fast
 * (a year of misses costs ~365 cheap checks, not half a million minute checks).
 */
export function nextRun(parsed, from = new Date(), tz = 'UTC', { maxDays = 1500 } = {}) {
  const p = typeof parsed === 'string' ? parseCron(parsed) : parsed
  const fromMs = from instanceof Date ? from.getTime() : Number(from)
  const start = localParts(fromMs, tz)
  let { year, month, day } = start
  for (let i = 0; i < maxDays; i++) {
    const civil = new Date(Date.UTC(year, month - 1, day))
    const dow = civil.getUTCDay()
    if (dayMatches(p, year, month, day, dow)) {
      for (const h of p.hour) {
        for (const mi of p.minute) {
          const utc = wallToUtc(year, month, day, h, mi, tz)
          if (utc == null) continue // DST gap: this wall time never happens
          if (utc > fromMs) return new Date(utc)
        }
      }
    }
    civil.setUTCDate(civil.getUTCDate() + 1)
    year = civil.getUTCFullYear()
    month = civil.getUTCMonth() + 1
    day = civil.getUTCDate()
    if (i > 0 && month === 1 && day === 1 && i % 365 === 0 && i > 1460) break
  }
  return null
}

/** All fire times in (afterIso, uptoIso], capped so a long outage cannot produce a flood. */
export function occurrencesBetween(parsed, afterIso, uptoIso, tz = 'UTC', { limit = 50 } = {}) {
  const out = []
  let cursor = afterIso ? new Date(afterIso) : new Date(Date.now() - 60_000)
  const upto = new Date(uptoIso).getTime()
  for (let i = 0; i < limit; i++) {
    const next = nextRun(parsed, cursor, tz)
    if (!next || next.getTime() > upto) break
    out.push(next)
    cursor = next
  }
  return out
}

export function describeCron(expression) {
  const p = parseCron(expression)
  const pad = (n) => String(n).padStart(2, '0')
  if (p.minute.length === 1 && p.hour.length === 1 && !p.domRestricted && !p.dowRestricted) {
    return `daily at ${pad(p.hour[0])}:${pad(p.minute[0])}`
  }
  if (p.minute.length > 1 && p.hour.length === 24) return `every ${p.minute.length === 60 ? 'minute' : `${p.minute.length} minutes of the hour`}`
  return p.expression
}
