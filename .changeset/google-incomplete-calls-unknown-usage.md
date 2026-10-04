---
'@gullabs/google': minor
---

A function call beside a stopped candidate is not returned, a 200 without usage is unpriced, and a fenced Gemma answer is named.

- A function call is complete only when the candidate finished with `STOP` (or no finish reason). Beside `MAX_TOKENS` (cut by the output cap), a filter stop (`SAFETY`, `RECITATION`, ...) or any other finish it is dropped from `toolCalls` and from `result.message`, a warning names it, and `finishReason` is `length`, `content_filter` or `other` instead of `tool_calls`. A filter stop with no text and no complete call is the `content_filter` failure (billed, not retryable). A tool loop used to run a call Google had stopped for safety.
- A 200 with no `usageMetadata` is unknown usage: `usage.details.usage_missing` is `1`, a warning says so, and the pricing source returns an unpriced (`microUsd: null`), `estimated` cost with an `unpricedReason`, not an exact $0.
- A schema answer from Gemma that is wrapped in a markdown code fence (67 of 162 in the 2026-10-03 probe, 41%) is returned as sent with `outputParsed: false` and a `gemma_fenced_json` warning. Nothing is unwrapped: the README gives the host recommendation.
- `output.jsonSchema` for a custom descriptor with `nativeStructuredOutput: false` is `bad_request`; it used to be dropped without a word.

What hosts must change: a tool loop that read `finishReason: 'tool_calls'` beside a stopped candidate now sees `length` or `content_filter` and no `toolCalls`; code that treated a missing `usage_missing`-marked cost as `0` reads `null`; Gemma schema users handle a fenced `result.text` themselves.
