---
'@gullabs/google': minor
---

A Gemini call that sent `googleSearch` is never priced as exact.

Grounding fees are not part of the token price and are not yet priced. Whenever a request sent `googleSearch`, the result's `cost.confidence` is `'estimated'` (the token amount is unchanged) and the result carries a warning that grounding fees are not included. The adapter flags the call with `usage.details.web_search_requested = 1`, which the Google pricing source reads. The grounding fee itself is priced by the `google-grounding-usage-priced` changeset.

What hosts must change:

- Do not treat cost on a grounded Gemini call as exact; see `google-grounding-usage-priced` for the priced grounding fee.
