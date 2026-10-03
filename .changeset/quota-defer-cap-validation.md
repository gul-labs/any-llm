---
'@gullabs/quota': minor
'@gullabs/core': minor
---

Quota deferral cap fixed for per-minute windows, applied to the rate-limiter path, and validated.

- `maxDeferMs` defaults to 60 000 ms (an earlier draft used 30 000, which would have failed about half of all `rpm` deferrals, those with more than 30 s left in the minute, as `quota_window`). The cap exists to stop multi-hour windows being slept on; a per-minute deferral waits at most 60 s, so it stays retryable at the default.
- `providerQuotaRateLimiter` takes the same `maxDeferMs` option with the same default. An `rpd` exhaustion through the rate-limiter hook is now `rate_limited`, `retryable: false`, `reason: 'quota_window'` instead of a retryable error with an hours-long `retryAfterMs`.
- `maxDeferMs` must be a finite number >= 0, else `bad_request` (at construction for the middleware and rate limiter). `NaN` used to make every deferral retryable and a negative value made every deferral fatal. `Infinity` is rejected; pass a large finite number to effectively disable the cap.
- A fractional clock (for example `performance.timeOrigin + performance.now()`) no longer leaves a dangling counter: the TTL sent to `PEXPIRE` and `retryAfterMs` are whole milliseconds.
- `quotaPolicyForGemini` throws `bad_request` when its `models` table is keyed by a declared alias of the model being called, instead of silently not limiting it. `QuotaPolicyInput` and `CheckProviderQuotaOptions` gain an optional `aliases`.
- Core pins `modelDescriptor` at every middleware boundary, so an outer middleware that swaps it cannot change the model a quota policy counts under.

What hosts must change:

- Key `quotaPolicyForGemini({ models })` by canonical model ids, not aliases.
- Pass a finite `maxDeferMs`; to wait out a per-minute window with `retryMiddleware`, set its `maxDelayMs` and `maxAttempts` high enough (every deferral consumes an attempt).
