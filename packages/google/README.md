# @gullabs/google

Gemini provider adapter for any-llm. A thin mapping layer over `@google/genai` that converts `ResolvedRequest` → Gemini SDK params and maps the response back to `AdapterResult`. Never persists, never computes cost, never loops — pure request/response.

## Install

```bash
pnpm add @gullabs/google @gullabs/core @google/genai
```

**Peer dependency:** `@google/genai ^1 || ^2`

## Key exports

| Export                                                                     | What it is                                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `googleProvider(opts?)`                                                    | `ProviderPlugin` factory — bundles the adapter, model descriptors, and pricing source |
| `geminiAdapter(opts?)`                                                     | Creates the `ProviderAdapter` for Gemini                                              |
| `GeminiAdapterOptions`                                                     | `{ client?: GeminiClientLike }` — inject a pre-built or fake client                   |
| `GeminiClientLike`                                                         | Structural interface the adapter depends on (satisfied by real SDK and fakes)         |
| `buildGoogleClient(auth)`                                                  | Builds the real `@google/genai` client from `AuthMaterial`                            |
| `isGeminiCapacityError(err)`                                               | Detects Gemini Flex shared-capacity errors for built-in fallback                      |
| `geminiModelDescriptors`, `gemmaModelDescriptors`, `defaultGeminiRegistry` | Built-in model descriptors + pre-built registry                                       |
| `geminiPricingSource()`, `GEMINI_PRICING`, `resolveGeminiRates`            | Built-in Gemini pricing snapshot (concrete standard / flex / batch rates)             |
| `GoogleFileStore`                                                          | Files API: upload + poll ACTIVE + delete                                              |
| `FileDeleteOptions`                                                        | `{ failClosed?, signal? }` — opt-in fail-closed delete (parity with `@gullabs/xai`)   |

## File store delete modes

`GoogleFileStore.delete` defaults to **fail-open** (errors → `onDeleteError`, resolve). Pass `{ failClosed: true }` when the host gates durable state on known success; HTTP/SDK not-found remains success (idempotent). Empty `handle.name` always throws `bad_request`.

```ts
await store.delete(handle) // fail-open
await store.delete(handle, { failClosed: true }) // throw on non-not-found failure
```

## Quick example

```ts
import { createClient, composeProviders } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'

const client = createClient({
  ...composeProviders([googleProvider()]),
})

// Auth is required per call — the library never reads environment variables.
const result = await client.generate(
  {
    provider: 'google',
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
  },
  { auth: { apiKey: 'YOUR_GEMINI_API_KEY' } },
)
```

## What it maps

- `serviceTier: 'flex'` → Gemini Flex service tier when the model descriptor supports it
- omitted `serviceTier` → provider-default request behavior
- `reasoning.includeThoughts` → `thinkingConfig.includeThoughts`; thought parts become `reasoningText`
- `reasoning.effort` → `thinkingBudget` (Gemini 2.5) or `thinkingLevel` (Gemini 3 / Gemma 4)
- `reasoning.budgetTokens` → admitted only on Gemini 2.5 budget-api models; strict descriptors reject it on level-api models
- `output.jsonSchema` → `responseMimeType: 'application/json'` + verbatim `responseSchema` when native structured output is enabled; the engine returns parsed output and `outputParsed` without validating shape
- `providerOptions.google.*` → typed provider-extension lane for admitted keys such as `cachedContent`, `safetySettings`, and exact tool declarations
- Usage: `promptTokenCount`→`inputTokens`, `candidatesTokenCount`+`thoughtsTokenCount`→`outputTokens` (GROSS)
- Errors: `401` and a bare `403` default to `invalid_auth`; `429`→`rate_limited`; `5xx`→`server`; timeouts; Gemini safety blocks are a 200-path `content_filter` when `promptFeedback.blockReason` is set. A candidate-less 200 without a block reason is retryable `server`.

## Strict model-config expectations

This adapter expects config that has already been parsed through the selected
descriptor boundary:

- `descriptor.configSchema` is the runtime source of truth.
- `descriptor.configJsonSchema` is the derived form/UI schema.
- `providerOptions.google` is not a caller-wins override lane for
  `serviceTier`, sampling, reasoning, or response schema.
- `priority` stays rejected even though Google documents it, because the
  library has not yet shipped the matching schema, pricing, served-tier
  recording, and tests.

