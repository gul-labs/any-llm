---
'@gullabs/core': minor
---

Engine hardening: a malformed `auth` never echoes the credential, a host's shared error object is never re-stamped, a bad `signal` arms no timer, and the call identity is fully pinned.

- `auth` that is a string, `null`, a number or an array is `invalid_auth` with a fixed message. It used to throw a V8 `TypeError` (`kind: 'unknown'`) whose message contained the key.
- An `LlmError` used as an abort reason, or thrown by an adapter from several calls, is copied (same kind, retryability, reason, status, delay, usage, warnings and issues, the original as `cause`) instead of being stamped with the first call's `callId` and `attemptId`. A stale `attemptId` also suppressed the second call's refusal row; it no longer does.
- `signal` that is not an `AbortSignal` is `bad_request` (`issues[0].path` `signal`) and takes the usual refusal path (one row, `onError`); `countTokens` refuses it too. The deadline timer is armed only after the signal is known good, and a throw can no longer leave it behind.
- The engine writes rows, results and attempt events with the `callId` it minted, not the `ctx.callId` a middleware passes down.
- `generate` snapshots the request, and `runStructured` the call site and options, once when the call starts: reassigning `request.metadata` or `externalId` mid-call changes nothing. Do not mutate nested objects (`messages`, `tools`, `metadata`) while a call is in flight. A missing (`undefined`) request is now `bad_request` instead of a classified `TypeError`.
- A failed attempt with no usage is known-free only for a 4xx or 5xx status; a 1xx-3xx status keeps it in `callCost.unpricedAttempts`.
- The shutdown advisory is given back when the attempt that chose it fails before it has a result.
- `countTokens` passes the client's `scheduler` to the adapter (`AdapterCtx.scheduler`).
- Building a large payload with a `FakeClock` as `scheduler` no longer hangs: the yield between steps also uses a real macrotask.

What hosts must change: nothing, unless you relied on the first bullet's `unknown` kind or on a mid-call mutation of the request object.
