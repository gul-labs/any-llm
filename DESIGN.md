# any-llm — Design Notes

For the canonical engineering overview, see [`docs/architecture.md`](./docs/architecture.md).
For individual architecture decisions, see [`DECISIONS.md`](./DECISIONS.md).

This document contains supplementary design notes: deeper rationale, future-scope contracts, and
forward-compatibility decisions that don't fit cleanly in either of the above.

---

## Design Principles

**P1 — The host owns the world; the library owns the contract.**
Everything environmental (DB, logger, telemetry sink, clock, id generation, secrets) is a port
the host implements. Credentials are no exception: the caller passes `auth` on every call; the
library never reads from `process.env` or any ambient source. The core is pure and deterministic
given its ports.

**P2 — Typed core + raw passthrough + raw capture.**
Every place where providers diverge has three lanes:

- A **typed lane** for common, well-understood options and fields (first-class, validated).
- A **provider extension lane** (`providerOptions`) for options each provider package defines and
  validates itself via `ProviderOptionsMap` declaration merging — a strict, per-model-schema
  allowlist (see "`providerOptions` Passthrough" below), not an unvalidated raw-SDK passthrough.
- A **raw capture lane** — adapters copy the provider's entire raw usage object and response
  metadata into the result and persisted record so a new usage field is never lost even before
  the library models it.

Promotion is an optional later step: move a field from raw to typed when it proves broadly useful.

**P3 — Adapters are thin and dumb; the engine is smart.**
Provider adapters do exactly one thing: translate `ResolvedRequest ↔ raw SDK`. They contain no
costing, no logging, no persistence, no retries, no schema validation. The adapter returns raw
parsed structured output and normalized usage; the engine handles everything else.

**P4 — Cost is frozen at write time.**
A ledger must be reproducible. Cost is computed when the call happens and stored as an integer
(micro-USD) alongside the pricing snapshot version used. Historical rows never recompute. If the
pricing snapshot is later corrected, affected rows can be backfilled using `pricingVersion` as the
identification key.

**P5 — Fail-open on side effects; fail-closed on the call.**
A broken sink, telemetry callback, or cost computation must never fail the LLM call. A broken
call fails loudly with a typed `LlmError`. The rate-limiter is the deliberate exception: `acquire`
rejection propagates because the port's purpose is to gate calls.

**P6 — Forward-compatible persistence.**
The `LlmCallRecord` has typed columns for queryable hot fields and `JsonValue` columns for open
maps (`tokenDetails`, `rawUsage`, `providerMetadata`, `generationConfig`). New fields from a
provider land in the JSONB lanes immediately; typed columns are added only when aggregation or
indexing requires them.

**P7 — Routing is a function of explicit `(provider, model)`, not of code wiring.**
Every request and call site carries an explicit top-level `provider` alongside the bare,
provider-native `model` string — the engine routes by `req.provider` directly and never derives
it from `model`. A request or call site naming an unconfigured provider, or a `(provider, model)`
pair absent from the registry, is rejected with `LlmError('bad_request')` rather than silently
falling through. This is what makes a model swap from a UI or DB flag actually work rather than
requiring a code change, while still letting the same bare model id exist under multiple
providers with different config schemas.

---

## Auth and Credentials

**No-ambient-reads invariant.** The library never reads credentials from `process.env`, a
credentials file, an instance metadata service, or any other ambient source. There is no
`envAuth()` helper and no `AuthProvider` port. The `AuthMaterial` type is
`{ apiKey: string, keyId?: string }` (plus the `{ cliSession: true }` variant below).

**Per-call model.** `auth` is a required option on every `generate()` and `runStructured()` call:

```ts
client.generate(request, { auth: { apiKey } })
client.runStructured(callSite, { auth: { apiKey }, vars: { ... } })
```

The caller decides where the key comes from. For a multi-call loop, build the `auth` object once
outside the loop and pass it on each iteration.

