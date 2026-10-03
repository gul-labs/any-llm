---
'@gullabs/core': minor
---

`Telemetry.onAttempt`, `LlmResult.callCost`, and usage and cost on `CallErrorEvent` (ADR-039).

`Telemetry.onAttempt?(AttemptEvent, span?)` fires once per provider attempt, after the attempt's ledger row went to the sink, with `attemptNumber`, `usage`, `cost` and, on failure, `errorKind`, `reason` and `retryable`. A refusal that never reached an attempt emits none. `LlmResult.callCost?: { microUsd, attempts, unpricedAttempts }` sums the library-priced amount of every attempt (retries and billed failures included) in `microUsd`, counts the attempts that began in `attempts`, and counts in `unpricedAttempts` the attempts that were dispatched but have no priced usage (a timeout, abort or connection failure with no usage, or usage that could not be priced). `unpricedAttempts > 0` means `microUsd` is a lower bound. Attempts known to cost nothing (rejected before dispatch, provider 400/401/429 and other HTTP error answers) are not counted. `result.cost` stays the successful attempt alone. `callCost` is present whenever an attempt ran. `CallSuccessEvent` and `CallErrorEvent` carry the same `callCost`; `CallErrorEvent` also gains `usage` and `cost` of the last failing attempt (when it reported usage). New exported type `CallCost`.

What hosts must change: nothing. A host that showed `result.cost` as "cost of this request" under-reported when retries billed; read `result.callCost` instead, and treat `microUsd` as a lower bound when `unpricedAttempts > 0`.
