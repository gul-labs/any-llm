import type { LlmError } from '@gullabs/core'
import { hasQuotaFailure, parseGoogleErrorBody } from './errors.js'

/**
 * True when a failed Flex call may be retried once on the Standard tier
 * because Flex capacity, not the caller's quota, ran out.
 *
 * Decided from the structured error only (never the message text). Google's
 * Flex page (ai.google.dev/gemini-api/docs/flex-inference, read 2026-10-03,
 * page dated 2026-09-23) lists two failures when capacity is unavailable:
 * 503 "The system is currently at capacity" and 429 "Rate limits or resource
 * exhaustion". So:
 *
 * - HTTP 503 is capacity.
 * - HTTP 429 with `error.status` `RESOURCE_EXHAUSTED` is capacity only when the
 *   body carries no `QuotaFailure` detail. A `QuotaFailure` names the quota that
 *   ran out, which a Standard retry would hit too, so it is not capacity.
 * - Anything else, including a 429 with no parseable body, is not capacity.
 *
 * `err` is the classified error; its `cause` is the raw SDK error.
 */
export function isGeminiCapacityError(err: LlmError): boolean {
  if (err.httpStatus === 503) return true
  if (err.httpStatus !== 429) return false
  const body = parseGoogleErrorBody(err)
  return body?.status === 'RESOURCE_EXHAUSTED' && !hasQuotaFailure(body)
}
