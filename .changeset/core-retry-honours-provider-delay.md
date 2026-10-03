---
'@gullabs/core': minor
---

Retry never undercuts a provider delay, and a backoff that cannot fit the deadline surfaces the real error.

`retryMiddleware` used to clamp a provider `Retry-After` to `maxDelayMs` and retry early, which is refused again and billed again. Now a delay the provider asks for is honoured or the retry stops: when `LlmError.retryAfterMs` is longer than `maxDelayMs`, or not shorter than the remaining `timeoutMs`, the middleware rethrows that attempt's own error with `retryAfterMs` intact (whatever a custom `shouldRetry` says). `computeBackoffMs` returns `retryAfterMs` unchanged, `maxDelayMs` caps only the computed backoff, and there is no clamp option.

With `timeoutMs` set, a backoff that would leave the next attempt less than 250 ms of the budget is no longer slept away and replaced by a synthetic `timeout`: the failed attempt's own error is rethrown at once. Retry has no synthetic deadline error of its own any more.

What hosts must change: a 429 whose `retryAfterMs` exceeds `maxDelayMs` now reaches the caller after the first attempt instead of being retried early. Raise `maxDelayMs` to wait longer in process, or reschedule from `error.retryAfterMs`. Code that matched the old "Overall timeout budget" message must read `kind` and `retryable` instead. `@gullabs/quota` deferrals longer than the retry middleware's `maxDelayMs` (60 s by default, equal to the quota `maxDeferMs` default) now end the retry with the deferral error rather than waking early.
