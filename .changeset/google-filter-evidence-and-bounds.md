---
'@gullabs/google': minor
---

A thrown `content_filter` keeps the evidence, copied candidate metadata is bounded, and REST `countTokens` failures are classified.

- A filtered empty candidate (and a blocked prompt) names the blocking safety category in the message (`HARM_CATEGORY_X=HIGH (blocked)`), and the thrown error's `cause` carries the raw `finishReason`, bounded `finishMessage` and `safetyRatings`. Error rows store only the message, so the category now reaches the ledger.
- `providerMetadata.google.candidate` is bounded: `finishMessage` at 512 characters, any list inside `citationMetadata`, `urlContextMetadata` and `safetyRatings` at 50 entries, strings at 2048 characters; a warning says when something was cut. `finishMessage` of a `MALFORMED_FUNCTION_CALL` can carry the model's own call text, which should not fill the ledger column.
- The REST `countTokens` (used when `system` or `tools` is present) reads the body once: an unparseable JSON error body is classified by its HTTP status instead of throwing a `SyntaxError`, a non-JSON error body (an HTML proxy page) is cut to 500 characters in the message, and a 200 whose body is not a JSON object is a retryable `server` error. This form has not been checked against a live call.
- An empty `system` string is absent everywhere: `generate()` sends no `systemInstruction`, `cachedContent` with `system: ''` is no longer a conflict, and `countTokens` already treated it as absent.

What hosts must change: nothing, unless you read `providerMetadata.google.candidate.finishMessage` or citation lists beyond the bounds above.
