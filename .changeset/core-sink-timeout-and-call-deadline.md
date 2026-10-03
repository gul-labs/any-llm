---
'@gullabs/core': minor
---

A stalled sink cannot hold a call, middleware time counts against `timeoutMs`, and a late limiter slot is released.

- `ClientConfig.sinkTimeoutMs` (default 5000) bounds each `sink.record`. On expiry the engine logs `llm.call.sink.timeout` at `error` and returns the result or error unchanged; a value that is not a finite number greater than 0 is `bad_request`.
- `timeoutMs` is armed when the call starts, so time spent in middleware counts against it. `EngineCtx.signal` is now the caller's signal merged with that deadline (it can abort with an `LlmError('timeout')` reason), and an attempt's window is what the deadline has left. A call whose middleware overruns the deadline ends with `timeout`, and a middleware that wakes later never dispatches. An attempt already in flight, sink write included, enforces the deadline itself, so a billed result is returned rather than turned into a timeout.
- When a timeout or abort wins while `rateLimiter.acquire` is pending, the engine calls the `Release` it resolves with later. `acquire` must honour the signal; this only stops a limiter that cannot cancel from leaking a slot.

What hosts must change: nothing for a sink that answers. A middleware that waits or does I/O should honour `ctx.signal`. A custom `RateLimiter.acquire` must reject when its signal fires.
