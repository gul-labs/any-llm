/**
 * Day windows in a time zone: `Intl.DateTimeFormat` bucketing and
 * the time left in the day, DST-safe.
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'
import {
  assertDayBoundary,
  dayBucket,
  localDate,
  msUntilDayEnds,
  msUntilNextLocalDay,
  msUntilNextUtcDay,
} from './windows.js'

const HOUR = 3_600_000
const LA = 'America/Los_Angeles'

describe('localDate', () => {
  it('rolls over at midnight Pacific: 07:00Z in summer (PDT), 08:00Z in winter (PST)', () => {
    expect(localDate(Date.UTC(2026, 9, 3, 6, 59, 59, 999), LA)).toBe('2026-10-02')
    expect(localDate(Date.UTC(2026, 9, 3, 7, 0, 0), LA)).toBe('2026-10-03')
    expect(localDate(Date.UTC(2026, 11, 15, 7, 59, 59, 999), LA)).toBe('2026-12-14')
    expect(localDate(Date.UTC(2026, 11, 15, 8, 0, 0), LA)).toBe('2026-12-15')
  })

  it('differs from the UTC day for most of the evening in Pacific time', () => {
    // 23:00 UTC on Oct 3 is 16:00 PDT the same day; 03:00 UTC on Oct 4 is still Oct 3 in LA.
    expect(localDate(Date.UTC(2026, 9, 4, 3, 0, 0), LA)).toBe('2026-10-03')
    expect(new Date(Date.UTC(2026, 9, 4, 3, 0, 0)).toISOString().slice(0, 10)).toBe(
      '2026-10-04',
    )
  })

  it('works for a half-hour offset zone', () => {
    // Asia/Kolkata is UTC+5:30: local midnight is 18:30Z.
    expect(localDate(Date.UTC(2026, 9, 3, 18, 29, 59), 'Asia/Kolkata')).toBe('2026-10-03')
    expect(localDate(Date.UTC(2026, 9, 3, 18, 30, 0), 'Asia/Kolkata')).toBe('2026-10-04')
  })
})

describe('msUntilNextLocalDay', () => {
  it('is the time to the next local midnight', () => {
    expect(msUntilNextLocalDay(Date.UTC(2026, 9, 3, 6, 59, 59), LA)).toBe(1_000)
    expect(msUntilNextLocalDay(Date.UTC(2026, 9, 3, 12, 0, 0), LA)).toBe(19 * HOUR)
  })

  it('a full day right after midnight', () => {
    expect(msUntilNextLocalDay(Date.UTC(2026, 9, 3, 7, 0, 0), LA)).toBe(24 * HOUR)
  })

  it('is an integer even for a fractional clock, and at least 1', () => {
    const ms = msUntilNextLocalDay(Date.UTC(2026, 9, 3, 6, 59, 59) + 0.5, LA)
    expect(Number.isInteger(ms)).toBe(true)
    // 999.5 ms remain: rounded up so a TTL is never fractional.
    expect(ms).toBe(1_000)
    expect(msUntilNextLocalDay(Date.UTC(2026, 9, 3, 6, 59, 59, 999), LA)).toBe(1)
  })

  it('the spring-forward day (2026-03-08, Pacific) is 23 hours long', () => {
    // PST midnight is 08:00Z; the next midnight is PDT, 07:00Z the next day.
    expect(msUntilNextLocalDay(Date.UTC(2026, 2, 8, 8, 0, 0), LA)).toBe(23 * HOUR)
    // Two hours in, 21 hours remain (the skipped hour is gone from the day).
    expect(msUntilNextLocalDay(Date.UTC(2026, 2, 8, 10, 0, 0), LA)).toBe(21 * HOUR)
  })

  it('the fall-back day (2026-11-01, Pacific) is 25 hours long', () => {
    // PDT midnight is 07:00Z; the next midnight is PST, 08:00Z on Nov 2.
    expect(msUntilNextLocalDay(Date.UTC(2026, 10, 1, 7, 0, 0), LA)).toBe(25 * HOUR)
    // During the repeated hour the bucket does not change: 01:30 PDT and 01:30 PST
    // are the same local date.
    expect(localDate(Date.UTC(2026, 10, 1, 8, 30, 0), LA)).toBe('2026-11-01')
    expect(localDate(Date.UTC(2026, 10, 1, 9, 30, 0), LA)).toBe('2026-11-01')
  })

  it('a zone whose DST change skips midnight (Havana, 2026-03-08) measures the day as it is', () => {
    // Clocks jump from 00:00 to 01:00 at 05:00Z, so the day starts at 01:00 local
    // and ends at the next midnight (CDT, 04:00Z): 23 hours.
    expect(msUntilNextLocalDay(Date.UTC(2026, 2, 8, 5, 0, 0), 'America/Havana')).toBe(
      23 * HOUR,
    )
  })
})

describe('UTC (no day boundary)', () => {
  it('the bucket is the UTC date and the day ends at UTC midnight', () => {
    expect(dayBucket(Date.UTC(2026, 9, 3, 23, 59, 59), undefined)).toBe('2026-10-03')
    expect(msUntilDayEnds(Date.UTC(2026, 9, 3, 23, 0, 0), undefined)).toBe(HOUR)
    expect(msUntilNextUtcDay(Date.UTC(2026, 9, 3, 0, 0, 0))).toBe(24 * HOUR)
  })

  it('a zone bucket names the zone, so a changed boundary never shares a counter', () => {
    const at = Date.UTC(2026, 9, 3, 12, 0, 0)
    expect(dayBucket(at, { timeZone: LA })).toBe(`${LA}@2026-10-03`)
    expect(dayBucket(at, { timeZone: LA })).not.toBe(dayBucket(at, undefined))
    expect(msUntilDayEnds(at, { timeZone: LA })).toBe(19 * HOUR)
  })
})

describe('assertDayBoundary', () => {
  it('accepts a known zone', () => {
    expect(assertDayBoundary({ timeZone: LA }, 'dayBoundary')).toEqual({ timeZone: LA })
  })

  it.each([
    ['an unknown zone', { timeZone: 'Mars/Olympus_Mons' }],
    ['an empty zone', { timeZone: '' }],
    ['no zone', {}],
    ['a string', 'America/Los_Angeles'],
    ['null', null],
  ])('rejects %s with bad_request naming the field', (_label, value) => {
    expect(() => assertDayBoundary(value, 'dayBoundary')).toThrow(LlmError)
    expect(() => assertDayBoundary(value, 'dayBoundary')).toThrow(/dayBoundary/)
    try {
      assertDayBoundary(value, 'dayBoundary')
    } catch (error) {
      expect(error).toMatchObject({ kind: 'bad_request', retryable: false })
    }
  })
})
