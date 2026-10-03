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

## Function calling and Gemini 3 thought signatures

Gemini 3.x returns an opaque `thoughtSignature` on the first function call of each model turn
(and sometimes on a text part) and answers HTTP 400 if a replayed function call has lost it
(live capture, 2026-10-03: all six registered 3.x models; Google signs only the **first** call of a
parallel set, and every sequential step needs its own). The library handles this without keeping a
copy of your history. Continuation is `'history'`: append `result.message`, send the full history,
and pass `result.transientProviderState` back.

```ts
const tools = [
  {
    name: 'get_weather',
    description: 'Current weather for a city',
    inputJsonSchema: { type: 'object', properties: { city: { type: 'string' } } },
  },
]
const base = { provider: 'google', model: 'gemini-3.6-flash', tools } as const
let messages: Message[] = [
  { role: 'user', parts: [{ kind: 'text', text: 'Weather in Paris?' }] },
]
let state: JsonValue | undefined

for (;;) {
  const result = await client.generate(
    {
      ...base,
      messages,
      ...(state !== undefined ? { transientProviderState: state } : {}),
    },
    { auth: { apiKey: 'YOUR_GEMINI_API_KEY' } },
  )
  if (result.toolCalls === undefined) break // result.text is the answer

  const toolResults = {
    role: 'user' as const,
    parts: result.toolCalls.map((c) => ({
      kind: 'tool-result' as const,
      toolCallId: c.toolCallId,
      toolName: c.toolName,
      result: { tempC: 18 }, // run the tool; any JSON value (non-objects are wrapped as { output })
    })),
  }
  messages = [...messages, result.message, toolResults] // unedited
  state = result.transientProviderState // the signature overlay; carries every earlier entry
}
```

`result.transientProviderState` is `{ google: { signatures: [{ messageIndex, partIndex, kind, model,
partSha256, signature }] } }`, an **overlay** that says which part of _your_ messages gets which
signature. `kind` is the signed part's kind (`'text'` or `'tool-call'`); `messageIndex` indexes the
messages the adapter receives (a middleware that adds or removes messages shifts them). `partSha256`
is the SHA-256 of the part's RFC 8785 canonical JSON, so an edited text or tool argument is
detected and key order does not matter (history stored in Postgres `jsonb` still verifies). Persist
it with the history it belongs to; it contains opaque provider tokens, not prompt text, and is never
written to the ledger.

**What is rejected and what is dropped.** A function-call signature is required, so the next request
is `bad_request` before dispatch when a function-call entry is stale (the call was edited, reordered
or removed, the message moved, or the entry was issued for another model string; signatures are not
replayed across models, and a declared alias is a different string from its canonical id), when an
assistant message with tool calls has no entry for its first call (this is also what rejects history
produced by another provider, or by Gemini 2.5), when two entries name the same part, or when the
state is malformed. A **text** signature is optional (Google accepts the next turn without it), so a
stale text entry (the text was trimmed, edited or moved, the message is gone, or it was issued for
another model) is dropped with a result warning and nothing else is lost; the dropped entry is not
carried into the next state. A host that `.trim()`s the final answer, or rebuilds it from
`result.text`, keeps working.

Google validates the signature only on function calls in the current turn (live capture, 2026-10-03:
an unsigned call in an older turn was accepted on `gemini-3.1-pro-preview` and `gemini-3.8-flash`).
The library still requires an entry for every replayed tool-call message, so history without
signatures never reaches Google by accident; keep a conversation that began on another provider on
that provider.

The library does not offer Google's dummy signature that bypasses validation: it degrades quality and
is a [BACKLOG](../../BACKLOG.md) item, not a default. Gemini 2.5 and Gemma need none of this.

### Trimming, compacting and rewinding the history

The overlay is addressed by message index, so removing messages from your history moves what the
indices mean. After you remove messages, pass their positions (in the history the state was issued
for) to `dropMessagesFromSignatureState(state, indices)`. It drops the entries of the removed
messages, shifts the later `messageIndex`es down, and returns `undefined` when nothing is left:

