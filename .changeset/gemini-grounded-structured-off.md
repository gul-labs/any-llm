---
'@gullabs/google': minor
---

Structured output plus `googleSearch` is off on every Gemini 3.x model.

All six Gemini 3.x descriptors now set `structuredOutputWithTools: false`. The provider accepts the request, but live probes showed Flash-Lite models skipping Search and no model returning `groundingMetadata` with a response schema, so an accepted request does not show that Search ran. A request that sets `output.jsonSchema` together with `providerOptions.google.tools: [{ googleSearch: {} }]` now fails with `bad_request` before any network call, and the message names the two-call recipe in `docs/grounded-structured.md`.

What hosts must change:

- Replace a grounded + structured call on Gemini with two calls: grounded research with `googleSearch` and no schema, then structured synthesis with `output.jsonSchema` and no `googleSearch`. Both calls keep their own ledger rows.
