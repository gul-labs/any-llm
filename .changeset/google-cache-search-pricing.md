---
'@gullabs/google': minor
'@gullabs/testing': minor
---

A Search tool held in a `cachedContent` cache is priced, and a grounded response is never reported `exact` when the request did not declare search.

A cache created with `googleSearch` sends no search tool in the request, so the adapter recorded no `web_search_requested`, priced no fee and reported `exact`: a response with three queries cost 938 µUSD where the fee was 42,000 µUSD more.

- `GoogleCacheHandle.toolKinds` records the kinds of tool given to `create` (the keys of each `Tool`; empty when none). `providerOptions.google.cachedContent` takes the cache name or `{ cacheName, toolKinds }`; only the name goes to Google. A handle that lists `googleSearch` marks the call as a Search call like a sent tool.
- When the request declares no search (a bare cache name, or no cache at all) and the response carries `groundingMetadata`, the metadata is the evidence: `web_search_requested` is `1`, `web_search_calls` is the observed query count, the fee is priced on the `tools` lane, the cost is `estimated` and a warning says the request did not declare `googleSearch`. Metadata with no usable query leaves the tools lane empty and the cost `estimated`.
- `cachedContent` is admitted only on models with a caching capability: Gemma 4 rejects it (schema and adapter). The Gemini 2.5 and Gemma schemas no longer list `allowSchemaWithSearch`, which the adapter always rejected for them at run time.
- `FakeGoogleCacheStore` handles carry `toolKinds`, and deleting a cache that is already gone succeeds silently, as in the real store.

What hosts must change: pass `{ cacheName: handle.cacheName, toolKinds: handle.toolKinds }` as `cachedContent` when the cache holds `googleSearch` (a bare name still works and is priced from the evidence); drop `cachedContent` from Gemma calls and `allowSchemaWithSearch` from Gemini 2.5 and Gemma calls; treat the cost of a grounded response with no declared search as an estimate.