```ts
import { dropMessagesFromSignatureState } from '@gullabs/google'

// Front-trim: drop the oldest turn (messages 0-3) to fit the context window.
messages = messages.slice(4)
state = dropMessagesFromSignatureState(state, [0, 1, 2, 3])

// Rewind: undo the last tool step (messages 5-6), then ask again.
messages = messages.slice(0, 5)
state = dropMessagesFromSignatureState(state, [5, 6])
```

The rule is whole turns only: remove a tool-call message together with its tool-result message, and
never keep a message that holds a function call while removing its entry. Compaction (replacing
several messages by one summary) works the same way if the summary takes the place of the range's first
message and you pass the rest of the range: replacing messages 0-3 with one user summary is
`messages = [summary, ...messages.slice(4)]` and `dropMessagesFromSignatureState(state, [1, 2, 3])`
(message 0 is a user message and never has an entry). Do not insert messages in front of kept ones; that
shifts indices upward and the helper only shifts them down. Without the helper, a stale function-call
entry is `bad_request`.

### Tool-call ids

Gemini returns a `functionCall.id` (`call_<number>` on the Developer API in the live capture); the
library uses it as `toolCallId` and sends it back on the `functionCall` and `functionResponse`. If a
response has no id, the library synthesizes `anyllm_call_<name>_<n>`, unique among the ids already in
your history, and **never sends it** to Gemini (a response is matched to its call by name and order,
which is what Gemini documents). Gemini 3 accepted a replay with provider ids, without ids, with
synthesized ids and with the same id repeated across steps (capture
`__fixtures__/function-call-ids-2026-10-03.json`).

### Empty responses and `countTokens`

A response with nothing to replay (the model produced only thoughts, for example when
`maxOutputTokens` was spent on reasoning) has `result.message.parts === []`. Do not append it to your
history: an assistant message with no parts is `bad_request`. Retry the call instead.

`countTokens` sends the history without signatures (Gemini accepts that), and `generate()` bills each
replayed signature (about 110 prompt tokens each). So when the counted history holds function calls
on a Gemini 3 model, `accuracy` is `'estimated'`, not `'exact'`: the real count is higher by roughly
one signature per signed call or text part. Without function calls, or on Gemini 2.5, it is
`'exact'`.

Provider output that cannot be hashed never fails a call that was billed: a lone surrogate in a
function call's arguments or in text returns the result with a warning naming the part and no
signature entry for it (the next turn is then `bad_request`, because the function call lacks its
signature), and `-0` is treated as `0`.

`geminiContentToMessages({ contents, model })` imports signatures from hand-authored
`@google/genai` history into the same overlay, returned as `transientProviderState` beside `messages`; `model` is required
when any part carries one.

## What it maps

- `serviceTier: 'flex'` → Gemini Flex service tier when the model descriptor supports it
- omitted `serviceTier` → provider-default request behavior
- `reasoning.includeThoughts` → `thinkingConfig.includeThoughts`; thought parts become `reasoningText`
- `reasoning.effort` → `thinkingBudget` (Gemini 2.5) or `thinkingLevel` (Gemini 3 / Gemma 4)
- `reasoning.budgetTokens` → admitted only on Gemini 2.5 budget-api models; strict descriptors reject it on level-api models
- `output.jsonSchema` → `responseMimeType: 'application/json'` + verbatim `responseJsonSchema` when native structured output is enabled, and `tools[].inputJsonSchema` → `parametersJsonSchema` (both standard JSON Schema, in your key order; see "JSON Schema" below); the engine returns parsed output and `outputParsed` without validating shape
- `providerOptions.google.*` → typed provider-extension lane for admitted keys such as `cachedContent`, `safetySettings`, and exact tool declarations
- Usage: `promptTokenCount`→`inputTokens`, `candidatesTokenCount`+`thoughtsTokenCount`→`outputTokens` (GROSS)
- Errors: `401` and a bare `403` default to `invalid_auth`; `429`→`rate_limited`; `5xx`→`server`; timeouts; Gemini safety blocks are a 200-path `content_filter` when `promptFeedback.blockReason` is set. A candidate-less 200 without a block reason is retryable `server`.

## JSON Schema

`output.jsonSchema` and `tools[].inputJsonSchema` are standard JSON Schema, sent as
`responseJsonSchema` and `parametersJsonSchema` exactly as you wrote them, key order included (put
`reasoning` before `answer` and the model generates in that order). There is no OpenAPI
`responseSchema` / `parameters` path, and `nullable` and uppercase type names are rejected.