**CI enforcement.** A source-invariant test in the CI pipeline asserts that no file under
`packages/core/src` or `packages/google/src` imports or references `process.env`, and that
neither `AuthProvider` nor `envAuth` is re-exported from any package entrypoint.

**Vertex AI.** Removed in v0.2.x because it depended on Google Application Default Credentials
(ADC) — ambient discovery from environment variables, credential files, or the GCE metadata
service — which contradicts the no-ambient-reads invariant. It is on the roadmap to return with
an explicit, non-ADC credential shape. See ROADMAP.md.

**Secret redaction.** `auth.apiKey` is redacted from any persisted `LlmCallRecord` and from
error messages before they are written to the sink (via `redactSecrets` in `buildRecord`).
`auth.keyId` (ADR-026) is the opposite by design: an opaque, non-secret, caller-chosen label
persisted verbatim to `LlmCallRecord.authKeyId` for per-key attribution, and deliberately excluded
from redaction.

---

## Forward-Compatibility Design

### `providerOptions` Passthrough

`GenConfig.providerOptions` is typed as `ProviderOptionsMap` (`packages/core/src/types.ts`) — an
open, empty-by-default interface that provider packages extend via declaration merging, not a raw
`Record<string, JsonValue>` passthrough. `@gullabs/google` augments it with
`interface ProviderOptionsMap { google?: GoogleProviderOptions }` (`packages/google/src/types.ts`);
the `google` key only appears on the type once `@gullabs/google` is imported.

This is not an unbounded forwarding lane, either: `GoogleProviderOptions` is a strict allowlist
(`cachedContent`, `safetySettings`, `tools`, `httpOptions`, `flexFallback`) enforced per-model by
each Gemini/Gemma descriptor's own `configSchema` (see
[`docs/model-config-strict-schema-design.md`](./docs/model-config-strict-schema-design.md)) —
reserved fields such as `temperature`, `serviceTier`, or `thinkingConfig` are rejected inside
`providerOptions.google` rather than silently forwarded, and the adapter maps allowlisted fields
one-by-one instead of `Object.assign`-ing the raw object onto the SDK call. A brand-new SDK
parameter still requires a schema update to become admitted, not a full library release cut for
every provider package, but there is no unvalidated "anything goes" escape hatch — callers needing
genuinely raw SDK access should inject their own `ProviderAdapter` instead.

### `Usage.details` and `Usage.raw`

`Usage.details` is an open `Record<string, number>` keyed by canonical token type (`input`,
`output`, `cached`, `thinking`). New token types from providers land here before they receive
typed fields on `Usage`. `Usage.raw` stores the provider's complete usage metadata as `JsonValue`
so cost can be recalculated from the original data if the field mapping is later found to be
incorrect.

`LlmCallRecord` mirrors this: `tokenDetails` (the details map as JSONB) and `rawUsage` (the full
raw object as JSONB) are always written, even when the hot typed fields (`inputTokens`,
`outputTokens`, etc.) are also present.

### `LlmCallRecord.recordSchemaVersion`

Always `1` in this release. Increment on any breaking schema change to the record shape. Sinks
should check this field before deserializing records written by an older or newer engine version.

---

## Gemini Adapter Design Notes

### Reasoning API Variants

Gemini 2.5 series models use `thinkingConfig.thinkingBudget` (a token budget integer). Gemini 3.x
series models use `thinkingConfig.thinkingLevel` (an enum: `MINIMAL | LOW | MEDIUM | HIGH`). The
adapter branches on `req.modelDescriptor?.capabilities?.reasoningApi`:

- `'budget'` → map `effort` to the `EFFORT_BUDGET` table (`none: 0, low: 1024, medium: 8192,
high: 24576`); `budgetTokens` overrides `effort` directly.
- `'level'` → map `effort` to `MINIMAL / LOW / MEDIUM / HIGH`; `budgetTokens` is unsupported
  and throws `LlmError('bad_request')`.
