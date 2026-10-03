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

| Export                       | What it is                                                               |
| ---------------------------- | ------------------------------------------------------------------------ |
| `createClient(config)`       | Wires ports into a `{ generate, runStructured }` client                  |
| `composeProviders(plugins)`  | Merges one or more `ProviderPlugin`s into `ClientConfig` fields          |
| `createModelRegistry(descs)` | Builds a `ModelRegistry` from an array of `ModelDescriptor`s             |
| `defineCallSite(opts)`       | Defines a typed, reusable prompt template bound to a model               |
| `computeCost(...)`           | Pure, provider-agnostic cost function (providers supply their own rates) |
| `LlmError`                   | Typed error class — always thrown on call failure                        |
| `buildRecord(input)`         | Assembles an `LlmCallRecord` from engine state (used internally)         |

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
and `onError`. Hook failures are swallowed fail-open.

### LlmCallRecord and UsageSink

Every call attempt is persisted via `UsageSink.record(r: LlmCallRecord)`. The sink must be
idempotent on `r.attemptId`. Key traceability fields: `callId` (stable across retries),
`attemptId`, `attemptNumber` (1-based), `latencyMs`, token counts, `costMicroUsd`, `errorKind`,
`queueDelayMs`, and `metadata` (host-supplied, stored verbatim). `latencyMs` measures provider
dispatch only; `queueDelayMs` measures pre-send wait inside `RateLimiter.acquire`.

If a request includes `idempotencyKey`, attempt 1 uses that exact value as `attemptId`. In-process
library retries suffix later attempts (`key:2`, `key:3`, ...), so callers should correlate the final
outcome from `result.attemptId` or `LlmError.attemptId`. Temporal-owned activity retries that call
the library fresh each time keep the pre-minted key on attempt 1 and deduplicate only at the ledger
sink.

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