Google accepts every keyword and silently ignores the ones it does not support, so the adapter
only lets through the ones it enforces and rejects the rest with `bad_request` and the JSON path
before dispatch (ADR-034; live probe on every Gemini and Gemma model, 2026-10-03, and Google's
structured-output guide read the same day):

- **Enforced:** `type` (a type array only as one type plus `'null'`), `properties`, `required`,
  `additionalProperties` (boolean or schema), `enum`, `anyOf`, `$ref` / `$defs` (recursive
  schemas too), `items`, `prefixItems` (and `items: false` to close a tuple), `minItems` /
  `maxItems`, `minimum` / `maximum`, and `format` for `date-time`, `date` and `email` (the
  values the probe exercised; `time` is named in Google's guide but no capture exercised it, so
  it is rejected).
- **Accepted, but soft:** `pattern`, `minLength` and `maxLength` are supported by Google yet obeyed
  only probabilistically (the probe saw violations on several models, at worst 4 of 7 samples).
  They are not guarantees: validate `output` yourself. The library never validates the result.
  `pattern` is held to a regex subset (no backreferences, property escapes, word boundaries,
  lookaround or inline modifiers) because no capture shows Google enforcing them.
- **Rejected, because Google ignores them:** `const`, `allOf`, `exclusiveMinimum` /
  `exclusiveMaximum`, `multipleOf`, `uniqueItems`, and `oneOf`, which Google reads as `anyOf`.
  `not`, `if`/`then`/`else`, `minProperties` and other `format` values are outside the enforced
  set too, and so is any `propertyNames` except `{ type: 'string' }` (what
  `z.record(z.string(), X)` emits; it constrains nothing and is accepted).
- **Gemma 4 is stricter.** It ignored `format` (7 of 7 samples on both models) and
  `minLength` / `maxLength` (7 of 7 and 6 of 7), so those three keywords are rejected on a Gemma
  model. The profile follows the resolved model descriptor, so a declared alias of a Gemma model
  gets it too.
- **Annotations** (`$schema`, `$id`, `$comment`, `title`, `description`, `examples`, `default`,
  `deprecated`, `readOnly`, `writeOnly`) are always accepted.
- **Malformed schemas** (a value in a schema position that is not a schema, `maxLength: '3000'`,
  an invalid `pattern`, a cyclic JavaScript object, nesting deeper than 128) are `bad_request`
  with the path, before dispatch.

**Tool schemas rest on the output-schema probe.** The live probe (P3) ran `responseJsonSchema`
only; the only live `parametersJsonSchema` evidence is two trivial schemas (an object with one
string property and `additionalProperties: false`, and an empty `properties`) on the six 3.x
models. `$schema`, `$ref` / `$defs`, `anyOf`, `items: false` and type arrays are verified for
output schemas only, and the same profile is applied to tools. Do not read tool-schema acceptance
beyond trivial schemas as live-verified.

