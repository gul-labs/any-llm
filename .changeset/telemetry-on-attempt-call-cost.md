---
'@gullabs/core': minor
---

`Telemetry.onAttempt`, `LlmResult.callCost`, and usage and cost on `CallErrorEvent` (ADR-039).

`Telemetry.onAttempt?(AttemptEvent, span?)` fires once per provider attempt, after the attempt's ledger row went to the sink, with `attemptNumber`, `usage`, `cost` and, on failure, `errorKind`, `reason` and `retryable`. A refusal that never reached an attempt emits none. `LlmResult.callCost?: { microUsd, attempts }` sums the library-priced amount of every attempt (retries and billed failures included) and counts the attempts that ran; `result.cost` stays the successful attempt alone. `callCost` is absent when no attempt was priced or any attempt that reported usage was unpriced. `CallErrorEvent` gains `usage` and `cost` of the last failing attempt (when it reported usage) and the same `callCost`.

What hosts must change: nothing. A host that showed `result.cost` as "cost of this request" under-reported when retries billed; read `result.callCost` instead.
