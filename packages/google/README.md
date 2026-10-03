# @gullabs/google

Gemini provider adapter for any-llm. A thin mapping layer over `@google/genai` that converts `ResolvedRequest` → Gemini SDK params and maps the response back to `AdapterResult`. Never persists, never computes cost, never loops — pure request/response.

## Install

```bash
pnpm add @gullabs/google @gullabs/core @google/genai
```

**Peer dependency:** `@google/genai ^2`

## Key exports

| Export                                                                     | What it is                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `googleProvider(opts?)`                                                    | `ProviderPlugin` factory — bundles the adapter, model descriptors, and pricing source                         |
| `geminiAdapter(opts?)`                                                     | Creates the `ProviderAdapter` for Gemini                                                                      |
| `GeminiAdapterOptions`                                                     | `{ client?: GeminiClientLike }` — inject a pre-built or fake client                                           |
| `GeminiClientLike`                                                         | Structural interface the adapter depends on (satisfied by real SDK and fakes)                                 |
| `buildGoogleClient(auth)`                                                  | Builds the real `@google/genai` client from `AuthMaterial`                                                    |
| `isGeminiCapacityError(err)`                                               | Detects Gemini Flex capacity errors (HTTP 503 only) for fallback                                              |
| `classifyGoogleError(err)`                                                 | The classifier every Gemini error goes through (`@gullabs/testing`'s fakes call it for you)                   |
| `GEMINI_INPUT_MIME_TYPES`                                                  | The media types a Gemini file upload and a Gemini request admit (`text/*`, `image/*`, `application/pdf`, ...) |
| `geminiModelDescriptors`, `gemmaModelDescriptors`, `defaultGeminiRegistry` | Built-in model descriptors + pre-built registry                                                               |
| `geminiPricingSource()`, `GEMINI_PRICING`, `resolveGeminiRates`            | Built-in Gemini pricing snapshot (concrete standard / flex rates, audio input rates where published)          |
| `GoogleFileStore`                                                          | Files API: upload + poll ACTIVE + delete                                                                      |
| `FileDeleteOptions`                                                        | `{ failClosed?, signal? }` — opt-in fail-closed delete (parity with `@gullabs/xai`)                           |

## File store delete modes

`GoogleFileStore.upload` takes an `AbortSignal` (an abort releases the caller at once; bytes already sent may still be stored by Google), keeps Google's own `File.error` when a file ends `FAILED` (a transient status code, `DEADLINE_EXCEEDED`, `INTERNAL` or `UNAVAILABLE`, is a retryable `server` error; any other is `bad_request`), and its polling timeout is `kind: 'server'`, **not retryable** (the upload succeeded; a retry would upload again and orphan the file). Store errors (`GoogleFileStore`, `GoogleCacheStore`) are classified exactly like `generate()` errors, with `provider: 'google'`.

`GoogleFileStore` takes a `scheduler` (the timer source of the poll wait; pass the client's `FakeClock` in tests, with `now: () => clock.now()` for the poll timeout), and the Gemini flex/standard client-side ceiling runs on the engine's `scheduler` too, so a `FakeClock` fires both. `sleep` still replaces the poll wait wholesale.

`GoogleFileStore.delete` defaults to **fail-open** (errors → `onDeleteError`, resolve). Pass `{ failClosed: true }` when the host gates durable state on known success; HTTP/SDK not-found remains success (idempotent). Empty `handle.name` always throws `bad_request`.

```ts
import type { GoogleFileHandle, GoogleFileStore } from '@gullabs/google'

declare const store: GoogleFileStore
declare const handle: GoogleFileHandle

await store.delete(handle) // fail-open
await store.delete(handle, { failClosed: true }) // throw on non-not-found failure
```

## Model lifecycle

`gemini-3.1-flash-lite` carries `shutdownDate: '2027-05-07'` (replacement: `gemini-3.5-flash-lite`), read on Google's [deprecations page](https://ai.google.dev/gemini-api/docs/deprecations) (last updated 2026-10-01) on 2026-10-03. From 2027-02-06 on, the first successful call to it on a client has a `{ type: 'shutdown' }` warning saying so (once per client, not on every call). Google also limits Gemini 2.5 access to users who have used those models; no shutdown date is announced for them, so none is set. Gemma 4 is not on the page.

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
import { composeProviders, createClient } from '@gullabs/core'
import type { JsonValue, Message } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'

const client = createClient({ ...composeProviders([googleProvider()]) })

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
import type { JsonValue, Message } from '@gullabs/core'
import { dropMessagesFromSignatureState } from '@gullabs/google'

let messages: Message[] = []
let state: JsonValue | undefined // the previous result's transientProviderState

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

## Thinking budgets and the output cap

`maxOutputTokens` **includes thinking tokens**. A model that thinks for the whole cap returns no answer
(`finishReason: 'length'`, empty text, `thinkingTokens > 0`), and the library warns about it after the fact
("maxOutputTokens (M) was used up by reasoning (T tokens); no answer was produced"). Gemini 2.5 models
take a thinking budget, and the adapter turns `reasoning.effort` into one:

| `reasoning.effort` | `thinkingBudget` | Note                                                                        |
| ------------------ | ---------------- | --------------------------------------------------------------------------- |
| `none`             | 0                | Thinking off; only the models that admit `none` (2.5 Flash, 2.5 Flash-Lite) |
| `low`              | 1,024            |                                                                             |
| `medium`           | 8,192            |                                                                             |
| `high`             | 24,576           | The Flash maximum, and 75% of 2.5 Pro's 32,768                              |

`xhigh` and `max` are rejected: they have no Gemini budget. `reasoning.budgetTokens` sets the budget
directly (128 to 32,768 on 2.5 Pro, per its schema) and cannot be combined with `effort`. Gemini 3.x
and Gemma 4 use `thinkingLevel` and have no token budget.

When a budget model's `thinkingBudget` (from `effort` or `budgetTokens`) is **at or above**
`maxOutputTokens`, the result carries a warning ("thinkingBudget (B) is not below maxOutputTokens (M);
thinking may consume the whole cap and leave no answer"). It is a warning, not a rejection: Google says actual
thinking can under- or overflow the budget, so the combination is a risk, not an invalid request. The
common trap is `effort: 'high'` (24,576) with a small `maxOutputTokens`.

Gemini 3.x models take a level, not a budget, so there is nothing to compare with the cap. The adapter warns
when `reasoning.effort` is `high` and `maxOutputTokens` is below 4,096 (measured: thinking reached 4,000 tokens
in 7 of 72 3.x calls at `high`, up to 8,859). It does not warn at `low` or `medium` (no 3.x call reached 4,000
tokens there, and a smaller figure would rest on a prompt-dependent tail the sample cannot place), nor when
`reasoning` is omitted (the default level was not measured). Warnings never reject.

Measured thinking is prompt-driven and heavy-tailed: `docs/thinking-token-distribution.md` has p50, p95
and max per model and effort (336 calls, 2026-10-03; the raw records are kept outside this repository). At `high`, p95 was 2.5 to 6 times the p50, and the largest value was
8,859 tokens, so size `maxOutputTokens` for the answer **plus** thinking: under 4,096 is unsafe at `high`
and 1,024 was used up by thinking in most `high` calls.

## Model limits and input media types

Every descriptor states `limits: { contextWindow, maxOutputTokens }`. The Gemini model pages
(`ai.google.dev/gemini-api/docs/models/<id>`, read 2026-10-03) give 1,048,576 input and 65,536 output tokens
for every registered Gemini model, and their config schemas cap `maxOutputTokens` at 65,536 (a larger value is
`bad_request` before dispatch). The Gemma 4 model card gives a 256K window (262,144) and **no output limit**, so
Gemma's `limits.maxOutputTokens` is `null`: no figure is invented, its schema applies no cap, and Google decides
what it accepts.

`capabilities.inputMimeTypes` is what a model takes in `inline-media` and `file-uri` parts; anything else, and an
empty type, is `bad_request` naming `messages[i].parts[j]` before dispatch (and in `countTokens`). Matching
ignores case and `; parameters` (`IMAGE/PNG`, `text/plain; charset=utf-8` pass) and the string you sent goes to
Google unchanged.

- **Gemini:** `application/pdf` and the families `text/*`, `image/*`, `audio/*`, `video/*`. Google lists image
  types (PNG, JPEG, WebP, HEIC, HEIF), audio and video types, but publishes no closed list for documents: its
  document page says PDF is understood natively and "you can pass other MIME types for document understanding,
  like TXT, Markdown, HTML, XML, etc." (extracted as plain text). The library therefore admits the documented
  families by prefix and leaves a type inside a family that Google does not take (for example an image format
  it does not decode) to Google's own error. `application/json`, `application/xml` and other `application/*`
  types are in no documented family and are rejected. A YouTube URL is a `file-uri` part: give it any
  `video/*` type (for example `video/mp4`).
- **Gemma 4:** `image/*` and `video/*`. The model card lists image input and video as frames (up to 60
  seconds at one frame per second) for the 31B and 26B A4B models and names no media types; audio input
  belongs to other Gemma sizes. That the Gemini API's Gemma endpoint takes a video part has not been probed.
- **`GoogleFileStore.upload`** applies the same Gemini rule (one shared function), so an empty or unadmitted type
  is `bad_request` before any bytes are sent, and a file that uploads can be used in `generate`.

## What it maps

- `serviceTier: 'flex'` → Gemini Flex service tier when the model descriptor supports it
- omitted `serviceTier` → provider-default request behavior
- `reasoning.includeThoughts` → `thinkingConfig.includeThoughts`; thought parts become `reasoningText`
- `reasoning.effort` → `thinkingBudget` (Gemini 2.5) or `thinkingLevel` (Gemini 3 / Gemma 4)
- `reasoning.budgetTokens` → admitted only on Gemini 2.5 budget-api models; strict descriptors reject it on level-api models (see "Thinking budgets and the output cap")
- `output.jsonSchema` → `responseMimeType: 'application/json'` + verbatim `responseJsonSchema` when native structured output is enabled, and `tools[].inputJsonSchema` → `parametersJsonSchema` (both standard JSON Schema, in your key order; see "JSON Schema" below); the engine returns parsed output and `outputParsed` without validating shape
- `providerOptions.google.*` → typed provider-extension lane for admitted keys such as `cachedContent`, `safetySettings`, and exact tool declarations
- Usage: `promptTokenCount`→`inputTokens`, `candidatesTokenCount`+`thoughtsTokenCount`→`outputTokens` (GROSS)
- Errors: `401` and a bare `403` default to `invalid_auth`; `429`→`rate_limited`; `5xx`→`server`; timeouts; Gemini safety blocks are a 200-path `content_filter` when `promptFeedback.blockReason` is set, and so is an output filter stop (`SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_*`) that produced no text and no tool call (not retryable, usage attached; a stop that kept partial text is a success with `finishReason: 'content_filter'`). A candidate-less 200 without a block reason is retryable `server`. The structured body adds: `RetryInfo.retryDelay` → `retryAfterMs`; a per-day quota (`QuotaFailure` quota id containing `PerDay`) → `rate_limited`, not retryable, `reason: 'daily_quota'`; `API_KEY_INVALID` / `API_KEY_EXPIRED` (Google sends the first as HTTP 400) → `invalid_auth`; a stale `cachedContent` (HTTP 403, "CachedContent not found") → `bad_request`, `reason: 'cache_not_found'`. `retryMiddleware` (default `maxDelayMs` 60 s) sleeps a typical per-minute `retryDelay` and retries; a delay over 60 s stops the retry and the 429 surfaces with `retryAfterMs` for a scheduler (raise `maxDelayMs` to wait longer in process).
- `providerOptions.google.safetySettings` → `category` is one of `HARM_CATEGORY_HARASSMENT`, `_HATE_SPEECH`, `_SEXUALLY_EXPLICIT`, `_DANGEROUS_CONTENT`, `_CIVIC_INTEGRITY`, `_JAILBREAK` and `threshold` one of `HARM_BLOCK_THRESHOLD_UNSPECIFIED`, `BLOCK_LOW_AND_ABOVE`, `BLOCK_MEDIUM_AND_ABOVE`, `BLOCK_ONLY_HIGH`, `BLOCK_NONE`, `OFF` (Google's safety-settings guide, dated 2026-09-17); anything else is `bad_request` before dispatch.
- `providerOptions.google.cachedContent` cannot be sent with `system`, `tools` or `providerOptions.google.tools`: Gemini needs them stored in the cache, so pass `tools` / `toolConfig` (and `systemInstruction`) to `GoogleCacheStore.create` instead. The adapter rejects the combination before dispatch.
- Inline media is checked against Google's request limits before dispatch: an inline PDF over 50 MB, or a request whose inline data and text exceed 100 MB, is `bad_request`; upload it with `GoogleFileStore` and send a `file-uri` part. The result's `providerMetadata.google.candidate` holds the candidate's raw `finishReason`, `finishMessage`, `safetyRatings`, `citationMetadata` and `urlContextMetadata` when Google sent them.

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

### Audio input and cache storage

Gemini 2.5 Flash, 2.5 Flash-Lite and 3.1 Flash-Lite bill audio input at a higher rate than text, image and
video (cached audio apart from cached text), on both the standard and the flex tier. The adapter records the
prompt's per-modality counts from `usageMetadata.promptTokensDetails` and `cacheTokensDetails` as
`usage.details.input_<modality>` and `cached_<modality>` (`input_audio`, `cached_audio`, ...), and the
pricing source bills the audio tokens at the audio rates and every other token at the text rate. The other
models list one rate for all modalities. The rates are from Google's pricing page, read 2026-10-03
(page last updated 2026-10-01). A request that carries audio but whose response reports no `AUDIO` tokens
(the entry is absent or `{ AUDIO, 0 }`) carries a warning, and on a model that prices audio apart its cost
is `'estimated'` (it can understate); the warning and the estimate read the same predicate. Cached tokens
are priced as text only when the audio share of the cache is known: a `cacheTokensDetails` that lists no
audio and covers every cached token records `cached_audio: 0` (a text cache beside new audio stays
`'exact'`), a listing that covers fewer tokens than were cached leaves it unknown, and cached tokens with
neither `promptTokensDetails` nor `cacheTokensDetails` cannot rule out audio in the cached content, so they
carry a warning and the cost is `'estimated'`.
There is no batch tier: `'batch'` is an unpriced tier.

`GoogleCacheStore.create` and `getOrCreate` return a handle with `totalTokenCount`, the create response's
`usageMetadata.totalTokenCount`. Cache storage is billed per token-hour and appears in no usage record;
price it from that count and the time you keep the cache.

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
`textRange` (the first supported span of `result.text`, UTF-16 offsets). Gemini measures its segment
offsets in UTF-8 bytes into the answer part (verified on a live Japanese and emoji answer), and its
`partIndex` does not count thought parts. Every range is checked against `segment.text`: when the
answer at the converted range is not exactly that text, the range is dropped, the source stays
`cited: true`, and the result carries a warning, so a `textRange` is never a guess.

Google requires a grounded answer to display its Search Suggestions: the widget is at
`result.providerMetadata.google.searchEntryPoint` and is stored only there (the raw
`providerMetadata.groundingMetadata` omits it, so persisted rows hold the HTML once). Its
`renderedContent` is HTML and CSS that Google generates around model-chosen query strings: treat it
as untrusted markup. Render it in a sandboxed `<iframe>` (for example `sandbox` with no
`allow-scripts` and `srcdoc`), never inject it into your page's DOM with `innerHTML`.

`countTokens` counts `messages`, `system` and `tools`. The SDK's Developer API method cannot carry
`system` or `tools`, so with either present the library calls the REST `countTokens` with a full
`generateContentRequest` (a messages-only count still goes through the SDK), and the count covers the
same request `generate()` would send. Tool schemas are held to the same JSON Schema profile as
`generate()`. `cachedContent` is not part of a count.

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
at standard tier (it fires only on an HTTP 503; a Flex 429 is an ordinary rate limit and honours `RetryInfo`); it cannot prevent a provider-side remap after dispatch.
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
