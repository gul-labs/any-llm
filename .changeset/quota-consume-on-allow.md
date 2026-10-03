---
'@gullabs/core': minor
'@gullabs/quota': minor
---

Quota consumes only on allow, and `LlmErrorReason` lands in core.

`upstashQuotaStore.checkAndConsume` used to increment both windows before deciding, so denied calls consumed quota. It now runs one Lua `EVAL` that reads every counter and increments them all only when all are under their limits; a denied call changes nothing. `providerQuotaMiddleware` gains `maxDeferMs` (default 30 000): a deferral longer than that fails with `rate_limited`, `retryable: false`, `reason: 'quota_window'` instead of being retried, so the retry middleware does not sleep through a per-day window. The middleware also looks the policy up by the descriptor's canonical model id, so a declared alias is limited like its model.

`Middleware` gains a readonly `role?: 'retry' | 'quota'`, set by `retryMiddleware` and `providerQuotaMiddleware` (not configurable). `createClient` now rejects, with `bad_request`, a client whose middleware list puts a quota middleware before (outside) a retry middleware; quota accounts one unit per provider dispatch, which needs it inside retry. Core also exports the closed `LlmErrorReason` union and `LlmError.reason?`; `'quota_window'` is the first reason emitted.

What hosts must change:

- Order middleware as `[retryMiddleware(...), providerQuotaMiddleware(...)]`. The reverse is rejected at construction, whatever the middleware ids.
- A custom `QuotaStore` must also check and consume atomically (all windows or none). The Upstash store needs `EVAL` (Upstash REST supports it).
- Handle `reason: 'quota_window'` on `rate_limited` errors by rescheduling (`retryAfterMs` is still set) rather than retrying in-process. Keep a `default` branch when switching on `LlmErrorReason`: new members arrive in core minors.
