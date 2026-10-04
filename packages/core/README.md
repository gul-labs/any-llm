# @gullabs/core

The provider-agnostic heart of any-llm. Contains all types, port interfaces, the engine pipeline, call-site definitions, cost computation, and the persisted record builder. Has no provider dependencies.

## Install

```bash
pnpm add @gullabs/core
```

Every other `@gullabs/*` package declares this one as an exact-version peer dependency, so all
`@gullabs/*` packages must be installed at the same version; see
[Versioning](../../RELEASING.md#versioning-one-version-for-every-package).

`@gullabs/core` has no provider adapter and no SDK dependency of its own — pair it with
`@gullabs/google` (or another `ProviderAdapter`) to actually make calls.

## Key exports

| Export                       | What it is                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `createClient(config)`       | Wires ports into a `{ generate, runStructured, countTokens }` client                               |
| `composeProviders(plugins)`  | Merges one or more `ProviderPlugin`s into `ClientConfig` fields                                    |
| `createModelRegistry(descs)` | Builds a `ModelRegistry` (`resolve`, `findByModel`, `listDescriptors`) from `ModelDescriptor`s     |
| `toConfigKeys(schema)`       | Derives `ModelDescriptor.configKeys` from a model's config schema                                  |
| `defineCallSite(opts)`       | Defines a typed, reusable prompt template bound to a model                                         |
| `computeCost(...)`           | Pure, provider-agnostic cost function (providers supply their own rates)                           |
| `LlmError`                   | Typed error class — always thrown on call failure                                                  |
| `spendPreflightMiddleware`   | Advisory per-key spend check against your own ledger (`spend_ceiling`); see "Middleware"           |
| `canonicalJson(value)`       | RFC 8785 JSON Canonicalization Scheme (dependency-free), for hashing JSON independent of key order |
| `assertPortableJsonSchema`   | Build-time lint: is this schema inside what both Gemini 3.x and xAI enforce? (see "JSON Schema")   |
| `assertStandardJsonSchema`   | Rejects OpenAPI-dialect schemas (`nullable`, uppercase types, boolean subschemas)                  |
| `assertJsonSchemaProfile`    | What provider adapters call: checks a schema against the keywords a provider enforces              |
| `buildRecord(input)`         | Assembles an `LlmCallRecord` from engine state (used internally)                                   |

Core carries **no provider knowledge** — no Gemini/Google types, model descriptors, or pricing
tables. `ClientConfig.modelRegistry` is required; supply it via a provider package's plugin, e.g.
`googleProvider()` from `@gullabs/google`.

Port interfaces you implement: `ProviderAdapter`, `UsageSink`, `PricingSource`, `RateLimiter`, `Clock`, `Scheduler`, `IdGenerator`, `Logger`, `Telemetry`.

## Quick example

```ts
import { createClient, composeProviders, defineCallSite } from '@gullabs/core'
import type { UsageSink } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'

declare const mySink: UsageSink // your sink, e.g. drizzleUsageSink({ db })

const client = createClient({
  ...composeProviders([googleProvider()]),
  sink: mySink,
})

const callSite = defineCallSite({
  id: 'summarise',
  provider: 'google',
  model: 'gemini-2.5-flash',
  jsonSchema: {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
  },
  userTemplate: 'Summarise: {{text}}',
  config: { reasoning: { includeThoughts: true } },
})

// Auth is required per call — never read from the environment.
const result = await client.runStructured(
  callSite,
  { text: 'hello world' },
  {
    auth: { apiKey: 'YOUR_KEY' },
  },
)
// result.output   — JSON-parsed; caller validates
// result.outputParsed — true only when the provider's response text was
//                        successfully JSON.parsed. The engine does NOT
//                        validate output *shape* against jsonSchema — that
//                        stays the caller's job (reject, don't map: any
//                        shape mismatch is the caller's to reject).
// result.usage    — { inputTokens, outputTokens, thinkingTokens, cachedInputTokens }
// result.cost     — { microUsd, usd, pricingVersion, confidence, details: { input, cached, output, tools } }
// result.reasoningText — thought summary if includeThoughts was set
// result.queueDelayMs — wait inside RateLimiter.acquire, separate from latencyMs
```

`runStructured` takes the same per-call options as `generate`: `externalId` (a correlation id persisted on every
attempt row), `attachments` (parts appended to the rendered user message, after its text), `history` (earlier
turns, prepended and sent unchanged) and `transientProviderState` (the previous result's continuation state, for
models that declare `capabilities.providerState`). A template that renders to nothing (or to whitespace) is fine
when there are attachments (the message is the attachments alone); with neither, the call is `bad_request` before
dispatch. Every `attachments` element must be a part object and every `history` element a `{ role, parts }`
message, else `bad_request` naming the path (`history[1].parts[0].kind`); `generate` checks `messages` the same
way. `history` also gets `generate`'s checks (no empty assistant message) and is sent as given: a history that
ends in a user message gives two consecutive user turns, never merged. A call site declares no tools, so
`tool-call` and `tool-result` parts in `attachments` or `history` are `bad_request`; a tool loop is a `generate`
loop (below). `history` continues a text or media conversation, and `transientProviderState` lets a follow-up
structured call reuse what the provider returned with the earlier result. The library still does not validate
`output` (ADR-009): validate it yourself and retry as you see fit.

## Tool loops: `message`, `continuation`, `transientProviderState`

The library runs no tool loop (ADR-029); the host does. Every successful result carries what the
host needs to continue one, and the rule differs by provider:

- `result.message` is the assistant's output as an ordered `Message` on **every** provider: text
  parts and tool calls in provider order, thought parts omitted (indices are over `message.parts`).
  `result.text` and `result.toolCalls` are conveniences derived from it (`toolCalls` is a copy, so
  editing its arguments does not change `message`). A response with nothing representable, such as
  one that spent its output cap on reasoning, has `message.parts === []`: do not append it to your
  history (an assistant message with no parts is `bad_request`), retry the call instead.
- `result.continuation` repeats the model descriptor's `capabilities.continuation`, so you do not
  need a registry lookup:
  - `'history'` (Gemini, grok-4.5/4.6, and every provider without replay state): append
    `result.message` to your history, send the **full** history, and pass
    `result.transientProviderState` back when it is present. On Gemini 3 that state is the thought
    signature overlay (see `@gullabs/google`); it is an overlay on _your_ history, not a copy.
  - `'state'` (grok-4.7): `result.transientProviderState` already holds the provider's own output.
    Send **only the new messages** plus the state. `result.message` is still returned, for display
    and your own storage, but must not be replayed.
- State is provider-scoped (`{ google: … }`, `{ xai: … }`; another provider's key is `bad_request`)
  and bound to the model string you sent. The next turn goes to the same `provider` and the same
  `model` string, an alias included: the library never rewrites an alias to the canonical id, and
  `result.model` (the id the provider returned) is not something to route on.

```ts
import { composeProviders, createClient } from '@gullabs/core'
import type { JsonValue, Message } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'

const client = createClient({ ...composeProviders([googleProvider()]) })
const auth = { apiKey: 'YOUR_KEY' }
const provider = 'google'
const model = 'gemini-3.6-flash'
const userMessage: Message = {
  role: 'user',
  parts: [{ kind: 'text', text: 'What is the weather in Paris?' }],
}
const runTool = async (name: string, args: JsonValue): Promise<JsonValue> => ({
  name,
  args,
})

const tools = [
  {
    name: 'get_weather',
    description: 'Current weather for a city',
    inputJsonSchema: { type: 'object', properties: { city: { type: 'string' } } },
  },
]
const base = { provider, model, tools } // one provider and model string for the whole loop
let messages: Message[] = [userMessage]
let state: JsonValue | undefined

for (;;) {
  const result = await client.generate(
    {
      ...base,
      messages,
      ...(state !== undefined ? { transientProviderState: state } : {}),
    },
    { auth },
  )
  if (result.toolCalls === undefined) break // result.text is the answer

  const results: Message = {
    role: 'user',
    parts: await Promise.all(
      result.toolCalls.map(async (c) => ({
        kind: 'tool-result' as const,
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        result: await runTool(c.toolName, c.args),
      })),
    ),
  }

  if (result.continuation === 'history') {
    messages = [...messages, result.message, results] // full history, unedited
  } else {
    messages = [results] // 'state': only the new messages
  }
  state = result.transientProviderState
}
```

`@gullabs/testing` ships `runToolLoop(client, req, tools, { auth })`, which follows
`result.continuation` after every turn so host tests exercise the right contract.

`canonicalJson(value)` is the RFC 8785 JSON Canonicalization Scheme, with no dependency. Adapters
use it to hash history parts so a hash does not depend on key order (a history stored in Postgres
`jsonb` verifies after it is loaded). It accepts `JsonValue` only; `NaN`, `Infinity`, lone
surrogates, cycles, nesting deeper than 1000 levels, symbol keys and non-plain objects (class
instances, `Date`, `Map`) are `bad_request`; plain objects from another realm are accepted. `-0` is
serialised as `0`, as RFC 8785 requires, so a value hashes the same after a JSON round trip.
`sha256Hex(input)` is the SHA-256 of a string (as UTF-8) or a `Uint8Array`, as 64 lowercase hex characters: synchronous, with no `node:crypto`, `Buffer` or WebCrypto, so the package loads on every runtime (README, "Runtimes"). Adapters pair it with `canonicalJson`.

A custom `ProviderAdapter` must set `AdapterResult.message` (the engine does not rebuild it from
`text` and `toolCalls`, because only the adapter knows the provider's interleaving). `countTokens`
returns `accuracy: 'exact' | 'lower-bound' | 'estimated'`; `'estimated'` means the provider counted
the history but the real call sends parts the count cannot include (for Gemini 3, the thought
signatures on replayed function calls).

## Model config boundary

Built-in descriptors own the model-config contract. Core owns only the generic
`ModelRegistry`/`ModelDescriptor` machinery — the actual Gemini/Gemma descriptors live in
`@gullabs/google`:

```ts
import { defaultGeminiRegistry } from '@gullabs/google'

const descriptor = defaultGeminiRegistry.resolve('google', 'gemini-3.6-flash')
if (!descriptor) throw new Error('unknown model')

// Derived JSON Schema for UI/forms.
const formSchema = descriptor.configJsonSchema

// Runtime parse for persisted or user-supplied config.
const parsedConfig = descriptor.configSchema.parse({
  reasoning: { effort: 'medium' },
  serviceTier: 'flex',
})
```

Use `descriptor.configJsonSchema` for form generation and
`descriptor.configSchema` for persisted/request-time validation. Do not use
`output.jsonSchema` as a substitute; that surface is only for output shaping.

Model ids resolve **exactly** (ADR-033): a request names a descriptor's canonical `model` or one
of its declared `aliases`, never a longer or shorter string. `gemini-2.5-flash-image` is not
priced or validated as `gemini-2.5-flash`; it is `bad_request` with the closest registered ids
listed. An alias is for a real provider version suffix: the request string is sent to the provider
unchanged, the call is priced under the canonical descriptor, and the ledger row records the string
the host sent. Adapters check their descriptor with `assertModelMatchesDescriptor`.

Every descriptor states `limits: { contextWindow, maxOutputTokens }` (required, taken from the provider's
documentation; `createModelRegistry` rejects missing or inconsistent limits). `maxOutputTokens` is a number the
provider documents, or `null` when it documents no output limit for the model (xAI Grok 4.x, Gemma 4): nothing
is invented, the config schema applies no cap, and the provider decides what it accepts. `null` is not
"unlimited" and not the context window. A numeric limit caps the config schema's `maxOutputTokens`
(`maxOutputTokensSchema(limits)` builds that field). `capabilities.inputMimeTypes` is the one statement of what
media a model takes in `inline-media` and `file-uri` parts: lower-case `type/subtype` entries, or a family
wildcard `type/*`; absent or empty means no media. Adapters reject any other type, and an empty or missing one,
with `bad_request` before dispatch through `assertInputMimeTypesAdmitted`. The match ignores case and
`; parameters` (`IMAGE/PNG`, `text/plain; charset=utf-8`) and the string you sent goes to the provider
unchanged; nothing is mapped, so `image/jpg` is not `image/jpeg`. `isMediaTypeAdmitted(type, list)` and
`assertMediaTypeAdmitted` expose the same rule. There are no `vision` / `audioInput` flags: read
`inputMimeTypes`. A host-authored descriptor for a model that takes media must list its types. A descriptor may carry `shutdownDate` (`YYYY-MM-DD`, UTC), the provider's announced end of service for the model: the first successful call per client and model within `SHUTDOWN_WARNING_DAYS` (90) days of it, or past it, has a `{ type: 'shutdown', shutdownDate, message }` warning naming the date and the days left (or gone by); later calls on that client do not repeat it. The call is never refused for it (ADR-043). The registry
freezes each descriptor's `limits`, `inputMimeTypes`, `aliases` and `configKeys`. See ADR-033, Amendments A
and C.

Introspection (ADR-033, Amendment B): `registry.findByModel(model)` returns every descriptor that names the
string as its canonical id or a declared alias, across providers (an array, empty when unknown; the same bare id
can exist under several providers), and `registry.listDescriptors()` lists them all. `descriptor.configKeys` is
the sorted list of top-level config keys the model's schema names, flattened across the branches of a union
(`toConfigKeys(configSchema)` derives it; `createModelRegistry` rejects a list, or a `configJsonSchema`, that
differs from what `configSchema` yields). It lists names, not
which combinations are valid: the schema decides that. There is no helper that prunes a config for a model: a
host with provider-neutral config builds each target's config explicitly and can check it against `configKeys`.
`resolve`, `findByModel` and `listDescriptors` all answer from the list of descriptors the registry was built
with (a copy taken at construction; descriptors added to your array later are not part of it). A custom
`ModelRegistry` must implement all three.

Model-specific reminders:

- `reasoning.budgetTokens` belongs to Gemini 2.5 budget-api models.
- Gemini 3 and Gemma built-ins should use `reasoning.effort`.
- `gemini-3.1-pro-preview`, `gemini-3.7-flash`, and `gemini-3.8-flash` do not admit `effort: 'none'`.
- Registered Google ids: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`, `gemini-3.6-flash`, `gemini-3.7-flash`, `gemini-3.8-flash`, `gemma-4-31b-it`, `gemma-4-26b-a4b-it`. Deleted, with no alias: `gemini-3-flash-preview`, `gemini-3.5-flash`.
- Omit `serviceTier` for provider-standard requests; set `flex` explicitly.
- `priority` remains rejected by the library until the contract is fully
  modeled and tested.

`output.jsonSchema` constrains the model; the engine does not enforce it on the result. It is
forwarded to the provider, and the adapter JSON-parses the response when it is set. Always check `outputParsed` before
trusting `output`, then validate its shape yourself — see
[`docs/structured-output-validation.md`](../../docs/structured-output-validation.md) for a
Standard-Schema-based helper.

## JSON Schema

`output.jsonSchema` and `tools[].inputJsonSchema` are **standard JSON Schema (2020-12 subset)**
(ADR-034). The Google and xAI adapters enforce that contract; `claude-cli` passes the schema to the
CLI untouched and `codex-cli` runs its own OpenAI-strict preflight, so neither rejects `nullable`
or uppercase types. Google and xAI accept every keyword and silently ignore the ones they do not
enforce, so each of those adapters rejects a keyword it would ignore with `bad_request` and the
path (`output.jsonSchema.properties.kind`, `tools[1].inputJsonSchema...`) before dispatch. A
malformed schema is rejected the same way: a value in a schema position that is not a schema, a
keyword value of the wrong type (`maxLength: '3000'`), an invalid `pattern`, a `$ref` that points
at data, a cyclic JavaScript object (use `$ref` / `$defs`) or nesting deeper than 128. Nothing is
rewritten, and annotations (`$schema`, `$id`, `$comment`, `title`, `description`, `examples`,
`default`, `deprecated`, `readOnly`, `writeOnly`) are accepted by every profile. Only the 2020-12
spellings are accepted (`$defs`, not `definitions`).

The **portable subset** is what both the Gemini 3.x and xAI profiles enforce: `type` (a type array
only as one type plus `'null'`), `properties`, `required`, `additionalProperties`, `enum`, `anyOf`,
`$ref` / `$defs` (local and non-circular), `items`, `prefixItems`, `minItems` / `maxItems`,
`minimum` / `maximum`, `pattern`, `minLength` / `maxLength`, and `format` for `date-time`, `date`
and `email`. It is not "every provider": Gemma 4 additionally rejects `format`, `minLength` and
`maxLength` (it ignored them), the CLI providers do not run these checks, and `pattern`,
`minLength` and `maxLength` are only probabilistically obeyed on Gemini, so a schema inside the
subset still needs host-side validation of `output`. Lint every call site in a host test:

```ts
import { assertPortableJsonSchema } from '@gullabs/core'
import type { JsonValue } from '@gullabs/core'
import { z } from 'zod'

const Report = z.object({ title: z.string(), score: z.number() })

assertPortableJsonSchema(z.toJSONSchema(Report) as JsonValue, 'call:report') // throws LlmError('bad_request') with the path
```

What Zod emits that is outside the subset: `z.literal('x')` emits `const` (write
`z.enum(['x'])`); `z.discriminatedUnion` emits `oneOf`, which providers read as `anyOf` (write
`z.union`, which emits `anyOf`); `z.tuple` emits `items: false`; `z.union` of primitives emits a
multi-type array (use `z.enum` for strings, or give the union object variants); a recursive type
emits a recursive `$ref`, which xAI does not support; `z.record(z.enum([...]), X)` and
`z.record(z.string().regex(...), X)` emit a constraining `propertyNames`. `z.record(z.string(), X)`
works: its `propertyNames: { type: 'string' }` constrains nothing and is accepted. Zod's
`startsWith`, `endsWith` and `includes` emit a non-standard `format` next to a `pattern`; the
`format` is rejected, so chain `.meta({ format: undefined })` after the check (the pattern stays) or
write `z.string().regex(...)`. `z.iso.duration()` also emits a `format` and a lookahead pattern:
validate durations host-side. `z.toJSONSchema(schema, { reused: 'ref' })` emits `$defs` / `$ref`,
which both providers accept.

## Input contracts

Request-side validation, symmetric to the output boundary above. `{{var}}` template
placeholders in `callSite.system`/`callSite.userTemplate` are strict by default: an
unresolved, `null`, or non-string value throws `LlmError('bad_request')` before any
request is built. Two opt-in `StandardSchemaV1` contracts add business-field validation
— `callSite.inputSchema` for `runStructured`, `request.inputContract` for `generate()`
— and `createClient({ requireInputContract: true })` makes one of them mandatory on
every call. Violations carry a structured `issues` array on `LlmError`. See ADR-025 in
`../../DECISIONS.md` for the full design, including which refusals write ledger rows.

`createClient({ strictPricing: true, ... })` performs an opt-in construction-time check that every
registered model resolves to a priced entry. Runtime pricing remains fail-open: pricing failures do
not fail LLM calls.

## Logging & Observability

### Logger

Inject a pino-compatible structured logger via `ClientConfig.logger`. The `Logger` port uses an
object-first `(o, m)` signature:

```ts no-check
import pino from 'pino'

const client = createClient({
  ...composeProviders([googleProvider()]),
  logger: pino(),
})
```

Four levels: `debug`, `info`, `warn`, `error`. Every event, its level and its fields are listed in
[`docs/log-events.md`](https://github.com/gul-labs/any-llm/blob/main/docs/log-events.md): the call lifecycle
(`llm.call.start`, `llm.call.attempt.start`, `llm.call.attempt.dispatch`, `llm.call.retry`,
`llm.call.retry.stopped`, `llm.call.success`, `llm.call.error`, `llm.call.cost.failed`), the sink and payload
events (`llm.call.sink.*`, `llm.call.payload.*`), `llm.count_tokens.*`, `llm.adapter.dispatch` and the quota events.

A host logger that throws, or returns a promise that rejects, never breaks a call and never becomes an
unhandled rejection: the failure is logged once, at `debug`, as `llm.hook.failed` (fields `callId`, `phase`,
`error`), and a logger that always fails is not logged about again.

### Telemetry

Inject a `Telemetry` hook via `ClientConfig.telemetry` for OTel / Sentry / PostHog integration.
All four methods (`onStart`, `onAttempt`, `onSuccess`, `onError`) are optional. `onStart`, `onSuccess`
and `onError` fire once per logical call; `onAttempt` fires once per provider attempt, after the attempt's
ledger row was handed to the sink, with `attemptNumber`, `usage`, `cost` and, on failure, `errorKind`,
`reason` and `retryable` (a refusal that never reached an attempt emits none). The opaque value returned by
`onStart` is forwarded as `span` to the others. Hook failures are swallowed fail-open, including a hook
written `async` whose promise rejects (no unhandled rejection; the failure is one `debug` event,
`llm.hook.failed`, with the `phase`). The engine never awaits a hook. `CallErrorEvent`
carries `errorKind`, `retryable`, `reason` when the error has one, and `usage` and `cost` of the last
failing attempt when it reported usage. `LlmResult.callCost` is `{ microUsd, attempts, unpricedAttempts }`
(`result.cost` is the successful attempt alone): `microUsd` sums the attempts that were priced, retries and
billed failures included; `attempts` counts the attempts that began; `unpricedAttempts` counts attempts that
were dispatched but have no priced usage (a timeout, abort or connection failure that reported no usage, usage
the pricing source could not price). The provider may have billed those, so **`unpricedAttempts > 0` means
`microUsd` is a lower bound**. An attempt known to cost nothing (rejected before dispatch, a provider 400, 401
or 429, any other HTTP error answer) is not counted, unless the error says the provider had started work
(`LlmError.mayHaveBilled`, set for an error event inside an open xAI stream). `CallSuccessEvent` and `CallErrorEvent` carry the same
`callCost`, so an `onSuccess`-only metrics hook can read the total.

### Error reasons

`LlmError.kind` and `retryable` say what class of failure happened. `LlmError.reason` says why within
the kind, from the closed `LlmErrorReason` union (`transport_timeout`, `quota_window`, `daily_quota`,
`credits_exhausted`, `spend_ceiling`, `grounding_missing`, `cache_not_found`, `quota_store_unavailable` (a quota store failed or timed out: `server`, not retryable, the store's error is the `cause`)). It is absent when no named cause applies. The reason is also persisted:
`LlmCallRecord.errorReason`, the `error_reason` column of `@gullabs/drizzle`, and `CallErrorEvent.reason`.
The union is closed so adapters cannot invent reasons; a new member arrives in a core minor, so keep a
`default` branch when you switch on it. See ADR-036.

### Output budget and reasoning

Thinking budgets and the effort-to-budget defaults are documented per provider; see the
[`@gullabs/google` README](../google/README.md#thinking-budgets-and-the-output-cap). The library warns when a
budget model's thinking budget is at or above `maxOutputTokens`, and does not reject it.

`GenConfig.maxOutputTokens` includes reasoning tokens on providers that reason. When a call ends with
`finishReason: 'length'`, produced no answer text and no tool call, and spent reasoning tokens, the result
and the record carry a warning that the cap was used up by reasoning. Raise the cap or lower the reasoning
effort. A whitespace-only text counts as no answer. Only the Google and xAI adapters report
`finishReason: 'length'`; the `claude-cli` and `codex-cli` adapters never do, so the warning cannot fire for
them.

### LlmCallRecord and UsageSink

Every call attempt is persisted via `UsageSink.record(r: LlmCallRecord)`. The sink must be
idempotent on `r.attemptId`. Key traceability fields: `callId` (stable across retries),
`attemptId`, `attemptNumber` (1-based), `latencyMs`, token counts, `costMicroUsd`, `errorKind`,
`queueDelayMs`, and `metadata` (host-supplied, stored verbatim). `latencyMs` measures provider
dispatch only; `queueDelayMs` measures pre-send wait inside `RateLimiter.acquire`.

Record version 2 (`recordSchemaVersion: 2`, ADR-039) persists the cost facts the engine computes:
`costConfidence` (`'exact'` or `'estimated'`), `costDetails` (`{ input, cached, output, tools }` in
micro-USD, only when priced) and `costUnpricedReason` (only when `costMicroUsd` is `null`). `reasoningText`
and `errorMessage` are capped at 16 KiB (UTF-8) with a `…[truncated]` marker and a warning; the live result
and error keep the full text. `Cost.providerReported` carries the total a provider itself reports billing
(xAI) and the engine warns when it drifts from the priced total.

Every provider attempt is its own billed row with its own minted `attemptId`. A call whose final
error did not come out of an attempt (input-contract refusal, middleware refusal, quota deferral, retry
budget exhausted) also writes one zero-usage, unbilled refusal row: `attemptNumber: 0` when no attempt
had run, otherwise the refused attempt's number. A gap in attempt numbers means "refused before
dispatch". The library never deduplicates provider calls, and nothing a host passes
in becomes an `attemptId`. To tie host-level retries of one operation together, give every retry the
same `externalId`: it is persisted on every attempt row (indexed in `@gullabs/drizzle`), so a host
retry that reuses it shows up as extra rows under one `externalId`, each with the spend it caused.
Correlate the final outcome of a call from `result.attemptId` or `LlmError.attemptId`. The sink's
`attemptId` idempotency only absorbs an at-least-once sink re-delivering the same record.

### Payload storage (opt-in)

By default the full prompt and response text is not stored. `ClientConfig.payloads` turns it on for the client:

```ts
import { composeProviders, createClient } from '@gullabs/core'
import type { CallSite, LlmRequest } from '@gullabs/core'
import { drizzleUsageSink } from '@gullabs/drizzle'
import { googleProvider } from '@gullabs/google'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

declare const db: NodePgDatabase
declare const request: LlmRequest
declare const auth: { apiKey: string }
declare const callSite: CallSite
declare const vars: Record<string, string>
declare function scrubCustomerData<T>(payload: T): T

const client = createClient({
  ...composeProviders([googleProvider()]),
  sink: drizzleUsageSink({ db }), // a sink must declare acceptsPayloads: true to receive payloads
  payloads: {
    redact: (payload) => scrubCustomerData(payload), // optional, synchronous; runs after core's secret patterns
    maxChars: 200_000, // optional, at least 1,000; per string, and 4x for the whole payload
    include: (request) => request.metadata?.['audit'] === true, // optional, synchronous; only `true` captures
  },
})

await client.generate(request, { auth, storePayload: false }) // this call is not stored
await client.runStructured(callSite, vars, { auth, storePayload: false })
```

Every attempt that reached the provider adapter, success or failure, hands the sink one payload next to its
record: `sink.record(record, { payload })`. It holds the request as dispatched (`system`, messages as
`{ role, parts }`, text verbatim, tool-call arguments and tool-result values as JSON, tools as name and schema
hash; an inline image, audio or file part is only its media type, size and SHA-256, never the bytes; a
`file-uri` without its userinfo, query string and fragment) and the raw model text, or the error message of a
failed attempt. The request is snapshotted at dispatch, so what is stored is what was sent even if you change
your request while the call is in flight, and `include` is called once per attempt at that moment.

The payload is built after the attempt's outcome is known, inside the `sinkTimeoutMs` wait, and in this order
for every string: U+0000 and unpaired surrogates are stripped, the string is cut to `maxChars + 256` characters
(at a token edge, so a secret cut in half does not survive as a fragment), core's `redactSecrets` patterns run,
then your `redact` runs on the whole payload, then the caps run last (`maxChars` per string, `4 x maxChars`
for the whole payload: the largest strings, then the largest tool arguments and results, become a marker), and
U+0000 is stripped once more. A secret split by U+0000 is therefore redacted whole, and a redactor cannot push
stored text over the limit. A large payload yields to the event loop between steps; when `sinkTimeoutMs` or an
abort ends the wait first, the payload is dropped with an `llm.call.payload.dropped` warning and the ledger row
is still written. A synchronous `redact` cannot be interrupted: keep it fast. Inline media above 20 MiB is
stored as `{ mimeType, bytes, sha256: null, skipped: 'too_large' }` and data that is not valid base64 as
`{ skipped: 'invalid_base64' }`; neither drops the payload. Hashing needs about 1 MiB of extra memory per part
at any moment, not a decoded copy.

What the core patterns cover (best-effort, credentials only, never personal data): Google API keys (`AIza…`,
`ya29.…`), `sk-…` keys, GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`), `xai-…` keys, AWS
access key ids, `Bearer` tokens in any case, the credential after any `Authorization:` scheme (`Basic`, ...),
and these `name=value` pairs in URLs and text, in any case: `X-Goog-*`, `X-Amz-*` (S3 presigned `Signature`,
`Credential`, `Security-Token`), `sig` (Azure SAS), `signature`, `token`, `key`, `api_key`, `access_token`,
`refresh_token`, `id_token`, `client_secret`, `password`, `passwd`, `secret`, `authorization`, `credential`. In
tool-call arguments and tool-result values the value of an object key named like `password`, `secret`, `token`,
`api_key`, `authorization`, `credential` or `private_key` (any case, as a substring, so `max_tokens` is replaced
too) is replaced with `[REDACTED]`. A payload that cannot be built (a throwing `redact`, a payload that cannot
get under the cap, a wait that ended first) is dropped with an `llm.call.payload.dropped` warning carrying the
stage, the error class and a fixed sentence, never the error's text, and never fails the call.

`payloads` needs a `sink`, and the sink must declare `acceptsPayloads: true` (`drizzleUsageSink` and
`RecordingSink` do). Without it `createClient` logs one `llm.config.payloads.sink_ignores_payloads` warning and
no payload is built. An `async` `redact` or `include` is `bad_request` at `createClient`, and a Promise returned
at run time drops the payload (or skips the call, for `include`) with a warning.

**What `llm_calls` holds, whatever `payloads` says.** The payload options govern the payload table only. The
ledger row is written on every attempt and carries text too:

| Where                                                  | What it holds                                                                                                                                                          | Core secret patterns                                          | Governed by `payloads` / `include` / `storePayload` / purge and delete |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `llm_calls.reasoning_text`                             | The model's reasoning text, when the provider returns it (16 KiB cap)                                                                                                  | Yes                                                           | No                                                                     |
| `llm_calls.tool_calls`                                 | The tool calls the model made: id, name, arguments as JSON                                                                                                             | Yes: every string, and the value of a key named like a secret | No                                                                     |
| `llm_calls.error_message`                              | The error text of a failed attempt (provider error text, which can echo part of a request; 16 KiB cap)                                                                 | Yes                                                           | No                                                                     |
| `llm_calls.metadata`                                   | Your `CallMetadata` bag, verbatim (a circular, over-deep or unreadable part becomes a marker plus a row warning; the call and its row are never lost)                  | No, never scanned                                             | No                                                                     |
| `llm_calls.citations`                                  | Source URL, title and source name of a grounded answer                                                                                                                 | No                                                            | No                                                                     |
| `llm_calls.provider_metadata`, `raw_usage`, `warnings` | Provider-reported JSON and engine diagnostics                                                                                                                          | No                                                            | No                                                                     |
| `llm_calls.generation_config`                          | The call's settings; `providerOptions` is scrubbed (the Google adapter admits only `httpOptions.timeout`, so no headers are ever in it)                                | Partly                                                        | No                                                                     |
| `llm_call_payloads.request`                            | The system prompt; every message part (text, tool-call arguments, tool-result values); media as type, size and SHA-256; file references; tools as name and schema hash | Yes, then your `redact`                                       | Yes                                                                    |
| `llm_call_payloads.response`                           | The raw model text, or the attempt's error message                                                                                                                     | Yes, then your `redact`                                       | Yes                                                                    |

`storePayload: false`, `include` and the off-by-default setting never keep the `llm_calls` text columns out of
the ledger, and the purge and delete helpers do not touch them. A host that needs no text at all in the ledger
does not persist those columns: wrap the sink and drop them before delegating (an example is in
[`docs/ledger.md`](../../docs/ledger.md#what-each-table-holds)).

Stored text can contain customer data. The library never deletes it: retention and tenant deletion are yours
(`@gullabs/drizzle` ships `purgeLlmCallPayloads` and `deleteLlmCallPayloads` for the payload table; ADR-038).

## Middleware, retry and rate limiting

`ClientConfig.middleware` is an ordered list, outermost first. A middleware outside
`retryMiddleware` runs once per logical call; one inside it runs once per attempt. The
`RateLimiter` is acquired once per **attempt** (inside each retry), not once per logical call, and
is released when that attempt ends.

- **The limiter is fed.** `acquire(key, signal, hint)` receives `hint.estimatedInputTokens`, a cheap
  estimate of the attempt's input tokens (`estimateInputTokens(req)`, exported: text characters divided by
  4; media and file parts are not counted, so it is an estimate and a floor, never a count), and the
  `Release` the engine calls receives the attempt's normalized `Usage` when there is one (a success, or a
  billed failure that carries `usage`) and nothing otherwise (a timeout, an abort, a transport failure).
  A token-aware limiter (see `@gullabs/quota`'s `tpm`) paces on the first and reconciles with the second;
  a concurrency limiter ignores both.
- **Timers are injectable.** `ClientConfig.scheduler` (`{ setTimeout, clearTimeout }`) runs every wait the
  engine owns (the attempt timeout, the call deadline, the sink waits) and is given to middleware
  (`ctx.scheduler`, which `retryMiddleware` sleeps on) and to adapters (`AdapterCtx.scheduler`). The
  default is the platform's timers. `FakeClock` from `@gullabs/testing` is both the `clock` and a
  `scheduler`, so a test advances one object to fire timeouts and back-off. The scheduler must run
  callbacks on the same time scale as the `clock`: the deadline is read off the clock and enforced by
  these timers.

- **Middleware cannot reroute.** The `next` a middleware receives refuses a request whose `provider`
  or `model` differs from the call's: the call fails with `LlmError('bad_request')` as the offender
  calls `next` (before any inner middleware or the provider runs) and a zero-usage refusal row is
  written (`attemptNumber: 0` when no attempt had run, otherwise the refused attempt's number). The engine dispatches, validates, prices and authenticates with the identity it recorded
  at call start, so a middleware cannot change them even by mutating the request. Route in the host
  instead; see "Fallback" in the [root README](../../README.md#fallback). A quota unit taken by a
  middleware outside the offender is not refunded: the offender is a host bug.
- **Treat the request as immutable once passed to `next`.** To change data (config, messages,
  metadata), pass a new object to `next`. The engine does not copy or freeze requests, so mutating
  nested data in place after calling `next` is a host bug it cannot detect. The engine takes one shallow
  snapshot of your `LlmRequest` (and, for `runStructured`, the call site and options) when the call starts,
  so reassigning `request.metadata` or `externalId` mid-call changes nothing; **do not mutate nested
  objects (`messages`, `tools`, `metadata`) while a call is in flight.** `ctx.callId` is not read back: the
  engine keeps the id it minted.
- **`spendPreflightMiddleware({ limitMicroUsd, key, spentSoFar })` is an advisory spend check.** Your
  `spentSoFar(key)` reads the total (micro-USD) from your own ledger; at or above `limitMicroUsd` the call
  fails before dispatch with `rate_limited`, `retryable: false`, `reason: 'spend_ceiling'` (so retry does not
  sleep on it) and a refusal row is written. A ledger read that throws or rejects fails the call closed with
  `server`, `retryable: false` and your error as `cause` (not `rate_limited`, since no ceiling was reached, and not
  retryable, since a retry would read the same ledger). `key` is a string, or a function of the request for a client
  serving several scopes. It is **not an enforced ceiling**: the read and the dispatch are not atomic, so
  concurrent workers can overshoot; the call that crosses the ceiling is allowed; and billed calls whose usage
  is unknown (`microUsd: null`) are counted only if your ledger counts them. It sets no `role` and works
  anywhere in the list: first (outside retry) it runs once per logical call and consumes no quota; inside
  retry it re-reads `spentSoFar` before each attempt, and a provider failure followed by a ceiling hit leaves you
  with the `spend_ceiling` error (the provider's error is in the earlier attempt's row). An enforced ceiling needs atomic reservation and
  reconciliation (`BACKLOG.md`).
- **One deadline for the whole call.** `config.timeoutMs` starts when the call starts and is measured on
  the client `clock`. `ctx.deadlineAt` is its end and `ctx.signal` aborts when it passes, so a
  middleware that sleeps, retries or does I/O measures against those, never against the time it was
  entered. A result an attempt already produced is returned even if work after `next()` runs past the
  deadline; the deadline error otherwise carries the last attempt's error as `cause`.
- **Quota goes inside retry.** `[retryMiddleware(...), providerQuotaMiddleware(...)]` accounts one
  quota unit per provider dispatch. `createClient` rejects the opposite order with `bad_request`. It
  identifies the built-ins by the readonly `Middleware.role` they set (`'retry'`, `'quota'`), never
  by `id`. The check runs over a copy of the list frozen at `createClient`. A wrapper or composed
  middleware that does not carry the inner one's `role` is not detected.
- **Registry results are re-checked.** After `registry.resolve` the engine verifies that the descriptor
  belongs to the provider and that the requested string is its canonical id or a declared alias, so a
  host `ModelRegistry` that prefix-matches or falls back is refused, not mispriced.

### Redaction

`redactSecrets` runs automatically on `errorMessage` and
`generationConfig.providerOptions` before persistence. Standard knobs and `metadata` are not
scanned — do **not** put secrets in `metadata`.

## Token convention

**GROSS**: `cachedInputTokens` is a subset of `inputTokens`; `thinkingTokens` is a subset of `outputTokens`. Cost math never double-counts. See `SPEC.md` for the full invariant.

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`SPEC.md`](../../SPEC.md) — v1 build contract: goals, invariants, type definitions, engine pipeline
- [`docs/architecture.md`](../../docs/architecture.md) — canonical engineering deep-dive
- [`docs/structured-output-validation.md`](../../docs/structured-output-validation.md) — validating `result.output` after `outputParsed`
