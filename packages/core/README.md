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
| `createClient(config)`       | Wires ports into a `{ generate, runStructured }` client                                            |
| `composeProviders(plugins)`  | Merges one or more `ProviderPlugin`s into `ClientConfig` fields                                    |
| `createModelRegistry(descs)` | Builds a `ModelRegistry` from an array of `ModelDescriptor`s (exact ids + declared `aliases`)      |
| `defineCallSite(opts)`       | Defines a typed, reusable prompt template bound to a model                                         |
| `computeCost(...)`           | Pure, provider-agnostic cost function (providers supply their own rates)                           |
| `LlmError`                   | Typed error class — always thrown on call failure                                                  |
| `canonicalJson(value)`       | RFC 8785 JSON Canonicalization Scheme (dependency-free), for hashing JSON independent of key order |
| `buildRecord(input)`         | Assembles an `LlmCallRecord` from engine state (used internally)                                   |

Core carries **no provider knowledge** — no Gemini/Google types, model descriptors, or pricing
tables. `ClientConfig.modelRegistry` is required; supply it via a provider package's plugin, e.g.
`googleProvider()` from `@gullabs/google`.

Port interfaces you implement: `ProviderAdapter`, `UsageSink`, `PricingSource`, `RateLimiter`, `Clock`, `IdGenerator`, `Logger`, `Telemetry`.

## Quick example

```ts
import { createClient, composeProviders, defineCallSite } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'

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
// result.cost     — { microUsd, pricingVersion, details: { input, cached, output } }
// result.reasoningText — thought summary if includeThoughts was set
// result.queueDelayMs — wait inside RateLimiter.acquire, separate from latencyMs
```

## Tool loops: `message`, `continuation`, `transientProviderState`

The library runs no tool loop (ADR-029); the host does. Every successful result carries what the
host needs to continue one, and the rule differs by provider:

- `result.message` is the assistant's output as an ordered `Message` on **every** provider: text
  parts and tool calls in provider order, thought parts omitted (indices are over `message.parts`).
  `result.text` and `result.toolCalls` are conveniences derived from it.
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
`jsonb` verifies after it is loaded). It accepts `JsonValue` only; `NaN`, `Infinity`, `-0`, lone
surrogates, cycles and non-plain objects are `bad_request`.

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

Model-specific reminders:

- `reasoning.budgetTokens` belongs to Gemini 2.5 budget-api models.
- Gemini 3 and Gemma built-ins should use `reasoning.effort`.
- `gemini-3.1-pro-preview`, `gemini-3.7-flash`, and `gemini-3.8-flash` do not admit `effort: 'none'`.
- Registered Google ids: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`, `gemini-3.6-flash`, `gemini-3.7-flash`, `gemini-3.8-flash`, `gemma-4-31b-it`, `gemma-4-26b-a4b-it`. Deleted, with no alias: `gemini-3-flash-preview`, `gemini-3.5-flash`.
- Omit `serviceTier` for provider-standard requests; set `flex` explicitly.
- `priority` remains rejected by the library until the contract is fully
  modeled and tested.

`output.jsonSchema` is a provider hint, not an engine-enforced contract: it is forwarded to the
provider and used only to gate JSON parsing. Always check `outputParsed` before trusting `output`,
then validate its shape yourself — see
[`docs/structured-output-validation.md`](../../docs/structured-output-validation.md) for a
Standard-Schema-based helper.

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

```ts
import pino from 'pino'

const client = createClient({
  ...composeProviders([googleProvider()]),
  logger: pino(),
})
```

Four levels: `debug`, `info`, `warn`, `error`. Engine events:

| Event                    | Level                                                                   |
| ------------------------ | ----------------------------------------------------------------------- |
| `llm.call.start`         | `info`                                                                  |
| `llm.call.attempt.start` | `debug`                                                                 |
| `llm.call.retry`         | `debug` — includes `attemptNumber`, `delayMs`, `errorKind`, `retryable` |
| `llm.call.success`       | `info`                                                                  |
| `llm.call.error`         | `error`                                                                 |
| `llm.call.cost.failed`   | `warn`                                                                  |
| `llm.call.sink.success`  | `debug`                                                                 |
| `llm.call.sink.failed`   | `error` (redacted)                                                      |

Host logger exceptions are swallowed by `makeSafeLogger` — fail-open; a bad logger never breaks a
call.

### Telemetry

Inject a `Telemetry` hook via `ClientConfig.telemetry` for OTel / Sentry / PostHog integration.
All three methods (`onStart`, `onSuccess`, `onError`) are optional and fire once per logical call
(not per attempt). The opaque value returned by `onStart` is forwarded as `span` to `onSuccess`
and `onError`. Hook failures are swallowed fail-open. `CallErrorEvent` carries `errorKind`, `retryable`
and, when the error has one, `reason`.

### Error reasons

`LlmError.kind` and `retryable` say what class of failure happened. `LlmError.reason` says why within
the kind, from the closed `LlmErrorReason` union (`transport_timeout`, `quota_window`, `daily_quota`,
`credits_exhausted`, `spend_ceiling`, `grounding_missing`, `search_budget_exceeded`,
`cache_not_found`). It is absent when no named cause applies. The reason is also persisted:
`LlmCallRecord.errorReason`, the `error_reason` column of `@gullabs/drizzle`, and `CallErrorEvent.reason`.
The union is closed so adapters cannot invent reasons; a new member arrives in a core minor, so keep a
`default` branch when you switch on it. See ADR-036.

### Output budget and reasoning

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

## Middleware, retry and rate limiting

`ClientConfig.middleware` is an ordered list, outermost first. A middleware outside
`retryMiddleware` runs once per logical call; one inside it runs once per attempt. The
`RateLimiter` is acquired once per **attempt** (inside each retry), not once per logical call, and
is released when that attempt ends.

- **Middleware cannot reroute.** The `next` a middleware receives refuses a request whose `provider`
  or `model` differs from the call's: the call fails with `LlmError('bad_request')` as the offender
  calls `next` (before any inner middleware or the provider runs) and a zero-usage refusal row is
  written (`attemptNumber: 0` when no attempt had run, otherwise the refused attempt's number). The engine dispatches, validates, prices and authenticates with the identity it recorded
  at call start, so a middleware cannot change them even by mutating the request. Route in the host
  instead; see "Fallback" in the [root README](../../README.md#fallback). A quota unit taken by a
  middleware outside the offender is not refunded: the offender is a host bug.
- **Treat the request as immutable once passed to `next`.** To change data (config, messages,
  metadata), pass a new object to `next`. The engine does not copy or freeze requests, so mutating
  nested data in place after calling `next` is a host bug it cannot detect.
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
