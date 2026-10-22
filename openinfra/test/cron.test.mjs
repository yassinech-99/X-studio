import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCron, nextRun, occurrencesBetween, localParts, wallToUtc, CronError } from '../src/cron.js'

test('parses the five fields, ranges, steps and names', () => {
  const p = parseCron('*/15 9-17 * JAN-MAR MON-FRI')
  assert.deepEqual(p.minute, [0, 15, 30, 45])
  assert.equal(p.hour[0], 9)
  assert.equal(p.hour.at(-1), 17)
  assert.deepEqual(p.month, [1, 2, 3])
  assert.deepEqual(p.dow, [1, 2, 3, 4, 5])
})

test('accepts macros', () => {
  assert.equal(parseCron('@daily').expression, '0 0 * * *')
  assert.equal(parseCron('@hourly').minute[0], 0)
})

test('rejects malformed expressions', () => {
  assert.throws(() => parseCron('* * *'), CronError)
  assert.throws(() => parseCron('60 * * * *'), /out of range/)
  assert.throws(() => parseCron('* * * * 9'), /out of range/)
  assert.throws(() => parseCron('*/0 * * * *'), /bad step/)
})

test('refuses a schedule that can never fire', () => {
  assert.throws(() => parseCron('0 0 30 2 *'), /never fires/)
})

test('next run is strictly in the future, in UTC', () => {
  const next = nextRun(parseCron('*/15 * * * *'), new Date('2026-10-22T10:07:00Z'), 'UTC')
  assert.equal(next.toISOString(), '2026-10-22T10:15:00.000Z')
})

test('timezone conversion: Africa/Algiers is UTC+1', () => {
  const next = nextRun(parseCron('0 3 * * *'), new Date('2026-10-22T00:00:00Z'), 'Africa/Algiers')
  assert.equal(next.toISOString(), '2026-10-22T02:00:00.000Z')
})

test('day boundary in a timezone is not the UTC day', () => {
  const next = nextRun(parseCron('0 0 * * *'), new Date('2026-10-22T22:30:00Z'), 'Asia/Tokyo')
  assert.equal(next.toISOString(), '2026-10-23T15:00:00.000Z') // midnight 23 Oct JST
})

test('DST gap: 02:30 does not exist in Berlin on 2026-03-29, so it is skipped', () => {
  const next = nextRun(parseCron('30 2 * * *'), new Date('2026-03-28T12:00:00Z'), 'Europe/Berlin')
  assert.equal(next.toISOString(), '2026-03-30T00:30:00.000Z') // skipped the 29th entirely
})

test('DST overlap: a repeated wall time fires once', () => {
  const forward = nextRun(parseCron('30 2 * * *'), new Date('2026-10-25T00:00:00Z'), 'Europe/Berlin')
  const after = nextRun(parseCron('30 2 * * *'), forward, 'Europe/Berlin')
  assert.ok(forward.toISOString() <= '2026-10-25T01:30:00.000Z')
  assert.ok(after.getTime() - forward.getTime() >= 20 * 3600 * 1000, 'no double fire inside the repeated hour')
})

test('wallToUtc returns null inside a gap', () => {
  assert.equal(wallToUtc(2026, 3, 29, 2, 30, 'Europe/Berlin'), null)
  assert.ok(wallToUtc(2026, 3, 29, 3, 30, 'Europe/Berlin') > 0)
})

test('occurrences between two instants, capped', () => {
  const list = occurrencesBetween(parseCron('*/15 * * * *'), '2026-10-22T10:00:00Z', '2026-10-22T11:00:00Z', 'UTC')
  assert.equal(list.length, 4)
  assert.equal(list[0].toISOString(), '2026-10-22T10:15:00.000Z')
})

test('day-of-month and day-of-week are ORed when both are restricted (classic cron)', () => {
  // 1st of the month OR Mondays
  const p = parseCron('0 0 1 * 1')
  const monday = nextRun(p, new Date('2026-10-20T00:00:00Z'), 'UTC') // 21 Oct is a Wednesday; next Monday 26 Oct
  assert.equal(monday.toISOString(), '2026-10-26T00:00:00.000Z')
  const first = nextRun(p, new Date('2026-10-27T00:00:00Z'), 'UTC') // next 1st is 1 Nov
  assert.equal(first.toISOString(), '2026-11-01T00:00:00.000Z')
})

test('localParts reports the local weekday', () => {
  const p = localParts(Date.parse('2026-10-22T00:30:00Z'), 'Africa/Algiers')
  assert.equal(p.hour, 1)
  assert.equal(p.dow, 4) // Thursday
})
