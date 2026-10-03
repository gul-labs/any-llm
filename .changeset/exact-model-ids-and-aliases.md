---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/xai': minor
---

Model ids resolve exactly, with declared aliases (ADR-033, supersedes ADR-006).

`createModelRegistry` no longer falls back to the longest prefix, so `gemini-2.5-flash-image`, `gemini-2.5-pro-preview-tts` or a live-audio id is no longer validated, adapted and priced as the shorter text model. `ModelDescriptor` gains `aliases?: readonly string[]` for real provider version suffixes. An unknown id fails with `bad_request` listing the closest registered ids. Core exports `assertModelMatchesDescriptor(req, descriptor, adapterProvider)`, which the Google and xAI adapters now use instead of comparing `descriptor.model` to the request string: a request may name the canonical id or a declared alias. The request string is sent to the provider unchanged and recorded as sent; pricing and the rate-limiter key use the canonical descriptor.

What hosts must change:

- Requests must name a registered `model` or a declared alias. A string that relied on prefix resolution (a dated snapshot, a `-latest` suffix) is now `bad_request`: use a registered id, or add the suffix to `aliases` on a descriptor in a custom registry.
- Custom `ModelRegistry` implementations should resolve exactly; aliases must be unique within a provider and must not equal a canonical id.