The Developer API accepted structured JSON plus `googleSearch` on all registered
Gemini 3.x models in the 2026-09-26 live probes. The structured responses did
not include `groundingMetadata`, even when asked to search; callers must not
assume that an accepted tool means Search ran or that citations are available.

## Registered models

| id                       | Efforts                         | SO + search | caching.minTokens | Tiers          |
| ------------------------ | ------------------------------- | ----------- | ----------------- | -------------- |
| `gemini-2.5-pro`         | `low`, `medium`, `high`         | no          | 2048              | flex, standard |
| `gemini-2.5-flash`       | `none`, `low`, `medium`, `high` | no          | 2048              | flex, standard |
| `gemini-2.5-flash-lite`  | `none`, `low`, `medium`, `high` | no          | 2048              | flex, standard |
| `gemini-3.1-pro-preview` | `low`, `medium`, `high`         | yes         | 1024              | flex, standard |
| `gemini-3.1-flash-lite`  | `none`, `low`, `medium`, `high` | yes         | 1024              | flex, standard |
| `gemini-3.5-flash-lite`  | `none`, `low`, `medium`, `high` | yes         | 1024              | flex, standard |
| `gemini-3.6-flash`       | `none`, `low`, `medium`, `high` | yes         | 1024              | flex, standard |
| `gemini-3.7-flash`       | `low`, `medium`, `high`         | yes         | 1024              | flex, standard |
| `gemini-3.8-flash`       | `low`, `medium`, `high`         | yes         | 1024              | flex, standard |
| `gemma-4-31b-it`         | `none`, `high`                  | no          | n/a               | none           |
| `gemma-4-26b-a4b-it`     | `none`, `high`                  | no          | n/a               | none           |

All six Gemini 3.x cache-create minimums above were live checked: 103 tokens
returned `min_total_token_count=1024`; exactly 1024 tokens succeeded.
Google's 4096-token table in the caching guide describes **implicit** caching;
this column is the **explicit cache-create** floor.

`gemini-3.7-flash` and `gemini-3.8-flash` never emit `thinkingLevel` MINIMAL.
`gemini-3-flash-preview` and `gemini-3.5-flash` are deleted and are not aliased.
Migrate both to `gemini-3.6-flash`. `servedServiceTier` reads the provider's
`usageMetadata.serviceTier` echo when present, then falls back to the tier
actually dispatched when the echo is absent.
An echo that differs from the requested tier emits a warning so callers can
see a provider-side remap. `flexFallback: false` disables the adapter's retry
at standard tier; it cannot prevent a provider-side remap after dispatch.
A candidate-less HTTP 200 without a safety block is a retryable provider error;
its reported usage and snapshot cost are saved on that failed attempt.

## Gemma 4

The default registry includes two API-verified Gemma 4 models: `gemma-4-31b-it`
and `gemma-4-26b-a4b-it`. Both route through this adapter and support:

- **Native structured output** — `responseMimeType` + verbatim `responseSchema` are sent
  automatically when `output.jsonSchema` is set.
- **Grounding** — `tools:[{googleSearch:{}}]` via `providerOptions.google`.
- **Vision** — `inline-media` and `file-uri` multimodal message parts.
- **Thinking** — `reasoning.effort` maps to `thinkingLevel` (`reasoningApi: 'level'`).
  Gemma 4 thinking is binary: only `effort: 'none'` (MINIMAL) and `effort: 'high'`
  (HIGH) are accepted. Passing `effort: 'low'` or `effort: 'medium'` is rejected at
  validation time with a `bad_request` error because the model only supports MINIMAL
  and HIGH `thinkingLevel` values. Note: `thinkingBudget` is **not** supported
  (rejected by the API with HTTP 400).
- **Tunable sampling** — `temperature`, `topP`, `topK` are accepted.

This follows the library-wide **reject, don't map** rule: unsupported or incorrect input throws a
typed `bad_request` `LlmError` at validation time rather than being silently clamped or coerced
into something the model happens to accept.

Gemma 4 models are intentionally unpriced (`cost.microUsd` will be `null`), and
the strict contract does not admit any `serviceTier` for them until the public
docs and live evidence line up on that field.

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`docs/grounded-structured.md`](../../docs/grounded-structured.md) — the recommended two-call Gemini grounding → structured-output recipe
- [`docs/multi-runtime.md`](../../docs/multi-runtime.md) — web route + Temporal worker integration pattern, auth, metadata, and retry ownership
- [`@gullabs/core` README](../core/README.md) — engine, ports, and the `LlmError` contract
