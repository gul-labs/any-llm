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
- Errors: `401` and a bare `403` default to `invalid_auth`; `429`→`rate_limited`; `5xx`→`server`; timeouts; Gemini safety blocks are a 200-path `content_filter` (`promptFeedback.blockReason` / no candidates), not an HTTP 403

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

For structured output with built-in tools, follow the exact public
`generateContent` evidence: the current docs only admit that combination for
`gemini-3.1-pro-preview` and `gemini-3.5-flash`. Other models should fail early
instead of relying on adapter repair or provider-side surprises.

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
