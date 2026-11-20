---
'@gullabs/google': minor
'@gullabs/testing': minor
'@gullabs/any-llm': minor
---

Google refresh: `@google/genai` 3, one request per attempt, `store: false`, Gemini 4, three ids removed (ADR-048). Breaking.

**What a host must change**

- **SDK peer.** Install `@google/genai@^3.6.1` (peer of `@gullabs/google` and `@gullabs/testing`; `@gullabs/any-llm` depends on it). `^2` is no longer supported. SDK 3 needs Node 22 or later, which this library already requires.
- **Removed model ids, no alias.** `gemini-3.7-flash` (deprecated by Google and routed to 3.8 Flash): use `gemini-3.8-flash`. `gemini-2.5-pro` (routed by Google to 3.8 Flash and billed at its rates from 2026-12-01): use `gemini-3.8-flash` or a Gemini 4 model. `gemini-2.5-flash` (routed to 3.5 Flash-Lite from 2026-12-01): use `gemini-3.5-flash-lite`. A request naming one of them is now `bad_request`, their descriptors, config schemas (`Gemini25ProConfigSchema`, `Gemini25FlashConfigSchema`, `Gemini37FlashConfigSchema`), rates and grounding rates are gone, and `geminiPricingSource()` no longer prices them. Moving off a 2.5 model also means moving from `reasoning.budgetTokens` and sampling keys to `reasoning.effort` and no sampling. `gemini-2.5-flash-lite` stays.
- **Final turn.** On `gemini-3.5-flash-lite`, `gemini-3.6-flash`, `gemini-3.8-flash` and the Gemini 4 models a request whose last non-empty message is an assistant message is `bad_request` before dispatch (Google answers 400). On `gemini-3.8-flash` a final user message without non-empty text is too, unless it carries tool results. End such requests with a user turn that has text.
- **`CONTINUATION`.** A response that ends with `CONTINUATION` is returned as `finishReason: 'length'` with that response's usage and a warning; the library no longer lets the SDK resume it with more billed requests inside one attempt. Treat it like `MAX_TOKENS`.
- **Finish reasons.** `ESCALATION`, `PUP_LIMITED_DISABLED` and `MODEL_ARMOR` are now `content_filter` (they were `other`); like the other filter stops, one with no answer text and no complete tool call throws `content_filter`, not retryable.
- **Ambient settings.** The SDK client is built with `vertexai: false` and `apiVersion: 'v1beta'`: `GOOGLE_GENAI_API_VERSION`, `GOOGLE_GENAI_USE_VERTEXAI` and `GOOGLE_GENAI_USE_ENTERPRISE` have no effect (as `GOOGLE_GEMINI_BASE_URL` already had none).

**Behaviour that changes without host action**

- Every `generateContent` the adapter sends, the standard dispatch after a flex capacity error included, carries `store: false` (Google's request-level logging field; new paid-tier projects store requests by default since 2026-10-26) and `automaticContinuation: false`. That Google honours `store: false` is documented, not yet confirmed live.
- Pricing snapshot `gemini-2026-11-20` (`pricingVersion`): the existing rates were re-read and are unchanged.

**New: Gemini 4** (`gemini-4-carbon`, `gemini-4-argon`, `gemini-4-neon`, `gemini-4-hydrogen`; documented, not live-verified)

- `reasoning.effort` `low | medium | high`, plus `xhigh` on Neon and Hydrogen; without an effort the model's documented default level is sent (medium on Carbon and Argon, high on Neon and Hydrogen). No `none`, `budgetTokens`, sampling keys, `cachedContent` or `allowSchemaWithSearch`; `GoogleCacheStore.create` rejects these models.
- Structured output with a documentation-only JSON Schema profile (`pattern`, `minLength`, `maxLength`, `items: false` and the `email` format are rejected). Schema plus Search and Search with `serviceTier: 'flex'` are `bad_request`.
- `maxOutputTokens` at most 32,768 (Carbon, Argon) or 65,536 (Neon, Hydrogen). With no `timeoutMs`, an untiered or standard call gets a 20-minute deadline (`GEMINI_4_DEFAULT_TIMEOUT_MS`, exported); flex keeps 25 minutes.
- Rates per 1M tokens, flex half: Neon $3.00 / $0.15 cached / $15.00 output, Hydrogen $1.50 / $0.075 / $7.50, Carbon and Argon $4.00 / $0.20 / $20.00. Google bills Carbon and Argon at half that through 2026-11-30, so their costs are `estimated` and every attempt carries a warning saying why, until the 2026-12-01 re-snapshot. Search is $14 per 1,000 queries, and a grounded Gemini 4 call is `estimated` even with no query.
