---
'@gullabs/google': minor
'@gullabs/testing': minor
---

Gemini input is priced by modality, the dead batch tier is removed, and cache handles carry their token count (ADR-039).

Gemini 2.5 Flash, 2.5 Flash-Lite and 3.1 Flash-Lite bill audio input (and cached audio) above text on the standard and flex tiers (Google's pricing page, read 2026-10-03). The adapter records `usageMetadata.promptTokensDetails` and `cacheTokensDetails` as `usage.details.input_<modality>` and `cached_<modality>`, and the pricing source bills audio tokens at the audio rates; an audio call used to be priced at the text rate and marked exact. A request with audio whose response reports no audio tokens gets a warning and, on those models, `confidence: 'estimated'`. `GEMINI_PRICED_TIERS` is `['standard', 'flex']`: the `batch` rates had no code path (no schema admits a batch tier) and are deleted, so `'batch'` is an unpriced tier. `GoogleCacheHandle.totalTokenCount` returns the create response's `usageMetadata.totalTokenCount` so a host can price cache storage. `@gullabs/testing`'s Gemini fake type gains `promptTokensDetails` and `cacheTokensDetails`.

What hosts must change: audio calls on the three models above now cost more (correctly). Remove any use of the `'batch'` tier name or the third member of `GEMINI_PRICED_TIERS`.
