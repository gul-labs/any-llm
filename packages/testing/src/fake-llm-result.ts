/**
 * fakeLlmResult — a complete {@link LlmResult} for tests.
 *
 * @module
 */

import type { Cost, LlmResult, Message } from '@gullabs/core'

/** Results built so far in this process; numbers the default ids. */
let resultCount = 0

/** The text parts of `message`, joined, or `undefined` when it has none. */
function textOf(message: Message): string | undefined {
  const texts = message.parts.flatMap((p) => (p.kind === 'text' ? [p.text] : []))
  return texts.length > 0 ? texts.join('') : undefined
}

/**
 * Builds an {@link LlmResult} with every required field, overridden by
 * `partial`.
 *
 * Defaults: text `'ok'`, a `message` of one assistant text part, `continuation:
 * 'history'`, 10 input and 5 output tokens, `model: 'fake-model'`, `latencyMs:
 * 0`, no warnings, and a `callId` / `attemptId` numbered per process
 * (`call-1`, `call-2`, ...: two results never share an id, so a sink that
 * dedupes on `attemptId` keeps both). Pass `callId` / `attemptId` for exact
 * values.
 *
 * The default `cost` is **unpriced** (`microUsd: null`, `confidence:
 * 'estimated'`, an `unpricedReason`) and its `callCost` counts one unpriced
 * attempt: a fake that does not know the price does not claim `$0`, so a host
 * branch on an unpriced or non-exact cost runs by default, and a `usage` you
 * override never sits next to a stale price. Pass `cost` for a priced result.
 *
 * `text` and `message` stay consistent: give only `text` and the message carries
 * it; give only `message` and `text` is its text parts joined (absent when it
 * has none). Give both and they are used as given. `callCost` follows `cost`
 * unless you pass it: one attempt, priced when `cost.microUsd` is a number.
 *
 * @example
 * ```ts
 * const result = fakeLlmResult({ text: 'hello', usage: { inputTokens: 100, outputTokens: 20, details: {}, raw: null } })
 * const client = new FakeClient(result)
 * ```
 */
export function fakeLlmResult(partial: Partial<LlmResult> = {}): LlmResult {
  const text = partial.text ?? (partial.message === undefined ? 'ok' : undefined)
  const message: Message =
    partial.message ??
    ({ role: 'assistant', parts: [{ kind: 'text', text: text ?? '' }] } satisfies Message)
  const derivedText = text ?? textOf(message)
  const cost: Cost = partial.cost ?? {
    microUsd: null,
    usd: null,
    pricingVersion: 'fake',
    confidence: 'estimated',
    details: { input: 0, cached: 0, output: 0, tools: 0 },
    unpricedReason: 'fakeLlmResult: no cost was given, so none is claimed',
  }
  resultCount += 1
  const result: LlmResult = {
    message,
    continuation: 'history',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, details: {}, raw: null },
    cost,
    callCost: {
      microUsd: cost.microUsd ?? 0,
      attempts: 1,
      unpricedAttempts: cost.microUsd === null ? 1 : 0,
    },
    model: 'fake-model',
    latencyMs: 0,
    warnings: [],
    callId: `call-${resultCount}`,
    attemptId: `attempt-${resultCount}`,
    ...partial,
  }
  if (derivedText !== undefined) {
    result.text = derivedText
  } else {
    delete result.text
  }
  return result
}
