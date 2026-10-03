---
'@gullabs/xai': minor
---

xAI transport timeouts: the SDK deadline is recognised precisely, `transport` covers `countTokens`, and bad transports and oversized timeouts are rejected.

- The `openai` SDK wraps every fetch failure that says "timed out" (an OS `ETIMEDOUT`, a TLS handshake timeout) as `APIConnectionTimeoutError`. The adapter used to read that class as its own deadline, so a connect-phase failure that never reached xAI became a non-retryable `transport_timeout`. The adapter now treats the error as the SDK deadline only when it has no cause or just the SDK's own `AbortError` and the call ran as long as the `timeout` it set. Every other wrapped timeout stays a retryable `timeout`. `classifyXaiError(error, deadline?)` takes an optional `{ timeoutMs, elapsedMs }` and exports the `XaiSdkDeadline` type; without it an SDK deadline is never reported.
- `transport.fetch` and `transport.fetchOptions` now also carry `countTokens` (`POST /v1/tokenize-text`), which used the global `fetch` and ignored a host proxy or egress policy.
- The adapter validates `transport` when it is created and keeps a private copy: a non-object transport, a `fetch` that is not a function, `fetchOptions` that is `null`, an array or a primitive are `bad_request` (not a bare `TypeError`), and later mutation of your own object cannot add `headers`, `signal`, `body` or `method`.
- The grok config schemas reject `timeoutMs` above 2147478647 (`2^31 - 1` minus the 5 s SDK buffer) with `bad_request`. Larger values used to arm a valid engine timer and an SDK timer that Node fires after 1 ms.

What hosts must change:

- Pass `classifyXaiError` the `{ timeoutMs, elapsedMs }` of your own SDK call if you call it directly and want the SDK deadline recognised.
- Do not rely on mutating a `transport` object after creating the adapter; create a new adapter.
- Keep `timeoutMs` at or below 2147478647.
