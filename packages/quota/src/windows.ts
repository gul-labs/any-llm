/**
 * The quota windows the stores share: per-minute buckets, per-day buckets (the
 * UTC day, or the calendar day of an IANA time zone, built on
 * `Intl.DateTimeFormat` with no dependency), and the check-and-consume rule.
 *
 * The day boundary is DST-safe by construction: it is found by searching for
 * the first instant whose local calendar date is later, never by adding 24
 * hours.
 *
 * @module
 */

import { LlmError } from '@gullabs/core'
import type { QuotaStoreCheckInput, QuotaStoreCheckResult } from './index.js'

/** Where a per-day window rolls over. Without one the day is the UTC day. */
export interface DayBoundary {
  /** An IANA time zone name, for example `America/Los_Angeles`. */
  timeZone: string
}

/** No day has more than 25 hours; 49 h leaves room to find the next date. */
const SEARCH_SPAN_MS = 49 * 3_600_000

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      calendar: 'gregory',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/**
 * Throws `bad_request` unless `boundary` names a time zone the runtime knows.
 * `path` names the field in the message.
 */
export function assertDayBoundary(boundary: unknown, path: string): DayBoundary {
  const timeZone =
    typeof boundary === 'object' && boundary !== null
      ? (boundary as { timeZone?: unknown }).timeZone
      : undefined
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new LlmError(
      `Invalid quota rule: "${path}" must be { timeZone: <IANA time zone name> }.`,
      { kind: 'bad_request', retryable: false },
    )
  }
  try {
    formatterFor(timeZone)
  } catch (cause) {
    throw new LlmError(
      `Invalid quota rule: "${path}.timeZone" is not a time zone this runtime knows: ${timeZone}.`,
      { kind: 'bad_request', retryable: false, cause },
    )
  }
  return { timeZone }
}

/** `YYYY-MM-DD`, the calendar date of `nowMs` in `timeZone`. */
export function localDate(nowMs: number, timeZone: string): string {
  let year = ''
  let month = ''
  let day = ''
  for (const part of formatterFor(timeZone).formatToParts(nowMs)) {
    if (part.type === 'year') year = part.value
    else if (part.type === 'month') month = part.value
    else if (part.type === 'day') day = part.value
  }
  return `${year.padStart(4, '0')}-${month}-${day}`
}

/**
 * Milliseconds from `nowMs` until the first instant whose calendar date in
 * `timeZone` is later than `nowMs`'s: the length of the time left in the
 * current day. A day of 23 or 25 hours (a DST change) is measured as it is.
 * Always a positive integer.
 */
export function msUntilNextLocalDay(nowMs: number, timeZone: string): number {
  const base = Math.floor(nowMs)
  const today = localDate(base, timeZone)
  let low = base
  let high = base + SEARCH_SPAN_MS
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2)
    if (localDate(mid, timeZone) > today) {
      high = mid
    } else {
      low = mid
    }
  }
  return Math.max(Math.ceil(high - nowMs), 1)
}

