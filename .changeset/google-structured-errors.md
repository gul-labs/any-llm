---
'@gullabs/google': minor
'@gullabs/testing': minor
---

Google errors are classified from the structured body, and an output-side filter stop is an error.

- `RetryInfo.retryDelay` becomes `retryAfterMs`. A per-day quota (`QuotaFailure` quota id containing `PerDay`) is `rate_limited`, `retryable: false`, `reason: 'daily_quota'`. `API_KEY_INVALID` / `API_KEY_EXPIRED` (Google sends the first as HTTP 400) are `invalid_auth`, not `bad_request`. A stale `cachedContent` (HTTP 403, "CachedContent not found") is `bad_request` with `reason: 'cache_not_found'` instead of `invalid_auth`. The expired-key, per-minute, per-day and capacity bodies are doc-derived, not captures (ADR-036).
- A candidate that stopped for `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_SAFETY`, `IMAGE_PROHIBITED_CONTENT` or `IMAGE_RECITATION` with no answer text and no tool call now throws `content_filter` (`retryable: false`, billed usage attached) instead of returning an empty success. `SPII`, `IMAGE_PROHIBITED_CONTENT` and `IMAGE_RECITATION` map to `finishReason: 'content_filter'`. `providerMetadata.google.candidate` carries the raw `finishReason`, `finishMessage`, `safetyRatings`, `citationMetadata` and `urlContextMetadata`.
- `isGeminiCapacityError` decides from the structure (503, or 429 `RESOURCE_EXHAUSTED` without a `QuotaFailure`), not the message text.
- `countTokens` accepts `system` and `tools` again: with either present it calls the REST `countTokens` with a full `generateContentRequest`. Function calls in a Gemini 3 history still make the count `estimated`.
- `cachedContent` together with `system`, `tools` or `providerOptions.google.tools` is `bad_request` before dispatch. `GoogleCacheStore.create` and `getOrCreate` accept `tools` and `toolConfig`.
- `safetySettings` `category` and `threshold` are enumerated (the model config schemas too); an unlisted value is `bad_request`.
- An inline PDF over 50 MB, or a request with more than 100 MB of inline data and text, is `bad_request` before dispatch. `GoogleFileStore.upload` passes its `signal` (and an abort releases the caller), keeps Google's `File.error` when a file is `FAILED`, and its polling timeout is no longer retryable.
- `@gullabs/testing`: the fake Gemini candidate type gains `finishMessage`, `safetyRatings`, `citationMetadata` and `urlContextMetadata`.

What hosts must change:

- Handle `content_filter` from a call that used to return an empty result; do not retry it.
- A `403` that meant a stale cache is now `bad_request` with `reason: 'cache_not_found'`: drop the handle and recreate the cache. A bad API key is `invalid_auth`.
- Move `system` and `tools` into `GoogleCacheStore.create` when you send `cachedContent`.
- Replace any `safetySettings` value outside Google's documented lists.
- A polling timeout from `GoogleFileStore.upload` no longer retries by itself; poll the file by name or upload again deliberately.
