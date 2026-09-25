---
'@gullabs/core': minor
---

`computeCost` looks up concrete rates for `(model, tier)` and no longer applies a tier multiplier. `ModelDescriptor.capabilities` gains `structuredOutputWithTools`.

Host migration: `gemini-3-flash-preview` → `gemini-3.6-flash`; `gemini-3.5-flash` → `gemini-3.6-flash`; `gpt-5.x` → `gpt-6-*`; `claude-fable-5` → `claude-fable-5-1`; `claude-opus-4-8` → `claude-opus-5-5`. Deleted ids do not resolve and are not aliased.
