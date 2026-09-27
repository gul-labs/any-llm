---
'@gullabs/any-llm': minor
---

Refresh the facade's Google model catalog and pricing exports with Gemini 3.6–3.8 Flash and Gemini 3.5 Flash-Lite. The facade no longer re-exports `TIER_FACTOR`; use `resolveGeminiRates(model, tier)` for concrete rates.
