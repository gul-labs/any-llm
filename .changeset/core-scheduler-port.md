---
'@gullabs/core': minor
---

`ClientConfig.scheduler?: { setTimeout, clearTimeout }` runs every wait the engine owns, so timeouts are deterministic in tests.

The attempt timeout, the logical-call deadline and the sink waits use it; so does `retryMiddleware`'s back-off (through the new `EngineCtx.scheduler`) and adapter waits (through the new optional `AdapterCtx.scheduler`). The default is the platform's timers. The deadline is still measured on `ClientConfig.clock`; the scheduler only enforces it, so it must run on the same time scale as the clock. `FakeClock` from `@gullabs/testing` implements both.

What hosts must change:

- A hand-built `EngineCtx` (a middleware unit test) adds `scheduler`.
- Nothing else: omit `scheduler` for production behaviour.
