# @gullabs/xai

xAI Grok provider adapter for any-llm. A thin mapping layer over the `openai` npm SDK's Responses API pointed at xAI's `https://api.x.ai/v1` base URL — converts `ResolvedRequest` → xAI Responses API params and maps the response back to `AdapterResult`. Never persists, never computes cost itself outside the pricing port, never loops — pure request/response.

## Install

```bash
pnpm add @gullabs/xai @gullabs/core openai  # peer: openai ^6 || ^7
```

**Peer dependency:** `openai ^6 || ^7`

xAI has no first-party TypeScript SDK. xAI's own quickstart recommends using the `openai` npm package with a `baseURL` override pointed at xAI's endpoint — that is the path this adapter takes. `buildXaiClient` is the only place in `packages/xai/src` that imports `openai`, so the rest of the adapter (and its tests) stay decoupled from the real SDK via the structural `XaiClientLike` interface.

## Key exports

| Export                  | What it is                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `xaiProvider(opts?)`    | `ProviderPlugin` factory — bundles the adapter, `grok-4.5` / `grok-4.6` / `grok-4.7` descriptors, and pricing source |
| `xaiAdapter(opts?)`     | Creates the `ProviderAdapter` for xAI                                                                                |
| `XaiAdapterOptions`     | `{ client?: XaiClientLike }` — inject a pre-built or fake client                                                     |
| `XaiClientLike`         | Structural interface the adapter depends on (satisfied by real SDK and fakes)                                        |
| `buildXaiClient(auth)`  | Builds the real `openai`-SDK-backed client from `AuthMaterial`, pointed at xAI's base URL                            |
| `classifyXaiError(err)` | Classifies a raw thrown error into a typed `LlmError`, including xAI's 400-for-auth quirk                            |
| `grok45ModelDescriptor` | The `grok-4.5` `ModelDescriptor`                                                                                     |
| `grok46ModelDescriptor` | The `grok-4.6` `ModelDescriptor`                                                                                     |
| `xaiModelDescriptors`   | Every model descriptor this package contributes (`grok-4.5`, `grok-4.6`, `grok-4.7`)                                 |
| `xaiRegistry`           | Pre-built `ModelRegistry` over `xaiModelDescriptors`                                                                 |
| `xaiPricingSource()`    | Built-in xAI `PricingSource` port implementation, backed by `XAI_PRICING`                                            |
| `XAI_PRICING`           | Frozen xAI pricing snapshot (µUSD per million tokens)                                                                |
| `XaiModelRates`         | Per-model rate entry type (`inputPerM`, `cachedPerM`, `outputPerM`, optional `gt200k`)                               |
| `Grok45ConfigSchema`    | Strict Zod config schema for `grok-4.5`                                                                              |
| `Grok46ConfigSchema`    | Strict Zod config schema for `grok-4.6`                                                                              |
| `XaiProviderOptions`    | `{ promptCacheKey? }` — typed `providerOptions.xai` extension shape                                                  |
| `XaiFileStore`          | Files API store: upload (TTL), get, list, idempotent delete, content                                                 |
| `XaiFileHandle`         | `{ id, filename?, bytes?, expiresAt?, … }` returned by the store                                                     |
| `FileDeleteOptions`     | `{ failClosed?, signal? }` — opt-in fail-closed delete for durable release gates                                     |
| `XAI_FILE_TTL_*`        | TTL bounds (`3600`…`2592000` seconds) and `XAI_FILE_MAX_BYTES` (48 MiB)                                              |

## Quick example

```ts
import { createClient, composeProviders } from '@gullabs/core'
import { xaiProvider } from '@gullabs/xai'

const client = createClient({
  ...composeProviders([xaiProvider()]),
})

// Auth is required per call — the library never reads environment variables.
const result = await client.generate(
  {
    provider: 'xai',
    model: 'grok-4.6',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
  },
  { auth: { apiKey: 'YOUR_XAI_API_KEY' } },
)
```

### Function-calling seam (no agent loop)

```ts
const tools = [
  {
    name: 'get_temperature',
    description: 'Get current temperature for a location',
    inputJsonSchema: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location'],
    },
  },
]

const first = await client.generate(
  {
    provider: 'xai',
    model: 'grok-4.6',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Temperature in SF?' }] }],
    tools,
    toolChoice: 'required',
  },
  { auth: { apiKey: 'YOUR_XAI_API_KEY' } },
)
// first.finishReason === 'tool_calls'
// first.toolCalls === [{ toolCallId, toolName, args }]

const call = first.toolCalls![0]!
const replay = await client.generate(
  {
    provider: 'xai',
    model: 'grok-4.6',
    messages: [
      { role: 'user', parts: [{ kind: 'text', text: 'Temperature in SF?' }] },
      {
        role: 'assistant',
        parts: [
          {
            kind: 'tool-call',
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            args: call.args,
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            kind: 'tool-result',
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            result: { temperature: 59 },
          },
        ],
      },
    ],
    tools,
  },
  { auth: { apiKey: 'YOUR_XAI_API_KEY' } },
)
// replay.text — model answer after the host dispatched the tool
```