- `undefined` → throws `LlmError('bad_request')`; do not set `thinkingConfig`.

When both `effort` and `budgetTokens` are set for a `'budget'` model, `budgetTokens` wins.

### Structured Output Path

`LlmRequest.output` is `{ jsonSchema: JsonValue }` — already a plain JSON Schema value, not a Zod
schema. When the resolved model's `capabilities.nativeStructuredOutput` is not explicitly `false`,
the adapter sets `responseMimeType: 'application/json'` and forwards `req.outputJsonSchema`
straight through as the Gemini `responseSchema` (a cast, not a conversion — there is no
schema-conversion step).

On the response side, the adapter `JSON.parse`s the model's text output into
`AdapterResult.rawStructured` when structured output was requested and parsing succeeds. The
engine surfaces this unchanged as `LlmResult.output: unknown` plus `outputParsed: boolean`, and
performs **zero shape validation** — it never checks the parsed value against `output.jsonSchema`
or any other schema. Validation, retry, and acceptance policy are entirely caller-owned; see
[`docs/structured-output-validation.md`](./docs/structured-output-validation.md) for the
recommended `validateStructuredResult` + Standard Schema v1 pattern.

### Multimodal Parts

`TextPart` → `{ text }`. `InlineMediaPart` → `{ inlineData: { mimeType, data } }`. `FileUriPart`
→ `{ fileData: { mimeType, fileUri } }`. The `mediaResolution` hint on media parts maps to
`{ mediaResolution: { level: 'MEDIA_RESOLUTION_LOW' | … } }` alongside the part object.

### Grounding and Conflict Guard

Grounding is requested via `providerOptions.google.tools: [{ googleSearch: {} }]`. The
`providerOptions.google` object is merged after typed-field mapping; transport/abort scaffolding
(`abortSignal`, `httpOptions`) is applied afterward, and caller-supplied `httpOptions` still wins. After the merge, the adapter checks whether any tool entry has a
`googleSearch` or `googleSearchRetrieval` key. If so and `req.outputJsonSchema` is also set, the
adapter throws `LlmError('bad_request', retryable: false)` immediately — Gemini does not support
grounding combined with `responseSchema`. When grounding is active, `candidate.groundingMetadata`
is captured alongside `promptFeedback` into `result.providerMetadata`.

### Transport Timeout

The `@google/genai` SDK's default HTTP transport timeout is ~60 s, too short for long Flex calls.
The adapter sets `config.httpOptions.timeout`:

- `serviceTier === 'flex'`, no `timeoutMs` → `FLEX_DEFAULT_TIMEOUT_MS` (1 500 000 ms / 25 minutes).
- `timeoutMs` is set → `timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS` (5 000 ms). The buffer ensures
  the engine's `AbortSignal` fires first so the error classifies as `kind: 'timeout'`.
- Caller-supplied `providerOptions.google.httpOptions` wins over any computed value.

### Error Classification

The adapter wraps the entire SDK call (client construction + `generateContent`) in a single
try/catch. `classifyError` converts SDK errors; the adapter re-throws as `LlmError` tagged with
`provider: 'google'`. Blocked responses (`promptFeedback.blockReason` set, or no candidates)
are thrown as `LlmError('content_filter', retryable: false)` rather than returning a result.

### Thought Text Extraction

Response parts are filtered on `part.thought === true`. Thought parts are concatenated into
`reasoningText`; non-thought text parts are concatenated into `text`. Both are returned on
`AdapterResult`. The engine surfaces `reasoningText` on `LlmResult` and persists it on
`LlmCallRecord` when present.

---

## Config Resolution

`deepMergeConfig(...configs)` merges `GenConfig` objects left-to-right (later entries win for
scalar fields). Two object-valued sub-fields — `reasoning` and `providerOptions` — are merged
recursively so a per-call override can set a single sub-key without replacing the entire object.
Arrays and scalar values within those objects use last-write-wins.

Resolution order:

