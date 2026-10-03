---
'@gullabs/core': minor
---

`classifyError` reads structured evidence first; `parseRetryAfter` and `isTransportError` are exported.

`classifyError` now checks an integer HTTP status (100-599) before any message text, so an `HTTP 400` whose message says "timeout" is `bad_request`, not a retried `timeout`. A transport failure (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE` or `UND_ERR_*` on the error or its `cause` chain, or `fetch failed` / `connection error` / `socket hang up`) is a retryable `server` error instead of a non-retryable `unknown`; undici's own deadlines (`UND_ERR_*_TIMEOUT`) stay retryable `timeout`. The message heuristic is last. `classifyHttpStatus` maps 404 and 413 to `bad_request` (not retryable); 409 stays `unknown`.

New exports: `isTransportError(e)`, the shared transport matcher for adapters, and `parseRetryAfter(headers, now)`, which reads `retry-after-ms`, `retry-after` (decimal seconds, HTTP-date, or a duration such as `6m0s`) and the `x-ratelimit-reset*` headers (a number above 1e9 is epoch seconds), ignores anything that is not a positive delay, and caps the result at 24 hours. `LlmError.retryAfterMs` set by `classifyError` now goes through it, so an epoch `x-ratelimit-reset` no longer yields a 56-year delay.

What hosts must change: a 404 or 413 that was retried as `unknown` (or matched on `unknown`) is now `bad_request`. Adapters can drop their own transport regexes and call `isTransportError`.
