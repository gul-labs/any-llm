---
'@gullabs/core': minor
---

An aborted signal never dispatches, a hung sink no longer holds an abort or the deadline, and a middleware that rejects with the abort reason is an abort.

- A signal that is already aborted fails `generate()` / `runStructured()` with `aborted` before the middleware chain (one refusal row, `onError`), and an abort that lands between attempts stops the next dispatch. `countTokens` rejects without calling the adapter.
- The sink wait now also ends 100 ms after the caller aborts or the call deadline passes, logged at `error` as `llm.call.sink.interrupted` (`callId`, `attemptId`, `attemptNumber`, `provider`, `model`, `graceMs`). The write is always started, and a healthy sink keeps the 100 ms to land its row. Alert on this event next to `llm.call.sink.timeout`.
- A middleware or adapter that rejects with the signal's own reason (a host cancellation error, any custom `Error`) is `aborted` with that reason as `cause`, in `generate()`, `runStructured()` and `countTokens()`, not `unknown`.

What hosts must change: nothing, unless you relied on an aborted signal still dispatching.
