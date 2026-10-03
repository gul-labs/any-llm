---
'@gullabs/google': minor
---

`GoogleFileStore` and `GoogleCacheStore` classify every error through the same path as `generate()`.

- Upload, polling, delete (fail-closed) and `GoogleCacheStore.create` errors now carry `provider: 'google'` and the structured overlays: a bad API key is `invalid_auth` (it was a `bad_request` with the raw JSON body as the message), a per-day quota is `rate_limited` with `reason: 'daily_quota'` and is not retryable (a retry loop no longer re-sends the bytes), `RetryInfo` becomes `retryAfterMs`, and a stale `cachedContent` 403 is `bad_request` with `reason: 'cache_not_found'`.
- A file that ends `FAILED` follows the documented `File.error` status code: `DEADLINE_EXCEEDED`, `INTERNAL` and `UNAVAILABLE` are a retryable `server` error (a fresh upload can succeed); any other code is still a non-retryable `bad_request`.
- The upload polling timeout is `kind: 'server'`, `retryable: false` (it was `kind: 'timeout'`, `retryable: false`, which contradicted the rule that every `timeout` is retryable). A retry would upload the bytes again and orphan the first file; poll the file by name instead.

What hosts must change: branch on `kind: 'server'` (not `'timeout'`) for a file that did not become `ACTIVE` in time; treat `invalid_auth` from the stores as a credential problem and `daily_quota` as a stop, not a retry.