Zod: `z.literal('x')` emits `const`, which Google ignores. Write `z.enum(['x'])` instead; the
library does not rewrite it for you. `z.discriminatedUnion` emits `oneOf`; use `z.union`, which
emits `anyOf`. `startsWith`, `endsWith` and `includes` emit a non-standard `format` next to a
`pattern`: chain `.meta({ format: undefined })` after the check, or write `z.string().regex(...)`.
To lint a schema against what both Gemini 3.x and xAI enforce, call `assertPortableJsonSchema`
from `@gullabs/core` (it does not cover Gemma's stricter profile).

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
Gemini 3.x models in the 2026-09-26 live probes, but the structured responses did
not include `groundingMetadata` even when asked to search, and Flash-Lite often
skipped Search. An accepted request is not proof that Search ran, so
`structuredOutputWithTools` is `false` on every descriptor: the combination fails
with `bad_request` before dispatch. Make two calls instead (grounded research, then
structured synthesis); see [`docs/grounded-structured.md`](../../docs/grounded-structured.md).
To send both in one call anyway, set `providerOptions.google.allowSchemaWithSearch: true`.
That also turns on `requireGrounding` (override with `requireGrounding: false`), because a
schema'd call can skip Search without saying so. The opt-in exists only for the Gemini 3.x models,
the only ones with a capture: on Gemini 2.5 and Gemma the pair is rejected with or without it.

### Search facts, grounding price and `requireGrounding`

A call that sends `googleSearch` reports two facts in `usage.details`:
`web_search_requested` (`1`) and `web_search_calls`, the number of queries in
`groundingMetadata.webSearchQueries` counted as occurrences (a repeated query counts each
time; absent when the response has no metadata or no query list). `tool_use_prompt` records
`toolUsePromptTokenCount` when Google reports it (Gemini 2.5). Those tokens are not priced, so a
grounded 2.5 call is understated by them at the input rate; whether Google bills them is the open
billing question in ADR-035.

The pricing source puts the grounding fee on `cost.details.tools`: Gemini 3 bills per query
(`web_search_calls × $0.014`), Gemini 2.5 per grounded prompt (`$0.035`, once however many
queries ran), from Google's pricing page read 2026-10-03. A call that ran Search is always
`cost.confidence: 'estimated'`: Google's daily free allowance is shared across a project, so
no single call can know it was free, and every fee is charged in full. When Search was
requested but the count is unknown, the tools lane is `0`, the cost is estimated and a warning
says so. Google's billing of repeated queries and of tool-use tokens is not established.

`providerOptions.google.requireGrounding: true` fails the call unless the response proves Search
ran (`groundingMetadata` with at least one non-empty query): a `server` error with
`reason: 'grounding_missing'` and the attempt's usage attached, so the billed tokens reach the
ledger. It is `retryable: true` only when no response schema is attached (4 of 4 captured calls
grounded); with a schema the same request keeps missing, so it is `retryable: false` and a retry
middleware makes one billed attempt, not three. Use the two-call recipe, or override `shouldRetry`
and accept the spend. The check applies only to a candidate that finished with `STOP`: a filtered
candidate (`SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `IMAGE_SAFETY`) with no evidence
throws `content_filter` (not retryable), and `MAX_TOKENS` returns `finishReason: 'length'`. It needs
`googleSearch` in the same request. `result.cost` of a call that succeeded on a retry covers the
last attempt only; the earlier attempts' spend is in their ledger rows.

`result.citations` entries carry `cited` (a `groundingSupports` segment points at the source) and
`textRange` (the first supported span of `result.text`, UTF-16 offsets). Google requires a grounded
answer to display its Search Suggestions: the widget is at
`result.providerMetadata.google.searchEntryPoint`.

`countTokens` takes `messages` only on Google: `system` or `tools` fails with
`bad_request`, because the Developer API's count cannot include them and a count
without them would be a lower bound reported as exact.

## Registered models

| id                       | Efforts                         | SO + search | caching.minTokens | Tiers          |
| ------------------------ | ------------------------------- | ----------- | ----------------- | -------------- |
| `gemini-2.5-pro`         | `low`, `medium`, `high`         | no          | 2048              | flex, standard |
| `gemini-2.5-flash`       | `none`, `low`, `medium`, `high` | no          | 2048              | flex, standard |
| `gemini-2.5-flash-lite`  | `none`, `low`, `medium`, `high` | no          | 2048              | flex, standard |
| `gemini-3.1-pro-preview` | `low`, `medium`, `high`         | no          | 1024              | flex, standard |
| `gemini-3.1-flash-lite`  | `none`, `low`, `medium`, `high` | no          | 1024              | flex, standard |
| `gemini-3.5-flash-lite`  | `none`, `low`, `medium`, `high` | no          | 1024              | flex, standard |
| `gemini-3.6-flash`       | `none`, `low`, `medium`, `high` | no          | 1024              | flex, standard |
| `gemini-3.7-flash`       | `low`, `medium`, `high`         | no          | 1024              | flex, standard |
| `gemini-3.8-flash`       | `low`, `medium`, `high`         | no          | 1024              | flex, standard |
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

- **Native structured output** — `responseMimeType` + verbatim `responseJsonSchema` are sent
  automatically when `output.jsonSchema` is set. Gemma ignored `format`, `minLength` and
  `maxLength` in live probes, so those three keywords are rejected for Gemma models.
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
