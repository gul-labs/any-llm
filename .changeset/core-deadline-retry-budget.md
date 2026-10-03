---
'@gullabs/core': minor
'@gullabs/quota': minor
---

The call deadline is one budget shared by the engine and retry, always settles `generate()`, and never turns a billed result into a timeout; retry validates its policy and spreads provider delays.

- `EngineCtx.deadlineAt` (new, on the client `clock`'s scale) is the end of the call's `timeoutMs` budget. `retryMiddleware` measures against it instead of the time it was entered, so middleware before it counts. It no longer takes a `now` option and reads `ctx.clock`, and it no longer stamps `attemptTimeoutMs` (the engine sets it from the deadline). Deadline arithmetic follows the injected `clock`; a frozen clock leaves middleware time uncounted.
- When the budget cannot cover a back-off plus a minimum window of 250 ms for the next attempt, or a new attempt would start with less than 250 ms, retry rethrows the failed attempt's own error (same object, `cause` and `retryAfterMs` intact). The engine's own deadline errors carry the last attempt's error as `cause`, and are that error when it is a `timeout` or carries a provider `retryAfterMs`.
- The deadline can no longer be lost while an attempt is in flight: when an attempt ends without a result after the timer fired, a call that is still pending is ended with the deadline error and `ctx.signal` aborts, so a middleware that hangs after a failed attempt cannot hold `generate()`.
- A result an attempt produced is returned when work after `next()` (a cache write, a usage notification) runs past the deadline or hangs: one success row, no `timeout`. Only that work's changes to the result are dropped.
- `retryMiddleware` rejects `maxAttempts` that is not a positive integer, and `baseDelayMs` / `maxDelayMs` that are not finite numbers from 0 to 2147483647, with `bad_request` at construction. A provider `retryAfterMs` that is `NaN`, zero or negative is not a delay and no longer causes an immediate retry. The provider's delay gets up to 10 % (at most 1 s) of jitter added on top. The `maxDelayMs` default is now 60 s, equal to the quota `maxDeferMs` default, so a 31-60 s per-minute deferral is slept and retried again.
- `config.timeoutMs`, `sinkTimeoutMs` and `countTokens`' `timeoutMs` must be at most 2147483647 (a longer timer fired after 1 ms); `config.timeoutMs` that is not a finite number greater than 0 is `bad_request` before any row.

What hosts must change: drop `now` from `retryMiddleware` options and give the client a `clock` that advances in real time when you set `timeoutMs`. A call whose `timeoutMs` was above 2147483647 or not positive now fails with `bad_request`.
