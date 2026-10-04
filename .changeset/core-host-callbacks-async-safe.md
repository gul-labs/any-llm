---
'@gullabs/core': minor
'@gullabs/quota': minor
---

A host callback that returns a rejecting promise can no longer crash the process, and the hook-failure log event is renamed.

Telemetry hooks, the logger's methods, a rate limiter's `Release` and the `@gullabs/quota` handlers (`onEvent`, `onReconcileError`, `onWindowChecksSkipped`) were only guarded against a synchronous throw. `async onError(e) { await flush() }` type-checks for a `=> void` member, and its rejection was an unhandled rejection: on Node's default that ends the process after a call that was already billed. Every such callback now goes through one guard that absorbs a throw and handles the rejection of a returned promise. `onStart`'s return value is still the span, a rejected promise included. A throwing `Scheduler.clearTimeout` no longer leaves a call half cleaned up. The guard is exported as `guardHostCall` for middleware and port implementations that call host callbacks. `retryMiddleware`'s `shouldRetry` must return a boolean synchronously: a returned promise is `bad_request` (it would have been truthy for every error).

A failed hook or logger is now logged once, at `debug`, as `llm.hook.failed` (fields `callId`, `phase`, `error`). It replaces `llm.telemetry.hook.failed`; there is no alias. The logger's own failures are reported through the same logger once and a logger that always fails is not logged about again.

What hosts must change: nothing for correctness. Alerts or dashboards that matched `llm.telemetry.hook.failed` must match `llm.hook.failed`.