- `generate`: `libDefaults → request.config`
- `runStructured`: `libDefaults → callSite.config → opts.config`

Omitted `serviceTier` stays omitted — the engine no longer injects a `'flex'` default after the
merge. An earlier design defaulted every resolved config to `'flex'`, but that broke models with
no supported service tiers (e.g. Gemma), so the strict-schema rollout removed the implicit
default: no `serviceTier` in the merged config means provider-standard request behavior.

---

## Landed in v1.1

**Multimodal message parts.** `Message.parts` is now the `Part` discriminated union:
`TextPart | InlineMediaPart | FileUriPart`. Inline base64 images/video (`inline-media`) and
provider-hosted file references (`file-uri`) can be freely mixed with text parts. An optional
`mediaResolution` hint on media parts maps to `PartMediaResolutionLevel` in the Gemini adapter.
Type guards (`isTextPart`, `isInlineMediaPart`, `isFileUriPart`) are exported from `@gullabs/core`.

**Google resource helpers.** `GoogleFileStore` (Files API: upload + poll + delete) and
`GoogleCacheStore` (Context Cache API: getOrCreate + refresh + delete) are exported from
`@gullabs/google`. Both are stateful, process-scoped helpers. The core engine remains stateless
and reference-only; resource handles are passed to requests as `FileUriPart.uri` or via
`providerOptions.google.cachedContent`.

**Model-bound config validation.** `ModelDescriptor` now carries `configJsonSchema` (plain JSON
Schema, for UX) and `validateConfig` (Standard Schema v1 validator). The engine validates the
**full** resolved config — including `providerOptions` — against `descriptor.validateConfig`
before auth and rate-limiter acquire; this replaced an earlier projection-only validation step
that excluded `providerOptions` and let the adapter re-check after merge. Gemini 3.x descriptors
have `sampling: 'fixed'` and reject `temperature`, `topP`, `topK` at call time.

**Grounding.** Requested via `providerOptions.google.tools: [{ googleSearch: {} }]`. The adapter
captures `candidate.groundingMetadata` into `result.providerMetadata`. Grounding and structured
output (`output.jsonSchema`) are mutually exclusive; the adapter enforces this with a `bad_request`
error before the SDK call.

**Flex transport timeout.** The adapter sets `config.httpOptions.timeout` automatically:
1 500 000 ms (25 minutes) for Flex calls without `timeoutMs`, and `timeoutMs + 5 000 ms` when
`timeoutMs` is set. Both exported as `FLEX_DEFAULT_TIMEOUT_MS` and `TRANSPORT_TIMEOUT_BUFFER_MS`.

**`Cost.usd` convenience field.** `= microUsd / 1_000_000`. Display-only; micro-USD remains
canonical and is the only value persisted.

**Function calling.** Shipped as a seam only (ADR-029). The `Part` union includes
`tool-call` and `tool-result`. `LlmRequest.tools` / `toolChoice` in; no agent loop.

## Planned Seams (not yet)

The following capabilities have documented ports or type-system placeholders. They are excluded
because the one-call, non-streaming foundation (now multi-provider via the ADR-023 plugin
architecture: google, xai, and the dev-only CLI providers) needs to be stable first.

**Streaming.** A `stream()` method that returns an async iterable of normalized `StreamEvent`
objects plus a `final: Promise<LlmResult>`. The `ProviderAdapter` interface is designed to
accommodate a `runStream` method. Records are written on every terminal stream outcome including
abort, with `usage.source = 'estimated'` when the provider did not return usage before the stream
ended.

**Additional providers.** Beyond the `ProviderAdapter` port and routing infrastructure, adding a
provider package is now a first-class, shipped workflow: a package exports a `ProviderPlugin`
(adapter + model descriptors + optional pricing source, see `packages/core/src/plugin.ts`) and
hosts wire it in via `composeProviders([...])` (e.g. `composeProviders([googleProvider()])`) —
see [`docs/architecture.md`](./docs/architecture.md) and the README Quickstart. `AuthMaterial` is
currently `{ apiKey: string, keyId?: string } | { cliSession: true }` (the CLI-session form shipped
with the dev CLI providers below; `keyId` is the ADR-026 attribution label, `ApiKeyAuth`-only).
Additional forms (OAuth token, bearer token) would extend the union further.
Vertex AI specifically is on the roadmap; see ROADMAP.md.

