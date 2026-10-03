---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/xai': minor
'@gullabs/testing': minor
---

Search facts in usage, a priced Gemini grounding fee, and a fail-closed `requireGrounding` (ADR-035). This replaces the Google-only `google_search_requested` marker.

Every provider now reports the same two facts in `usage.details`: `web_search_requested` (`1` when the request enabled web search) and `web_search_calls` (the observed number of searches; absent when the response does not say, `0` when the provider says none ran). Google counts query occurrences in `groundingMetadata.webSearchQueries`, so a repeated query counts each time. `@gullabs/xai` already reported `web_search_calls`; it now also sets `web_search_requested`, and reports `web_search_calls: 0` when xAI states that no server tool ran. A Gemini call that requested Search and whose response has no `groundingMetadata`, or no `webSearchQueries`, carries a warning.

`@gullabs/google` prices grounding on `cost.details.tools`: Gemini 3 charges `web_search_calls × $0.014`, Gemini 2.5 charges `$0.035` once per grounded prompt (Google's pricing page, read 2026-10-03; `pricingVersion` is now `gemini-2026-10-03`). A call that ran Search is always `cost.confidence: 'estimated'`: Google's free daily allowance is shared across a project, so every fee is charged in full. Requested with the count unknown: the tools lane is `0` and the cost is estimated. `usage.details.tool_use_prompt` records `toolUsePromptTokenCount` (Gemini 2.5) and is not priced. Whether Google bills repeated queries or tool-use tokens is not established; ADR-035 and BACKLOG say so.

`providerOptions.google.requireGrounding: true` fails the call unless `groundingMetadata` is present with at least one query: a retryable `server` error with `reason: 'grounding_missing'` and the attempt's usage attached. It needs `googleSearch` in the same request.

`providerOptions.google.allowSchemaWithSearch: true` admits `googleSearch` together with `output.jsonSchema` on a model that does not admit the pair by default, and turns `requireGrounding` on unless you pass `requireGrounding: false`. It needs both `googleSearch` and a schema, and a model with `capabilities.grounding`. A 2026-10-03 probe found no Gemini 3.x model that returned grounding metadata with a query on 3 of 4 schema calls (best: 3.1 Pro, 2 of 4), so `structuredOutputWithTools` stays `false` on all six; `docs/grounded-structured.md` has the rates.

`@gullabs/core`: `normalizeUsage` also returns `estimated` and warns when `totalTokens` is larger than `inputTokens + outputTokens` (the provider counted tokens the fields omit, as Gemini 2.5 does for Search results), and the engine reports that call's cost as `'estimated'`. `@gullabs/testing`: `fakeGeminiResponse` accepts `toolUsePromptTokenCount`.

What hosts must change:

- Read `usage.details.web_search_requested` (and `web_search_calls`) instead of `google_search_requested`. `GOOGLE_SEARCH_REQUESTED_DETAIL` is no longer exported; ledger queries on `token_details->>'google_search_requested'` become `token_details->>'web_search_requested'`.
- `cost_micro_usd` on a grounded Gemini row now includes the grounding fee. It is an estimate: it can overstate (free allowance) or understate (unknown count, unpriced tool-use tokens).
- A host that needs proof Search ran sets `requireGrounding: true` and handles `reason: 'grounding_missing'` (retryable).
