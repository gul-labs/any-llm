---
'@gullabs/google': minor
---

Grounding audit fixes: `requireGrounding` no longer repeats billed failures, judges only a normally finished candidate, and rejects unmeasured schema + Search; query counting ignores empty strings.

- `reason: 'grounding_missing'` is `retryable: false` when an output schema is attached (the same schema + Search request missed on every captured call of five of six Gemini 3 models, so a retry repeats a billed failure) and stays `retryable: true` without a schema. Under `retryMiddleware` a schema call now makes one attempt and writes one billed row instead of three. Hosts that want to retry anyway override `shouldRetry` and accept the spend; `LlmResult.cost` of a retried success covers only the last attempt, the earlier spend is in the ledger rows.
- The `requireGrounding` check runs only on a candidate that finished with `STOP` (or no finish reason). A `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT` or `IMAGE_SAFETY` candidate with no evidence throws `content_filter` (`retryable: false`, usage attached) instead of a retryable `grounding_missing`; `MAX_TOKENS` returns `finishReason: 'length'`.
- `allowSchemaWithSearch: true` is admitted only where a capture measured the pair (`structuredOutputWithTools: false`, the six Gemini 3.x models). Gemini 2.5 and Gemma now reject schema + `googleSearch` with `bad_request` with or without the flag; make two calls. A non-boolean `allowSchemaWithSearch` or `requireGrounding` is a `bad_request` naming the field and the received type.
- `web_search_calls` and the `requireGrounding` evidence count only non-empty strings in `webSearchQueries`; a list that names no query is an unknown count (estimated cost, empty `tools` lane).

What hosts must change: stop relying on a retry after `grounding_missing` on a schema call (use the two-call recipe in `docs/grounded-structured.md`); handle `content_filter` from a `requireGrounding` call; drop `allowSchemaWithSearch` from Gemini 2.5 and Gemma calls.
