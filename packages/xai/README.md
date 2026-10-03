# @gullabs/xai

xAI Grok provider adapter for any-llm. A thin mapping layer over the `openai` npm SDK's Responses API pointed at xAI's `https://api.x.ai/v1` base URL — converts `ResolvedRequest` → xAI Responses API params and maps the response back to `AdapterResult`. Never persists, never computes cost itself outside the pricing port, never loops — pure request/response.

## Install

```bash
pnpm add @gullabs/xai @gullabs/core openai  # peer: openai ^7
```

**Peer dependency:** `openai ^7`

xAI has no first-party TypeScript SDK. xAI's own quickstart recommends using the `openai` npm package with a `baseURL` override pointed at xAI's endpoint — that is the path this adapter takes. `buildXaiClient` is the only place in `packages/xai/src` that imports `openai`, so the rest of the adapter (and its tests) stay decoupled from the real SDK via the structural `XaiClientLike` interface.

## Key exports

| Export                             | What it is                                                                                                           |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `xaiProvider(opts?)`               | `ProviderPlugin` factory — bundles the adapter, `grok-4.5` / `grok-4.6` / `grok-4.7` descriptors, and pricing source |
| `xaiAdapter(opts?)`                | Creates the `ProviderAdapter` for xAI                                                                                |
| `XaiAdapterOptions`                | `{ client?, transport? }` — inject a pre-built or fake client, or a `fetch` transport for long calls                 |
| `XaiTransport`                     | `{ fetch, fetchOptions? }` — host transport passed to the SDK client (see "Long calls and timeouts")                 |
| `XAI_DEFAULT_TIMEOUT_MS`           | SDK deadline when `timeoutMs` is unset: 3 600 000 ms (one hour)                                                      |
| `XAI_TIMEOUT_BUFFER_MS`            | Added to `timeoutMs` for the SDK deadline: 5 000 ms                                                                  |
| `XaiClientLike`                    | Structural interface the adapter depends on (satisfied by real SDK and fakes)                                        |
| `buildXaiClient(auth, transport?)` | Builds the real `openai`-SDK-backed client from `AuthMaterial`, pointed at xAI's base URL                            |
| `classifyXaiError(err)`            | Classifies a raw thrown error into a typed `LlmError`, including xAI's 400-for-auth quirk                            |
| `grok45ModelDescriptor`            | The `grok-4.5` `ModelDescriptor`                                                                                     |
| `grok46ModelDescriptor`            | The `grok-4.6` `ModelDescriptor`                                                                                     |
| `grok47ModelDescriptor`            | The `grok-4.7` `ModelDescriptor`                                                                                     |
| `xaiModelDescriptors`              | Every model descriptor this package contributes (`grok-4.5`, `grok-4.6`, `grok-4.7`)                                 |
| `xaiRegistry`                      | Pre-built `ModelRegistry` over `xaiModelDescriptors`                                                                 |
| `xaiPricingSource()`               | Built-in xAI `PricingSource` port implementation, backed by `XAI_PRICING`                                            |
| `XAI_PRICING`                      | Frozen xAI pricing snapshot (µUSD per million tokens)                                                                |
| `XaiModelRates`                    | Per-model rate entry type (`inputPerM`, `cachedPerM`, `outputPerM`, optional `gt200k`)                               |
| `Grok45ConfigSchema`               | Strict Zod config schema for `grok-4.5`                                                                              |
| `Grok46ConfigSchema`               | Strict Zod config schema for `grok-4.6`                                                                              |
| `Grok47ConfigSchema`               | Strict Zod config schema for `grok-4.7`                                                                              |
| `XaiProviderOptions`               | Typed `providerOptions.xai` shape for cache key, search tools, tool choice, turn cap, and parallel calls             |
| `XaiFileStore`                     | Files API store: upload (TTL), get, list, idempotent delete, content                                                 |
| `XaiFileHandle`                    | `{ id, filename?, bytes?, expiresAt?, … }` returned by the store                                                     |
| `FileDeleteOptions`                | `{ failClosed?, signal? }` — opt-in fail-closed delete for durable release gates                                     |
| `XAI_FILE_TTL_*`                   | TTL bounds (`3600`…`2592000` seconds) and `XAI_FILE_MAX_BYTES` (48 MiB)                                              |

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
      first.message, // grok-4.6 continues by history: append the assistant message as returned
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

