---
'@gullabs/core': minor
---

`computeCost` looks up concrete rates for `(model, tier)` and no longer applies a tier multiplier. `ModelDescriptor.capabilities` gains `structuredOutputWithTools`.

The public `ReasoningEffort` union gains `max` for CLI models whose strict schemas admit it.

`LlmRequest` and `LlmResult` gain `transientProviderState` for opaque provider continuation payloads. The engine forwards this state to and from adapters without writing it to call records or generation config; callers own secure storage when a later turn needs it. Model descriptors gain `statelessReasoningReplay` to declare which models require exact wire replay.

`LlmError` can carry provider-reported usage from a billed response that failed after HTTP success. The engine records and prices that failed attempt, including when retry middleware makes another attempt.

Pricing-source migration: supply a lookup `(model, tier) => ModelRates | undefined` that returns the concrete rates for that tier; `tier === undefined` must resolve to standard. Remove the old `tierFactors` argument from `computeCost` calls. Unknown defined tiers must return `undefined` from the lookup.
