---
'@gullabs/google': minor
---

Two Google failures that are billed and would repeat are no longer retried.

- The adapter's own client-side ceiling (5 minutes standard, 25 minutes flex, armed when no `timeoutMs` is set) and the SDK's transport timer end a call that reaches the same limit again, after Google may already have run and billed it. They are now `kind: 'timeout'`, `retryable: false`, `reason: 'transport_timeout'`, as for xAI. With the default `retryMiddleware` a standard call that hit the ceiling used to run three times (15 minutes of possibly billed generation, a Flex call 75) and show only `unpricedAttempts: 3`; it is now one attempt and one `timeout` row. `classifyGoogleError` also marks any `TimeoutError` or undici timer without an HTTP status the same way; an HTTP 408 or 504 keeps core's retry, and an already-classified `LlmError` is untouched.
- A candidate-less HTTP 200 that billed reasoning tokens is the output cap spent on thinking: the same request with the same cap fails the same way. It is `server`, `retryable: false`, usage attached. One with no reasoning evidence stays retryable.

What hosts must change: a host that wants another attempt after either failure does it itself (raise `maxOutputTokens` for the second, call again for the first); `retryMiddleware` no longer does.
