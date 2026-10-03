---
'@gullabs/google': minor
---

A Gemini call that sent `googleSearch` is never priced as exact.

Grounding fees are not part of the token price and are not yet priced. Whenever a request sent `googleSearch`, the result's `cost.confidence` is `'estimated'` (the token amount is unchanged) and the result carries a warning that grounding fees are not included. The adapter flags the call with a synthetic `usage.details.google_search_requested = 1` entry, which the Google pricing source reads; it is adapter-owned, not a provider field.

What hosts must change:

- Do not treat cost on a grounded Gemini call as complete. Add the grounding charge from your billing console, or budget for it separately.