**Two continuation rules.** `result.continuation` says which one a model uses, and
`result.message` is the ordered assistant message (text and calls in provider order; reasoning and
server-tool items are not in it):

- `'history'` (grok-4.5, grok-4.6): append `result.message` and send the full history, as above.
- `'state'` (grok-4.7): send **only the new messages** plus `result.transientProviderState`, and do
  not replay `result.message`. The loop:

```ts
const base = { provider: 'xai', model: 'grok-4.7', tools } as const
let messages: Message[] = [
  { role: 'user', parts: [{ kind: 'text', text: 'Temperature in SF?' }] },
]
let state: JsonValue | undefined

for (;;) {
  const result = await client.generate(
    {
      ...base,
      messages,
      ...(state !== undefined ? { transientProviderState: state } : {}),
    },
    { auth: { apiKey: 'YOUR_XAI_API_KEY' } },
  )
  if (result.toolCalls === undefined) break // result.text is the answer
  messages = [
    {
      role: 'user',
      parts: result.toolCalls.map((c) => ({
        kind: 'tool-result' as const,
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        result: { temperature: 59 }, // run the tool
      })),
    },
  ]
  state = result.transientProviderState // required for 'state' continuation
}
```

`@gullabs/testing`'s `runToolLoop` follows `result.continuation` for you in host tests. Use the same
`model` string on every turn (an alias included).

## grok-4.5, grok-4.6, and grok-4.7

The default registry ships three canonical models (500k token context window each). They route through this adapter and support:

- **Reasoning** — level-api (`reasoningApi: 'level'`), mapped to the Responses API `reasoning.effort` field. There is no `budgetTokens` field (xAI uses level-style reasoning) — passing it throws `bad_request`. The schema does not set a default effort; if `reasoning` is omitted, no `reasoning` field is sent and xAI's own server-side default (`high`) applies.
  - `grok-4.5`: `admittedReasoningEfforts: ['low', 'medium', 'high']` (live-verified 2026-08-24; `'medium'` is now accepted). `'none'` and `'xhigh'` are rejected. `'none'` remains rejected ("reasoning cannot be disabled").
  - `grok-4.6` and `grok-4.7`: `admittedReasoningEfforts: ['low', 'medium', 'high', 'xhigh']`. `'none'` is rejected.
