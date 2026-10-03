---
'@gullabs/core': minor
---

`LlmError.warnings` reach the failed attempt's row; a dropped ledger row is logged with the attempt's identity.

`LlmError` and `LlmErrorOptions` gain `warnings?: readonly Warning[]`. An adapter attaches notes to a failed attempt that carries `usage` (for example "the cost omits grounding fees"), and the engine writes them to that attempt's `LlmCallRecord.warnings`, as the success path already does for `AdapterResult.warnings`. The sink-failure log entry `llm.call.sink.failed` (level `error`, unchanged event name) now carries `attemptId`, `attemptNumber`, `provider` and `model` next to `callId`, so a dropped row can be found. Alert on that event: sinks stay fail-open.

What hosts must change: nothing. Custom adapters may set `warnings` on an `LlmError` that carries `usage`.
