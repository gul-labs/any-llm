---
'@gullabs/google': minor
---

Register `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, and `gemini-3.5-flash-lite` at the 2026-09-25 published rates. Delete `gemini-3-flash-preview` and `gemini-3.5-flash`. Structured output with `googleSearch` follows the descriptor flag.

Pricing-source migration: `TIER_FACTOR` is removed. Use `resolveGeminiRates(model, tier)` for concrete standard, flex, or batch rates.
`GEMINI_PRICING[model]` now contains `{ standard, flex, batch }` instead of flat rates; use `resolveGeminiRates(model, 'standard')` for a concrete standard rate.
Custom Google descriptors must list `none` in `admittedReasoningEfforts` to admit `reasoning.effort: 'none'`.
Custom Google descriptors must declare `grounding: true` to admit `googleSearch`; the adapter no longer infers that capability from a model id. Direct adapter calls now require a descriptor matching the requested provider and model. Pricing now requires an exact model id; unlisted suffix variants stay unpriced.

Host migration: use `gemini-3.6-flash` in place of the deleted `gemini-3-flash-preview` and `gemini-3.5-flash` ids. No aliases are provided.

Live `generateContent` probes admit structured JSON with `googleSearch` on all six registered Gemini 3.x models, although those structured responses did not include grounding metadata. A billed 200 with no candidate and no safety block is now retryable `server`; the failed attempt records its usage and cost. Explicit cache-create minimums are 1,024 tokens on those six models. The adapter uses `usageMetadata.serviceTier` when the provider echoes the served tier. Structured 404 `NOT_FOUND` model-access errors are non-retryable `bad_request` errors.
