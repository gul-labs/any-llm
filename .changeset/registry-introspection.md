---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/xai': minor
'@gullabs/claude-cli': minor
'@gullabs/codex-cli': minor
'@gullabs/testing': minor
---

Registry introspection (ADR-033, Amendment B).

`ModelRegistry.findByModel(model)` returns every descriptor whose canonical id or declared alias equals `model`, across providers, in registration order (empty when unknown), so a host can find a model's candidates before it has chosen a provider. `ModelRegistry.listDescriptors()` is now required. `ModelDescriptor.configKeys` is the sorted list of top-level config keys the model's schema names across all branches of a union; core exports `toConfigKeys(configSchema)` to derive it, `createModelRegistry` rejects missing or stale `configKeys`, and `assertRegistryInvariants` checks it. There is no helper that prunes a config for a model. The `strictPricing` error for registries without `listDescriptors` is deleted; `createClient` instead rejects a `modelRegistry` that lacks `resolve`, `findByModel` or `listDescriptors`.

What hosts must change:

- A custom `ModelRegistry` must implement `findByModel` and `listDescriptors` (or be built with `createModelRegistry`).
- A custom `ModelDescriptor` must add `configKeys: toConfigKeys(configSchema)`.