## grok-4.5, grok-4.6, and grok-4.7

The default registry ships two canonical models (500k token context window each). They route through this adapter and support:

- **Reasoning** — level-api (`reasoningApi: 'level'`), mapped to the Responses API `reasoning.effort` field. There is no `budgetTokens` field (xAI uses level-style reasoning) — passing it throws `bad_request`. The schema does not set a default effort; if `reasoning` is omitted, no `reasoning` field is sent and xAI's own server-side default (`high`) applies.
  - `grok-4.5`: `admittedReasoningEfforts: ['low', 'medium', 'high']` (live-verified 2026-08-24; `'medium'` is now accepted). `'none'` and `'xhigh'` are rejected. `'none'` remains rejected ("reasoning cannot be disabled").
  - `grok-4.6`: `admittedReasoningEfforts: ['low', 'medium', 'high', 'xhigh']` (live-verified 2026-08-12). `'none'` is rejected by the live API.
- **Structured output** — native. `output.jsonSchema` maps to the Responses API's `text.format` field with `{ type: 'json_schema', name, schema, strict: true }`, **not** `response_format` — this differs from OpenAI's own convention for the same underlying concept.
- **`strict: true` performs no OpenAI-style compile-time schema validation, as of the 2026-07-09 live probes.** 2026-07-09 live verification against the real xAI Responses API — 13 single-variant probes plus 1 combined probe (14 calls total, all accepted HTTP 200; the combined probe is recorded as fixture `10-non-strict-schema-accepted.json`) — verified that `text.format` with `strict: true` accepted every one of the following schema shapes that OpenAI's own strict mode rejects at compile time: schemas (root and nested) missing `additionalProperties: false`; properties omitted from `required` (optional properties); `format`, `minLength`, `pattern`, and `default` keywords; `anyOf`; `$defs`/`$ref`; `enum`/`const`; and nullable unions (`type: [T, 'null']`). `strict: false` on the same surface showed no observed behavioral divergence from `strict: true`. This adapter forwards schemas to xAI verbatim — no rewriting, no preflight validation, and no injection of `additionalProperties: false` or `required` completion — so OpenAI-strict schema rewriting (including `@gullabs/codex-cli`'s `toOpenAiStrictOutputSchema` helper) is unnecessary for xai as of that verification date. (Reject-don't-map still applies to genuinely invalid input the xai schema/types layer itself rejects; this note is only about strict-mode compile-time schema-shape enforcement.) `packages/xai/src/__fixtures__/10-non-strict-schema-accepted.json` records one live example combining three of these — missing root `additionalProperties: false`, an optional property, and a `format` keyword — in a single accepted call.
- **Sampling** — `temperature` and `topP` are forwarded verbatim. No `topK`.
- **No penalties/stop** — `presence_penalty`, `frequency_penalty`, and `stop` are not in the config schema at all; xAI hard-rejects these on reasoning models, so the schema never admits them (reject-don't-map).
- **Service tiers** — `grok-4.5`, `grok-4.6`, and `grok-4.7` admit `serviceTier: 'priority'` only (Responses `service_tier: "priority"`, live-verified 2026-08-12). `'flex'` / `'standard'` / `'batch'` are rejected — xAI silently remaps unknown tiers to `default`, so this library never forwards them.

## Files store (`XaiFileStore`)

Thin REST wrapper over xAI Files (`POST/GET/DELETE /v1/files`). Auth is injected — the store never reads `process.env`.

```ts
import { XaiFileStore } from '@gullabs/xai'

const store = new XaiFileStore({
  auth: { apiKey: 'YOUR_XAI_API_KEY' },
  // Optional: onDeleteError, logger, fetch, baseUrl
})

const handle = await store.upload({
  data: pdfBytes,
  filename: 'document.pdf',
  mimeType: 'application/pdf',
  expiresAfterSeconds: 86_400, // 24h; range 3600…2592000
})

// Attach on generate via core FileRefPart:
// { kind: 'file-ref', fileId: handle.id }

await store.delete(handle.id) // default fail-open; 404 = success
await store.delete(handle.id) // safe to call twice

// Durable gate (Temporal release / orphan sweep) — mark DB only after success:
try {
  await store.delete(handle.id, { failClosed: true })
  await db.markReleased(handle.id)
} catch (err) {
  // leave released_at null; do not rethrow from workflow finally
  logger.warn({ err }, 'delete failed')
}
```

| Behavior                    | Detail                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TTL                         | `expiresAfterSeconds` validated client-side; multipart sends `expires_after` **before** `file` (xAI requirement)                                                                                              |
| Delete (default)            | Fail-open: non-404 errors call `onDeleteError` and resolve; 404 is silent success                                                                                                                             |
| Delete (`failClosed: true`) | Non-404 failures **throw** `LlmError`; `onDeleteError` is not called. Prefer **per-id** delete + markReleased when writing durable release state — fail-closed `deleteAll` does not cancel in-flight siblings |
| Empty `fileId`              | Always throws `bad_request` (both modes)                                                                                                                                                                      |
| Storage cost                | ~$0.025/GiB/day — **not** injected into `computeCost` token lanes                                                                                                                                             |
| ZDR teams                   | New uploads and `file_id` attachments are blocked by xAI; errors mention Zero Data Retention when detectable                                                                                                  |
| Max size                    | 48 MiB (conservative vs docs 48–50 MB)                                                                                                                                                                        |

**Hidden input tokens:** grok-4.5, grok-4.6, and grok-4.7 bill about 1.3k hidden input tokens per request (1,532 for a one-line prompt versus 208 in July; cached on repeats).

**grok-4.7 replay:** the adapter sends `store: false` and replays function-call items unchanged. A live P-X3 fixture for grok-4.7 reasoning replay was not captured, so no fixture values were invented.

**Billing note:** attaching files on Responses implicitly enables xAI's `attachment_search` agentic tool. `web_search_calls` is billed per call. Since 2026-09-21, x_search is billed from `x_posts_fetched` and `x_users_fetched`, not `x_search_calls`. The attachment_search counter is **not** live-pinned (P-X2); a `file-ref` call sets synthetic `usage.details.attachment_search_unpinned = 1` and `Cost.confidence: 'estimated'`. A missing x_search item counter unprices the whole call.

**Host tests:** `@gullabs/testing` exports `FakeXaiFileStore` (in-memory upload/get/delete with optional TTL clock and `failClosed`).

## Vision constraints

Both models accept image input as an `inline-media` or `file-uri` `Part`, and document attachments as a `file-ref` `Part`:

- **`inline-media`** — only `image/jpeg` and `image/png` are accepted; anything else throws `bad_request`. The decoded payload must be at most 20 MiB (xAI's documented inline-image ceiling); larger images throw `bad_request` before the request is sent.
- **`file-uri`** — only accepted when the URI is a public `http(s)://` URL **and** the declared `mimeType` is jpg/png. A provider-hosted URI from another provider — for example a Gemini Files API URI (`https://generativelanguage.googleapis.com/...`) — is technically `https://` but is not dereferenceable by xAI and is not portable across providers. The adapter rejects it rather than trying to map or proxy it (reject-don't-map).
- **`file-ref`** — maps to Responses `{ type: 'input_file', file_id }`. Upload first with `XaiFileStore`, then pass `{ kind: 'file-ref', fileId: handle.id }`. Empty ids throw `bad_request`.
- **Undocumented minimum size** — xAI enforces an undocumented server-side minimum image size (observed ~8px/side, ~512 total px). This adapter does **not** pre-validate pixel dimensions; a too-small image surfaces as a live `bad_request` error from the xAI API itself, classified normally by `classifyXaiError`, not rejected client-side.

## Caching

xAI caching is automatic — there is no explicit cache-create/cache-store API comparable to Gemini's Context Cache. `providerOptions.xai.promptCacheKey` maps to the Responses API's `prompt_cache_key` field and is strongly recommended for reliable cache routing across calls to the same conversation/context.

## Pricing

`XAI_PRICING` is a frozen, versioned snapshot (`xaiPricingVersion: 'xai-2026-08-24'`) — a point-in-time capture from `/v1/models`, not a live lookup (ADR-005). Rates are in µUSD per million tokens. Tool invocations add `Cost.details.tools` (`microUsd = input + cached + output + tools`):

| Counter (raw `usage.details` key) | Rate                 |
| --------------------------------- | -------------------- |
| `web_search_calls`                | $5 / 1,000 calls     |
| `x_posts_fetched`                 | $5 / 1,000 posts     |
| `x_users_fetched`                 | $10 / 1,000 profiles |

Enable Live Search with `providerOptions.xai.tools` (`web_search` / `x_search`). Citations land on `result.citations`. `countTokens` uses `POST /v1/tokenize-text` and returns `accuracy: 'lower-bound'` (text parts only; media / file parts are `bad_request`).

| Model      | Tier                         | Input   | Cached input | Output   |
| ---------- | ---------------------------- | ------- | ------------ | -------- |
| `grok-4.5` | standard (<200k gross input) | $2.00/M | $0.30/M      | $6.00/M  |
| `grok-4.5` | `gt200k` (≥200k gross input) | $4.00/M | $0.60/M      | $12.00/M |
| `grok-4.6` | standard (≤200k gross input) | $2.00/M | $0.50/M      | $6.00/M  |
| `grok-4.6` | `gt200k` (≥200k gross input) | $4.00/M | $1.00/M      | $12.00/M |

The `gt200k` long-context tier is selected by **gross** `inputTokens` (including cached), not billable input — at or above 200,000 tokens (`long_context_threshold`). The adapter now surfaces the echoed Responses `service_tier` (`'default'` or `'priority'`), so `price()` receives that served value instead of `undefined`. Custom xAI `PricingSource` implementations must price `'default'` at the standard list. Built-in `xaiPricingSource().price()` prices `grok-4.6` + `tier: 'priority'` at 2× every token type after the cache discount: uncached standard-list 2× is confirmed by fixture `12-grok-4-6-xhigh-priority.json` `cost_in_usd_ticks`; cached and `gt200k` legs follow the official 2×-after-cache-discount rule. `grok-4.5` and `grok-4.6` both price `priority` at 2×. `fast` is not admitted. Any other defined tier is unpriced (`microUsd: null`). Standard list rates are pinned to `packages/xai/src/__fixtures__/14-v1-models-pricing.json` (live `GET /v1/models` 2026-08-12).

## EU unavailability

xAI has no EU region at launch — its documented regions are `us-east-1` and `us-west-2` only. This is a hosting/deployment concern for callers, not something this library can route around; it is documented here so consumers are not surprised by data-residency constraints.

## Aliases are not registered

xAI's own `/v1/models` listing surfaces `grok-4.5-latest` and `grok-build-latest` as aliases of `grok-4.5`. `grok-4.6` has no aliases as of 2026-08-12. Aliases are not registered as `ModelDescriptor`s or `XAI_PRICING` keys. Callers must use the canonical id verbatim — passing an alias resolves to "model not found" (reject-don't-map).

## Explicitly deferred (not built in v1)

- Server-side agentic tools as an explicit API (`web_search`, `x_search`, `code_interpreter`, collections search, remote MCP) and their per-invocation billing lanes in `computeCost`. Note: **file attachments still auto-enable `attachment_search`** on xAI's side — that implicit tool is documented above, not modeled as a first-class library tool surface.
- `/v1/chat/completions` (documented by xAI as legacy) and `/v1/messages` (the Anthropic-compatible migration shim) — this adapter only targets `/v1/responses`.
- Batch API (`grok-4.5` is not eligible at launch) and image generation models.
- Stateful conversations — `store` is always sent as `false`, and `previous_response_id` is not supported.
- Streaming — core has no streaming seam at all yet; this is a library-wide gap, not specific to xai.

## What it maps

- `providerOptions.xai.promptCacheKey` → `prompt_cache_key`
- `reasoning.effort` → `reasoning.effort` (per-model admitted set)
- `serviceTier: 'priority'` → `service_tier: 'priority'` (`grok-4.6` only)
- `output.jsonSchema` → `text.format: { type: 'json_schema', name, schema, strict: true }`
- Usage: `usage.input_tokens` → `inputTokens`, `usage.output_tokens` → `outputTokens` (both already GROSS on xAI, unlike Gemini's sub-field summation); numeric extras (`num_sources_used`, `cost_in_usd_ticks`, etc.) surface into `usage.details` under their raw names, and the full raw payload is always in `usage.raw`
- Errors: HTTP status is a hint. `classifyXaiError` inspects the STRUCTURED parsed body only — never free-form `Error.message`. Two recorded overlays: HTTP **400** whose body starts with `"Incorrect API key provided"` (prefix only; the SDK may drop `code`) → `invalid_auth`; HTTP **403** whose body starts with `"Content violates usage guidelines"` (e.g. `SAFETY_CHECK_TYPE_*`) → `content_filter`. A bare 403 without that body stays `invalid_auth`. Any other 400, `429`→`rate_limited`, `5xx`→`server`, and timeouts fall through to `@gullabs/core`'s generic `classifyError`.

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`@gullabs/core` README](../core/README.md) — engine, ports, and the `LlmError` contract
