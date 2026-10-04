import type { LlmError } from '@gullabs/core'

/**
 * True when a failed Flex call may be retried once on the Standard tier
 * because Flex capacity, not the caller's quota, ran out.
 *
 * Only HTTP 503 counts. Google's Flex page (ai.google.dev/gemini-api/docs/
 * flex-inference, read 2026-10-03, page dated 2026-09-23) lists two failures
 * when capacity is unavailable, 503 "The system is currently at capacity" and
 * 429 "Rate limits or resource exhaustion", but documents no field that tells
 * a capacity 429 from a quota 429, and no capture of either 429 exists. A 429
 * is therefore the ordinary rate-limit path (the provider's `RetryInfo` delay
 * is honoured, no Standard dispatch, no tier pin): dispatching Standard at once
 * would undercut the delay, add a call to a rate-limited project and bill the
 * logical call at the Standard rate. Nothing in the message text is read.
 *
 * `err` is the classified error.
 */
export function isGeminiCapacityError(err: LlmError): boolean {
  return err.httpStatus === 503
}