- **Structured output** — native. `output.jsonSchema` maps to the Responses API's `text.format` field with `{ type: 'json_schema', name, schema, strict: true }`, **not** `response_format` — this differs from OpenAI's own convention for the same underlying concept.
- **Structured output with built-in search** — admitted on all three models (`grok-4.6` in fixture 18; `grok-4.5` and `grok-4.7` live-verified 2026-10-02 in fixture 32). The adapter rejects this combination on descriptors without `structuredOutputWithTools`.
- **Output and tool schemas are standard JSON Schema, and only the keywords xAI enforces are accepted (ADR-034).** A nullable field lists `'null'` in `type` (`type: ['string', 'null']`). The adapter rejects the OpenAPI `nullable` keyword, uppercase type names (`STRING`, `OBJECT`), and any keyword xAI would accept but not enforce, with `bad_request` before dispatch, naming the path (`output.jsonSchema...` or `tools[i].inputJsonSchema...`), and never rewrites a schema. Per xAI's structured-outputs guide (read 2026-10-03): `oneOf` behaves as `anyOf` (rejected, use `anyOf`); `allOf`, `not`, `if`/`then`/`else`, `multipleOf`, `uniqueItems`, `patternProperties` and any `propertyNames` other than `{ type: 'string' }` (what `z.record(z.string(), X)` emits; it constrains nothing and is accepted) are rejected; `$ref` / `$defs` are accepted **non-circular only**, so a recursive schema (Zod's recursive type emits `$ref: '#'`) is rejected; `format` is accepted for `date`, `time`, `date-time`, `email`, `uuid`, `ipv4`, `ipv6` and `uri`; `minLength`/`maxLength` up to 2,048, `minItems`/`maxItems` up to 256 and `minProperties`/`maxProperties` up to 64 are enforced and a larger value is rejected; `pattern` must stay inside xAI's regex subset (no lookaround, backreferences, property escapes anywhere including inside a character class such as `[\p{L}]`, word boundaries or inline modifiers); `items: false` (Zod's `z.tuple`) is undocumented and rejected. `const`, `enum`, `anyOf`, `prefixItems`, `exclusiveMinimum`/`exclusiveMaximum` and `additionalProperties` are accepted, and annotations always are. Zod's `z.literal` emits `const`, which xAI accepts; it is outside the portable subset only because Google ignores it. Lint a schema that must also run on Gemini 3.x with `assertPortableJsonSchema` from `@gullabs/core` (it does not cover Gemma's stricter profile). Malformed schemas (a value in a schema position that is not a schema, `maxLength: '3000'`, an invalid `pattern`, a cyclic JavaScript object, nesting deeper than 128) are `bad_request` with the path. Evidence gaps: the guide does not list `properties`, `required`, `items` or `prefixItems` as keywords, and no xAI capture exercised `additionalProperties` as a schema (or Zod's `additionalProperties: {}`); those are forwarded on the strength of the documented types and the `additionalProperties` entry. Zod's `startsWith`, `endsWith` and `includes` emit a non-standard `format` next to a `pattern`; the `format` is rejected, so chain `.meta({ format: undefined })` after the check or write `z.string().regex(...)`. Live on 2026-10-02 (fixture 34): xAI accepted `nullable: true` and ignored it on all three models, so the model could not return `null` and wrote `""`, `0` or the string `"null"`; uppercase type names failed at xAI with HTTP 400.
- **`strict: true` performs no OpenAI-style compile-time schema validation, as of the 2026-07-09 live probes.** 2026-07-09 live verification against the real xAI Responses API — 13 single-variant probes plus 1 combined probe (14 calls total, all accepted HTTP 200; the combined probe is recorded as fixture `10-non-strict-schema-accepted.json`) — verified that `text.format` with `strict: true` accepted every one of the following schema shapes that OpenAI's own strict mode rejects at compile time: schemas (root and nested) missing `additionalProperties: false`; properties omitted from `required` (optional properties); `format`, `minLength`, `pattern`, and `default` keywords; `anyOf`; `$defs`/`$ref`; `enum`/`const`; and nullable unions (`type: [T, 'null']`). `strict: false` on the same surface showed no observed behavioral divergence from `strict: true`. This adapter forwards schemas to xAI verbatim — no rewriting, no OpenAI-strict preflight, and no injection of `additionalProperties: false` or `required` completion — so OpenAI-strict schema rewriting (including `@gullabs/codex-cli`'s `toOpenAiStrictOutputSchema` helper) is unnecessary for xai as of that verification date. The preflight added since is the dialect and enforced-keyword check in the bullet above; "accepted" in those probes meant HTTP 200, not that xAI enforced the keyword. (Reject-don't-map still applies to genuinely invalid input the xai schema/types layer itself rejects; this note is only about strict-mode compile-time schema-shape enforcement.) `packages/xai/src/__fixtures__/10-non-strict-schema-accepted.json` records one live example combining three of these — missing root `additionalProperties: false`, an optional property, and a `format` keyword — in a single accepted call.
- **Sampling** — `temperature` and `topP` are forwarded verbatim. No `topK`.
- **`max_output_tokens`** — forwarded only when the caller sets `maxOutputTokens`. The value includes both output and reasoning tokens and defaults to 128,000 when unset (docs read 2026-10-02). Truncation surfaces as `finishReason: 'length'`, not an error.
- **No penalties/stop** — `presence_penalty`, `frequency_penalty`, and `stop` are not in the config schema at all; xAI hard-rejects these on reasoning models, so the schema never admits them (reject-don't-map).
- **Service tiers** — all three models admit `serviceTier: 'priority'` (Responses `service_tier: "priority"`, billed at 2×). Grok 4.5 was captured live on 2026-09-25 and Grok 4.6 on 2026-08-12. `'flex'` / `'standard'` / `'batch'` are rejected — xAI silently remaps unknown tiers to `default`, so this library never forwards them.

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

**grok-4.7 replay:** the adapter sends `store: false`. Each result returns
`result.transientProviderState` as `{ xai: { model, input } }`: the complete wire
input and response output in provider order, including opaque `encrypted_content`,
messages, and server-tool items, scoped under the provider key and bound to the
model string you sent. Pass that object unchanged as
`request.transientProviderState` on the next request. State from another
provider, or bound to another model string (an alias is a different string from
its canonical id), is `bad_request`. This state is not written
to the call ledger. It is returned even for one-shot calls and can contain the
full prompt, inline media, and encrypted reasoning. Strip it before logging or
caching a whole result; store it securely only when continuation is needed.
When passing state, provide only new user or tool-result messages; the state
already contains prior turns. Use the new state returned by each subsequent
result. The adapter rejects assistant history alongside state, an empty new
message list, an unknown tool-result id, or a mismatched model. Without state,
a request starts a fresh conversation and may include text-only assistant
examples; function-call history requires state (`continuation: 'state'`). Live fixtures
`28-grok-4-7-replay.json`, `30-grok-4-7-search-replay.json`, and
`31-grok-4-7-third-turn.json` cover function replay and follow-ups that replay
assistant message and web-search items.

**Billing note:** attaching files on Responses implicitly enables xAI's `attachment_search` agentic tool. `web_search_calls` is billed per call. Since 2026-09-21, x_search is billed from `x_posts_fetched` and `x_users_fetched`, not `x_search_calls`. The attachment_search counter is **not** live-pinned (P-X2); a `file-ref` call sets synthetic `usage.details.attachment_search_unpinned = 1` and `Cost.confidence: 'estimated'`. When a required server-tool counter is absent, the snapshot cost is unpriced (`microUsd: null`) rather than understating an unknown fee. The provider's billed `cost_in_usd_ticks` remains in raw usage for separate reconciliation; it is not represented as a rate-snapshot-derived `Cost`.

Fixture `19-x-search.json` was captured on 2026-08-24, before the billing
change. It has only `x_search_calls`; the fixture test retains its actual
billed total in usage but leaves snapshot cost unpriced.
Live 2026-09-26 fixtures `26-x-posts.json` and `27-x-users.json` pin both
item counters, including explicit zero counts, and reconcile snapshot cost to
the provider's billed ticks. P-X2 attachment counter verification remains
blocked: the available Zero Data Retention key returned 403 for file upload
and 400 for a public URL attachment (`29-attachment-zdr-blocked.json`).

**Host tests:** `@gullabs/testing` exports `FakeXaiFileStore` (in-memory upload/get/delete with optional TTL clock and `failClosed`).

## Vision constraints

All three models accept image input as an `inline-media` or `file-uri` `Part`, and document attachments as a `file-ref` `Part`:

- **`inline-media`** — only `image/jpeg` and `image/png` are accepted; anything else throws `bad_request`. The decoded payload must be at most 20 MiB (xAI's documented inline-image ceiling); larger images throw `bad_request` before the request is sent.
- **`file-uri`** — only accepted when the URI is a public `http(s)://` URL **and** the declared `mimeType` is jpg/png. A provider-hosted URI from another provider — for example a Gemini Files API URI (`https://generativelanguage.googleapis.com/...`) — is technically `https://` but is not dereferenceable by xAI and is not portable across providers. The adapter rejects it rather than trying to map or proxy it (reject-don't-map).
- **`file-ref`** — maps to Responses `{ type: 'input_file', file_id }`. Upload first with `XaiFileStore`, then pass `{ kind: 'file-ref', fileId: handle.id }`. Empty ids throw `bad_request`.
- **Undocumented minimum size** — xAI enforces an undocumented server-side minimum image size (observed ~8px/side, ~512 total px). This adapter does **not** pre-validate pixel dimensions; a too-small image surfaces as a live `bad_request` error from the xAI API itself, classified normally by `classifyXaiError`, not rejected client-side.

## Caching

xAI caching is automatic — there is no explicit cache-create/cache-store API comparable to Gemini's Context Cache. `providerOptions.xai.promptCacheKey` maps to the Responses API's `prompt_cache_key` field and is strongly recommended for reliable cache routing across calls to the same conversation/context.

## Pricing

`XAI_PRICING` is a frozen, versioned snapshot (`xaiPricingVersion: 'xai-2026-09-25'`) — a point-in-time capture from `/v1/models`, not a live lookup (ADR-005). Rates are in µUSD per million tokens. Tool invocations add `Cost.details.tools` (`microUsd = input + cached + output + tools`):

| Counter (raw `usage.details` key) | Rate                 |
| --------------------------------- | -------------------- |
| `web_search_calls`                | $5 / 1,000 calls     |
| `x_posts_fetched`                 | $5 / 1,000 posts     |
| `x_users_fetched`                 | $10 / 1,000 profiles |

Enable Live Search with `providerOptions.xai.tools` (`web_search` / `x_search`). Citations land on `result.citations`. An annotation with a non-empty range is an inline citation: `cited: true` and a `textRange` (UTF-16 offsets into `result.text`) that covers xAI's inline `[[N]](url)` marker. xAI indexes each range from the start of the `output_text` part that carries it (every captured message has one part), and the adapter treats the indices as UTF-16 code units; both are checked, because the slice must be exactly `[[N]](<that source's url>)`. When it is not (indices counted another way, for example around emoji, or an unexpected multi-part layout), the range is dropped, the source stays `cited: true`, and the result carries a warning: a `textRange` is never a guess. Whether xAI counts code points or UTF-16 around emoji is not captured, so such an answer may lose its ranges rather than get a wrong one.

`cited` is never `false` on xAI. A zero-width (`0`/`0`) or missing range means xAI reported no inline marker range for that source, which is not the same as the answer not citing it: a captured X Search answer has inline `render_inline_citation` markup in its text while all three annotations are `0`/`0`, and structured answers have only `0`/`0` annotations. Read `cited: true` as "xAI gave an inline range", and a missing `cited` as "unknown", not "uncited". xAI's numeric marker title (`"1"`) is dropped when it equals the label of the source's own marker, so a real title that happens to be numeric (such as `"2024"`) is kept.

### Controlling the search tools

```ts
config: {
  providerOptions: {
    xai: {
      tools: [{ type: 'web_search' }, { type: 'x_search' }],
      toolChoice: 'required', // 'auto' | 'required' | 'none'
      maxTurns: 3,
    },
  },
}
```

- **`toolChoice`** maps to the Responses `tool_choice` for the search tools. Left on `auto`, a model can answer without searching; `required` forces at least one search and `none` disables the declared tools. Live on 2026-10-02 (fixture 32), `required` ran 3 / 2 / 2 searches on grok-4.5 / 4.6 / 4.7 and `none` ran 0. It needs a non-empty `tools`, and the adapter rejects it together with function tools, file attachments or the request-level `toolChoice`: xAI takes one `tool_choice` per request and `required` means "at least one tool", which a function call or the implicit `attachment_search` would satisfy. Send it on every request; nothing carries over between calls.
- **`maxTurns`** maps to the Responses `max_turns` (integer ≥ 1, needs `tools`). xAI documents it as the cap on agentic tool-calling turns. A turn can run several searches, so it is not a search count. **xAI did not enforce it as of 2026-10-02** (fixture 33): with `max_turns: 1` the three models still ran 10 to 17 searches over several rounds. The option is forwarded verbatim so hosts get the cap when xAI enforces it. Until then, state the search budget in the prompt and assert on the observed count.
- **Observed count.** `result.usage.details.web_search_requested` is `1` when the request enabled `web_search`, and `result.usage.details.web_search_calls` is the number of web searches billed (the same two names Google reports, ADR-035; an explicit "no server tool ran" reports `0`); `x_posts_fetched` and `x_users_fetched` are the X Search billing counters (items, not calls). All three persist to the ledger's token details. When no server tool ran, xAI reports `num_server_side_tools_used: 0` and omits the counters; the adapter reports `web_search_calls: 0` for a request that enabled `web_search` and prices that call exactly with no tool fee.
- **Cost.** There is no enforceable search cap, and every search result is fed back as input. One uncapped grok-4.7 research call used 362k input tokens, which crosses the 200k long-context threshold, and cost about $1.07.
  `countTokens` uses `POST /v1/tokenize-text` and returns `accuracy: 'lower-bound'` (text parts only; media / file parts are `bad_request`).

| Model      | Tier                         | Input   | Cached input | Output   |
| ---------- | ---------------------------- | ------- | ------------ | -------- |
| `grok-4.5` | standard (<200k gross input) | $2.00/M | $0.30/M      | $6.00/M  |
| `grok-4.5` | `gt200k` (≥200k gross input) | $4.00/M | $0.60/M      | $12.00/M |
| `grok-4.6` | standard (<200k gross input) | $2.00/M | $0.50/M      | $6.00/M  |
| `grok-4.6` | `gt200k` (≥200k gross input) | $4.00/M | $1.00/M      | $12.00/M |
| `grok-4.7` | standard (<200k gross input) | $2.00/M | $0.50/M      | $6.00/M  |
| `grok-4.7` | `gt200k` (≥200k gross input) | $4.00/M | $1.00/M      | $12.00/M |

The `gt200k` long-context tier is selected by **gross** `inputTokens` (including cached), not billable input — at or above 200,000 tokens (`long_context_threshold`), as stated on [xAI's pricing page](https://docs.x.ai/developers/pricing). The adapter surfaces the echoed Responses `service_tier` (`'default'` or `'priority'`), so `price()` receives that served value instead of `undefined`. Custom xAI `PricingSource` implementations must price `'default'` at the standard list. Built-in `xaiPricingSource().price()` prices priority at 2× every token type after the cache discount. Fixture `23-grok-4-5-priority.json` confirms Grok 4.5's 2× total, and fixture `12-grok-4-6-xhigh-priority.json` confirms Grok 4.6; cached and `gt200k` legs follow the official 2×-after-cache-discount rule. `fast` is not admitted. Any other defined tier is unpriced (`microUsd: null`). Grok 4.5/4.6 list rates are pinned to `packages/xai/src/__fixtures__/14-v1-models-pricing.json` (live `GET /v1/models` 2026-08-12); Grok 4.7 rates come from the [September 21 release notes](https://docs.x.ai/developers/release-notes).

## Long calls and timeouts

xAI sends nothing until a non-streamed answer is complete, so a reasoning or agentic call can wait
many minutes for response headers. Two separate timers sit in the way, and only one of them is
controlled by the SDK:

| Timer                                     | Default    | What sets it                                                           |
| ----------------------------------------- | ---------- | ---------------------------------------------------------------------- |
| `openai` SDK deadline (`timeout`)         | 10 minutes | The adapter: `timeoutMs + 5000`, or one hour when `timeoutMs` is unset |
| Node `fetch` (undici) header + body timer | 300 s each | The host's `transport` only                                            |

**The SDK timeout alone does not lift Node's 300 s header timer.** Without a transport, any call that
takes longer than 300 s fails at 300 s, whatever `timeoutMs` says. To run longer calls, pass undici's
own `fetch` with an `Agent` whose timers are at least the SDK deadline:

```ts
import { Agent, fetch as undiciFetch } from 'undici' // pnpm add undici
import { createClient, composeProviders } from '@gullabs/core'
import { xaiProvider } from '@gullabs/xai'

const LIMIT_MS = 3_605_000 // >= the longest SDK deadline you will use (default: 3_600_000 + slack)

const client = createClient({
  ...composeProviders([
    xaiProvider({
      transport: {
        fetch: undiciFetch as unknown as typeof fetch,
        fetchOptions: {
          dispatcher: new Agent({ headersTimeout: LIMIT_MS, bodyTimeout: LIMIT_MS }),
        },
      },
    }),
  ]),
})
```

Notes:

- Use `fetch` and `Agent` from the **same** `undici` package. Node's built-in `fetch` bundles its own
  undici, and a dispatcher from a different version is not guaranteed to work with it.
- Size `headersTimeout` and `bodyTimeout` to at least the largest SDK deadline you use:
  `timeoutMs + 5000` for calls that set `timeoutMs`, `XAI_DEFAULT_TIMEOUT_MS` (3 600 000) otherwise.
- **Keep this transport until streaming removes the need.** The adapter does not stream today, so the
  transport is the only way to run a call past 300 s. A later release will stream internally; until it
  does, treat the transport as required for any long-running xAI workload.
- `transport` cannot be combined with an injected `client`, and `fetchOptions` cannot carry `headers`,
  `signal`, `body` or `method`. Both are `bad_request`, as is a `transport` whose `fetch` is not a
  function or whose `fetchOptions` is not an object. The adapter copies the transport when it is
  created, so changing your own object afterwards has no effect.
- `transport` carries every request the adapter makes: `responses.create` **and** `countTokens`
  (`POST /v1/tokenize-text`), so a proxy, mTLS or egress policy in your `fetch` covers both.
  `XaiFileStore` is separate and takes its own `fetch` option.
- `timeoutMs` is at most 2147478647 (Node timers overflow at 2^31 - 1 ms and the SDK deadline adds
  5 s); a larger value is `bad_request`, not clamped.
- `timeoutMs` still works as before: the engine arms its own deadline at exactly `timeoutMs` and the
  SDK deadline sits 5 s behind it, so you see the engine's clean timeout.

### Timeout errors do not retry

A header-timer, body-timer or SDK-deadline timeout (a transport-level timeout; it can fire before or
after response headers) is `kind: 'timeout'`, `retryable: false`, `reason: 'transport_timeout'`.
Retrying reaches the same limit and repeats the spend, so the retry middleware does not retry it;
resubmit from the host if you want to. A connect timeout, an OS `ETIMEDOUT` and a TLS handshake
timeout (nothing reached xAI) stay retryable. The `openai` SDK wraps all of those as the same
`APIConnectionTimeoutError`, so the adapter recognises its own SDK deadline by the failure's shape (no
cause, or only the SDK's own `AbortError`) and by the call having run for the `timeout` it set; the
exported `classifyXaiError(error, { timeoutMs, elapsedMs })` takes that context, and without it never
reports an SDK deadline. See ADR-032 in the repository root `DECISIONS.md`.

## Regions

The grok-4.6 and grok-4.7 model pages list `us-east-1`, `us-west-2`, and `us-central-1` (docs read 2026-10-02). The release notes say Grok 4.5 is available in the API console for EU users (docs read 2026-10-02). This is a hosting/deployment concern for callers, not something this library can route around; it is documented here so consumers are not surprised by data-residency constraints.

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
- `serviceTier: 'priority'` → `service_tier: 'priority'` (all three models)
- `output.jsonSchema` → `text.format: { type: 'json_schema', name, schema, strict: true }`, and `tools[].inputJsonSchema` → function `parameters`; both are asserted against xAI's enforced keywords first
- Usage: `usage.input_tokens` → `inputTokens`, `usage.output_tokens` → `outputTokens` (both already GROSS on xAI, unlike Gemini's sub-field summation); numeric extras (`num_sources_used`, `cost_in_usd_ticks`, etc.) surface into `usage.details` under their raw names, and the full raw payload is always in `usage.raw`
- Errors: HTTP status is a hint. `classifyXaiError` inspects the STRUCTURED parsed body only — never free-form `Error.message`. Two recorded overlays: HTTP **400** whose body starts with `"Incorrect API key provided"` (prefix only; the SDK may drop `code`) → `invalid_auth`; HTTP **403** whose body starts with `"Content violates usage guidelines"` (e.g. `SAFETY_CHECK_TYPE_*`) → `content_filter`. A bare 403 without that body stays `invalid_auth`. Any other 400, `429`→`rate_limited`, `5xx`→`server`, and timeouts fall through to `@gullabs/core`'s generic `classifyError`.

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`@gullabs/core` README](../core/README.md) — engine, ports, and the `LlmError` contract