**`Redactor` port.** A planned port for scrubbing sensitive content from messages and results
before persistence. Absent in v1; the port name is reserved. If added, it would be fail-closed
(not fail-open) to prevent accidental persistence of unredacted content.

**`ResultCache` port.** An optional cache keyed on a deterministic hash of the request, enabling
idempotent re-runs without hitting the provider. Absent in v1.

---

## Package Scope

The npm scope stays lowercase `@gullabs`. The GitHub org/repo path is
`gul-labs/any-llm` — these are separate namespaces and the scope does not track
the org name. The exact org/repo path is load-bearing for npm provenance: it is
matched literally, so neither different casing nor a redirect from a former org
name satisfies it (see `RELEASING.md`). Provider SDK packages (`@google/genai`, `@anthropic-ai/sdk`,
`openai`) are peer dependencies, not bundled dependencies, to avoid duplicate
instances in the host's dependency tree.

Packages:

| Package               | Role                                                                                                                                                                                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@gullabs/core`       | Engine, types, ports, `ProviderPlugin`/`composeProviders`, generic model-registry machinery (`ModelDescriptor`, `ModelRegistry`, `createModelRegistry`), record builder, generic cost computation (`computeCost`). No provider SDK imports, no provider-specific model descriptors, schemas, or pricing tables. |
| `@gullabs/google`     | Gemini/Gemma adapter over `@google/genai`, plus everything provider-specific: model descriptors and strict per-model config schemas (`geminiModelDescriptors`, `gemmaModelDescriptors`, `defaultGeminiRegistry`), `GoogleProviderOptions`, and pricing (`GEMINI_PRICING`, `geminiPricingSource`).               |
| `@gullabs/drizzle`    | Reference Postgres schema (`llm_calls` table) and `drizzleUsageSink`.                                                                                                                                                                                                                                           |
| `@gullabs/testing`    | `FakeClock`, `FakeIds`, `RecordingSink`, `makeFakeGemini`. No network in tests.                                                                                                                                                                                                                                 |
| `@gullabs/claude-cli` | **Dev-only.** Adapter over the local `claude` CLI. Not published to prod consumers' deps.                                                                                                                                                                                                                       |
| `@gullabs/codex-cli`  | **Dev-only.** Adapter over the local `codex` CLI. Not published to prod consumers' deps.                                                                                                                                                                                                                        |

---

## CLI dev providers (claude-cli, codex-cli)

### Purpose

Temporal workflows with dozens of LLM-call activities are expensive to iterate on against a real
API. `@gullabs/claude-cli` and `@gullabs/codex-cli` route calls through a locally-authenticated
`claude` or `codex` CLI instead, at $0 marginal cost. Two-phase testing story: phase 1 runs the
workflow against a CLI provider to shake out pipeline/activity/schema bugs, using that provider's
own config shape; phase 2 re-qualifies end-to-end against real Gemini before deploy. These
packages are **not fallback paths for API providers** and must never be framed or wired as one.
They are impossible to run in production by construction: both require an interactive local CLI
login (`claude auth login` / `codex login`) that does not exist on a server.

### Auth

`AuthMaterial` becomes a union:

```ts
type AuthMaterial = { apiKey: string; keyId?: string } | { cliSession: true }
```

This is the union anticipated by the "Additional providers" planned seam (see above), realized
here instead of for OAuth/bearer tokens. It preserves P1: the caller still declares auth
explicitly on every call, and the library still never reads `process.env` or a keychain — the
CLI binary owns and resolves its own credentials out of band. The Google adapter narrows to
`{ apiKey }` and throws `invalid_auth` if absent; the CLI adapters narrow to `{ cliSession: true }`
and throw `invalid_auth` (with a message pointing at the CLI login command) otherwise.

### Model config: deliberately outside core

Model descriptors and config schemas for both packages live in `packages/claude-cli/src` and
`packages/codex-cli/src`, not `packages/core/src/model-config/`. This is a deliberate deviation
from the Gemini precedent: dev-only models must never appear on the production core surface, so a
host importing only `@gullabs/core` + `@gullabs/google` never sees `claude-fable-5-1` or
`gpt-6-sol` in its registry. Each package still satisfies the same onboarding invariants
(strict zod config schema, `configJsonSchema`, `validateConfig`) as core's own descriptors.

Config schemas are `z.strictObject`, per the reject-don't-map rule: no `temperature`, `topP`,
`topK`, or `stopSequences` fields exist at all, because CLIs don't accept sampling params — an
unknown key is rejected outright, never silently dropped or clamped.

- **claude-cli** models: `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5`,
  `claude-haiku-4-5-20251001`. Fable 5.1, Opus 5.5, and Sonnet 5 admit
  `reasoning.effort`: `low | medium | high | xhigh | max`. Haiku 4.5 has no
  reasoning key.
- **codex-cli** models: `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`.
  `reasoning.effort`: `low | medium | high | xhigh | max`. No `gpt-5*` id is registered.

### Adapter-owned invariant flags

Both CLIs are invoked with a fixed argv the caller cannot override, to keep the subprocess
non-interactive and isolated from the host's other CLI state:

- **claude**: `-p --output-format json --safe-mode --tools "" --disable-slash-commands
--no-session-persistence --settings '{"switchModelsOnFlag":false}'`. `--safe-mode`, not `--bare` — `--bare` also disables OAuth/keychain
  auth, which would break subscription login; `--safe-mode` isolates context/tool access while
  leaving auth intact.
- **codex**: `exec --json --ephemeral --skip-git-repo-check --ignore-user-config --ignore-rules
--sandbox read-only -C <scratchDir> -c approval_policy=never`.

Each call runs in a fresh temp `cwd` (`fs.mkdtemp`), spawned per call rather than as a persistent
process (see Scope exclusions below).

### Structured output

Both CLIs support native schema-constrained output (`--json-schema` for claude, `--output-schema`
for codex). The adapter parses the CLI's result text into `AdapterResult.rawStructured` and does
**not** validate it against the schema — per P3, that stays the engine's job, unchanged from the
Gemini adapter's behavior.

### Usage and cost

Token usage reported by the CLI is mapped into `Usage` under the GROSS convention, same as every
other adapter, with `Usage.raw` holding the verbatim CLI usage object. Neither `claude-cli` nor
`codex-cli` models have `PricingSource` entries, so `Cost.microUsd` resolves to `null` through the
existing unpriced-model path — no special-casing needed. Where the CLI itself reports a cost
(claude's `total_cost_usd`), it is copied into `providerMetadata` only; it never becomes `Cost`,
since that field is reserved for the engine's own priced computation.

### Scope exclusions (v1)

No streaming, caching, grounding, or multimodal input — non-text `Part`s are rejected as
`bad_request`. No persistent stdio process: each call spawns and tears down a fresh CLI process,
which is simpler and matches the low call-rate dev-loop use case; a long-lived stdio bridge is a
possible future optimization if per-call spawn overhead becomes the bottleneck. Both adapters cap
internal concurrency (default 2, configurable) with a semaphore, because subscription-plan CLIs
throttle parallel sessions regardless of what the caller requests.

### Version policy

A CLI's JSON output envelope is far less stable across versions than a versioned HTTP API. Each
package documents the CLI version range it was smoke-tested against in its README, and the
adapter fails with a typed `LlmError` (rather than a raw parse exception) when it encounters an
envelope shape it doesn't recognize.