/** `YYYY-MM-DD`, the UTC date of `nowMs`. */
export function utcDate(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

/** Milliseconds from `nowMs` until the next UTC midnight; a positive integer. */
export function msUntilNextUtcDay(nowMs: number): number {
  const d = new Date(nowMs)
  const nextDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  return Math.max(Math.ceil(nextDay - nowMs), 1)
}

/** The day window's identity for a store key: the date, and the zone when one is set. */
export function dayBucket(nowMs: number, boundary: DayBoundary | undefined): string {
  return boundary === undefined
    ? utcDate(nowMs)
    : `${boundary.timeZone}@${localDate(nowMs, boundary.timeZone)}`
}

/** Milliseconds left in the day window that contains `nowMs`. */
export function msUntilDayEnds(nowMs: number, boundary: DayBoundary | undefined): number {
  return boundary === undefined
    ? msUntilNextUtcDay(nowMs)
    : msUntilNextLocalDay(nowMs, boundary.timeZone)
}

/** The calendar-minute window identity, `YYYYMMDDHHMM` (UTC). */
export function minuteBucket(nowMs: number): string {
  const d = new Date(nowMs)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${y}${m}${day}${hh}${mm}`
}

/** Milliseconds until the next minute starts; a positive integer. */
export function msUntilNextMinute(nowMs: number): number {
  const nextMinute = Math.floor(nowMs / 60_000) * 60_000 + 60_000
  // Integer: `PEXPIRE` rejects a fractional TTL after `INCRBY` already ran.
  return Math.max(Math.ceil(nextMinute - nowMs), 1)
}

/** One counter a store checks: its key, its limit, what a call adds and when it ends. */
export interface QuotaWindow {
  kind: 'rpm' | 'rpd' | 'tpm'
  key: string
  limit: number
  /** What one call adds: 1 for a request window, the token estimate for `tpm`. */
  cost: number
  /** Milliseconds until the window rolls over (the counter's TTL). */
  ttlMs: number
}

/** The key of the `tpm` counter for the minute that contains `nowMs`. */
export function tokenWindowKey(prefix: string, scope: string, nowMs: number): string {
  return `${prefix}:tpm:${scope}:${minuteBucket(nowMs)}`
}

/** The windows `input` configures, in check order (`rpm`, `rpd`, `tpm`). */
export function planWindows(prefix: string, input: QuotaStoreCheckInput): QuotaWindow[] {
  const windows: QuotaWindow[] = []
  if (input.rpm !== undefined && input.rpm > 0) {
    windows.push({
      kind: 'rpm',
      key: `${prefix}:rpm:${input.scope}:${minuteBucket(input.nowMs)}`,
      limit: input.rpm,
      cost: 1,
      ttlMs: msUntilNextMinute(input.nowMs),
    })
  }
  if (input.rpd !== undefined && input.rpd > 0) {
    windows.push({
      kind: 'rpd',
      key: `${prefix}:rpd:${input.scope}:${dayBucket(input.nowMs, input.dayBoundary)}`,
      limit: input.rpd,
      cost: 1,
      ttlMs: msUntilDayEnds(input.nowMs, input.dayBoundary),
    })
  }
  if (input.tpm !== undefined && input.tpm > 0) {
    windows.push({
      kind: 'tpm',
      key: tokenWindowKey(prefix, input.scope, input.nowMs),
      limit: input.tpm,
      cost: Math.max(Math.ceil(input.tokens ?? 0), 0),
      ttlMs: msUntilNextMinute(input.nowMs),
    })
  }
  return windows
}

/**
 * Whether a call that adds `cost` to a counter standing at `used` is refused.
 * A counter at or past its limit refuses everything. A request that would
 * cross the limit is refused too, except into an empty counter: one call larger
 * than the whole window is let through when nothing else is counted (the
 * provider decides on it), instead of waiting for a window it can never fit.
 * For a request window (`cost` 1) this is `used >= limit`.
 */
export function isOverLimit(used: number, limit: number, cost: number): boolean {
  return used >= limit || (used > 0 && used + cost > limit)
}

/**
 * Turns the counters a check read into the result the store returns. `consumed`
 * says whether the check added to the counters; `counts` are the values after
 * the increment when it did, the untouched values when it did not.
 */
export function windowResults(
  windows: readonly QuotaWindow[],
  consumed: boolean,
  counts: readonly number[],
): QuotaStoreCheckResult {
  const decision: QuotaStoreCheckResult = {}
  for (const [i, window] of windows.entries()) {
    const count = counts[i] ?? 0
    const result: {
      allowed: boolean
      retryAfterMs?: number
      remaining: number
      used: number
    } = {
      // On a denial only the windows that are themselves over their limit are
      // "not allowed"; the others were under their limit but not consumed.
      allowed: consumed || !isOverLimit(count, window.limit, window.cost),
      remaining: Math.max(window.limit - count, 0),
      used: count,
    }
    if (!result.allowed) {
      result.retryAfterMs = window.ttlMs
    }
    decision[window.kind] = result
  }
  return decision
}
