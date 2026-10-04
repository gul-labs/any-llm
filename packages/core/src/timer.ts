/**
 * Timer limits shared by the engine and the retry middleware.
 *
 * @module
 */

import { LlmError } from './errors.js'

/**
 * The longest `setTimeout` delay Node honours, in milliseconds (2^31 - 1,
 * about 24.8 days). A longer delay fires after 1 ms, which would turn a huge
 * timeout into an immediate one, so it is rejected instead.
 */
export const MAX_TIMER_MS = 2_147_483_647

/**
 * Throws `LlmError('bad_request')` unless `value` is a finite number greater
 * than 0 and at most {@link MAX_TIMER_MS}.
 *
 * @param value - The caller's number.
 * @param label - Names the option in the message, for example `sinkTimeoutMs`.
 * @param path  - The `issues` path.
 */
export function assertTimerMs(value: unknown, label: string, path: string): void {
  if (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_TIMER_MS
  ) {
    return
  }
  const rule = `must be a finite number greater than 0 and at most ${MAX_TIMER_MS}.`
  throw new LlmError(`${label} ${rule} Got ${String(value)}.`, {
    kind: 'bad_request',
    retryable: false,
    issues: [{ path, message: rule }],
  })
}
