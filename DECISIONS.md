# Architecture Decision Records — any-llm

Each entry records a decision made during design or implementation, why it was made, and what it
costs. The canonical overview of what these decisions produced is in
[`docs/architecture.md`](./docs/architecture.md).

---

## P0 Standing Decision: No Legacy Compatibility

**Status:** Accepted until explicitly revised by the owner

**Context:**
This codebase is greenfield. Backward compatibility, legacy aliases, deprecated APIs, migration
helpers, compatibility shims, and transitional fallback code paths add design debt without protecting
real external users.

**Decision:**
Backward compatibility is not a design constraint. New work must choose the clean current contract
and delete legacy, dead, transitional, and compatibility code. Do not preserve old behavior through
shims, aliases, deprecated exports, compatibility modes, feature flags, or fallback branches unless
the owner explicitly revises this rule.

Migration documentation may explain the new contract and how to update call sites, but it must not
introduce legacy APIs or compatibility layers.

**Consequences:**

- Compatibility-preserving plans are P0 blockers and must be revised.
- Deprecated exports should be removed, not retained for a later breaking release.
- Tests should assert absence of legacy and dead paths where practical.
- Reviewers should prefer deletion over adapters or repair helpers.

---

## ADR-001: Ports & Adapters (Hexagonal) Architecture

**Status:** Accepted

**Context:**
The library needs to support multiple LLM providers without coupling the core engine to any
provider SDK. Provider SDKs (`@google/genai`, `@anthropic-ai/sdk`, `openai`) have different
API shapes, authentication schemes, and versioning cadences. Embedding SDK calls directly in the
engine would make every cross-cutting concern (retry, cost, telemetry, validation) repeat or
diverge per provider.

**Decision:**
The core engine depends only on typed interfaces (`ports.ts`). Every pluggable dependency —
provider communication (`ProviderAdapter`), persistence (`UsageSink`), pricing (`PricingSource`),
credentials (`AuthProvider` — removed in ADR-019; auth is now a per-call `AuthMaterial` value, not a
port), backpressure (`RateLimiter`), observability (`Telemetry`, `Logger`),
and time/identity sources (`Clock`, `IdGenerator`) — is expressed as a port. Concrete
implementations live in separate packages (`@gullabs/google`, `@gullabs/drizzle`, etc.) that the
engine never imports directly.

**Consequences:**

- The engine can be unit-tested with in-memory fakes without any network dependency.
- Adding a new provider requires only implementing `ProviderAdapter`; the rest of the pipeline
  (retry, cost, record, telemetry) comes for free.
- The seam between engine and provider is narrow and explicit: `ResolvedRequest` in, `AdapterResult`
  out. Adapters never validate output, compute cost, or persist anything.
- Host applications choose their own DB, logger, and telemetry client; the library brings none.

---

## ADR-002: Fail-Open Side Effects

**Status:** Accepted

**Context:**
The engine calls several side effects after the provider responds: persist a record to the sink,
compute cost via the pricing source, and emit telemetry events. Any of these can fail for reasons
unrelated to the LLM call (network partition to the sink DB, bug in a telemetry hook, pricing
snapshot missing a new model). If these failures propagate, callers lose the actual LLM result
even though the provider call succeeded.

**Decision:**
Sink writes (`UsageSink.record`), cost computation (`PricingSource.price`), and telemetry callbacks
(`Telemetry.onStart/onSuccess/onError`) are fail-open: errors are logged and swallowed. A broken
sink appends a `Warning` to the record and logs `llm.call.sink.failed`; it does not rethrow.

The rate-limiter (`RateLimiter.acquire`) is the deliberate exception: a rejection from `acquire`
propagates to the caller. The entire point of the rate-limiter port is to be able to delay or
refuse calls; swallowing its errors would make it inert.

**Consequences:**

- LLM call results always reach the caller even when observability infrastructure is degraded.
- Sink failures are visible in logs but not in the returned `LlmResult`. Callers that need
  guaranteed persistence must check the sink independently.
- The rate-limiter asymmetry is intentional and documented. Any new port that is meant to gate
  calls (not just observe them) must be treated fail-closed, not fail-open.

---

## ADR-003: Typed `LlmError` with Machine-Readable `retryable` and `retryAfterMs`

**Status:** Accepted

**Context:**
Provider SDKs throw a mix of typed error classes, plain objects with `status` fields, and
`AbortError` instances. Callers need to make programmatic decisions — retry vs surface to user,
respect a backoff hint — without parsing error message strings.

**Decision:**
Every throw from the engine or adapters is an `LlmError`. The class carries:

- `kind`: a closed union (`invalid_auth | rate_limited | server | timeout | aborted | bad_request |
content_filter | unknown`) that drives retry decisions and record status.
- `retryable`: a boolean derived deterministically from `kind`; callers and retry middleware read
  this flag rather than switching on `kind` themselves.
- `retryAfterMs`: populated from the provider's `Retry-After` header when a 429 carries one.

`classifyError` converts arbitrary thrown values (SDK error classes, plain objects with a `status`
field, `AbortError`, `TimeoutError`, strings) into `LlmError` with a single, testable code path.
Adapters call `classifyError` in their catch block and re-throw the result tagged with `provider`.

**Consequences:**

- The retry middleware reads `err.retryable` and `err.retryAfterMs` without any knowledge of
  provider-specific error shapes.
- The record's `errorKind` and `status` fields are derived from the same classification, keeping
  persisted data consistent with what callers observe.
- Adding a new error kind is a breaking change to the `LlmErrorKind` union, which is intentional:
  it forces consumers to handle the new case explicitly.

---

## ADR-004: GROSS Token Accounting Convention

**Status:** Accepted

**Context:**
LLM providers report token usage inconsistently. Anthropic's `input_tokens` excludes cache hits;
Gemini's `promptTokenCount` includes them. Thinking tokens are sometimes reported separately from
output tokens. Cost math that adds subsets to totals produces double-counting; math that subtracts
them produces under-counting when the subset is absent.

**Decision:**
The `Usage` type uses a GROSS convention throughout:

- `inputTokens` is the total billed input, **including** cached tokens.
- `outputTokens` is the total billed output, **including** thinking tokens.
- `cachedInputTokens` and `thinkingTokens` are subsets of their respective totals, not additive.

This is enforced at two points: the Gemini adapter explicitly computes
`outputTokens = candidatesTokenCount + thoughtsTokenCount` (not the provider's `totalTokenCount`),
and `sanitizeUsage` in `record.ts` clamps any subset that exceeds its parent to the parent value,
emitting a `Warning`.

**Consequences:**

- Cost math is: `(inputTokens - cachedInputTokens) × inputRate + cachedInputTokens × cachedRate +
outputTokens × outputRate`. This formula is correct regardless of whether any subset is absent.
- Adapters for future providers must document how their raw fields map to GROSS fields.
- `Usage.raw` preserves the provider's original usage object verbatim so cost can be recalculated
  from scratch if the convention mapping is later found to be wrong.

---

## ADR-005: Pricing as a Pinned Snapshot with a Pluggable `PricingSource` Port

**Status:** Accepted

**Context:**
Pricing data changes when providers update their rate cards. Fetching pricing at call time couples
the library to provider pricing APIs and introduces latency. Embedding pricing in the engine as a
constant couples cost accuracy to library release cadence.

**Decision:**
Pricing is expressed as a `PricingSource` port with a `version` string and a `price()` method.
The library ships a built-in `geminiPricingSource()` that holds a dated, named snapshot
(currently `gemini-2026-08-12`; prior `gemini-2026-06-28` remains the version frozen
into records written under that card). The snapshot version is frozen into every
`Cost` record at write time so historical records can identify which rate card was used.

Hosts can supply a custom `PricingSource` to override rates (e.g. committed-use discounts) without
forking the library. The `pricingFamily` field on `ModelDescriptor` allows model variants
(`gemini-2.5-pro-001`) to resolve to the base pricing entry (`gemini-2.5-pro`) without
enumerating every version string in the pricing table.

**Consequences:**

- Pricing snapshots go stale when providers update rates. The `pricingVersion` on each record
  makes it straightforward to identify records that need backfill when a snapshot is updated.
- `Cost.microUsd` is `null` when the model is not in the pricing table. The tokens are still
  recorded, enabling cost backfill once the model is priced. This is a deliberate trade-off:
  silence (a missing `cost` field) would make unpriced calls invisible.
- Separating the pricing snapshot from the adapter means price corrections never require an
  adapter release.
- The current provider pricing table is not a historical-rate archive. Removing a model
  from the current catalog also removes its current pricing entry. Persisted costs remain
  frozen; a correction or backfill for an older row must use the rate snapshot identified
  by that row's `pricingVersion`, not reprice it against the latest package's table.

---

## ADR-006: `ModelDescriptor` Registry with Exact-ID and Longest-Prefix Resolution

**Status:** Superseded by ADR-033 (exact ids plus declared aliases; no prefix matching). Resolution
keying and routing fallbacks were already superseded by ADR-022.

**Context:**
A model string like `gemini-2.5-pro-001` must route to the `google` adapter, resolve to the
`gemini-2.5-pro` pricing entry, and inform the adapter which `thinkingConfig` API variant to use
(`thinkingBudget` for 2.5 series, `thinkingLevel` for 3.x series). Encoding this knowledge as
string-prefix heuristics in the engine or adapter scatters it and produces bugs when new model
strings arrive. The strict model-config work also needs one place to require exact schema artifacts
for every built-in and custom descriptor.

**Decision:**
`ModelDescriptor` centralizes all per-model metadata: `provider`, `pricingFamily`, capability
flags, and strict schema artifacts. Every built-in descriptor must publish:

- `configSchema` — the exact runtime schema for that model's config.
- `configJsonSchema` — JSON Schema derived from `configSchema`.
- `validateConfig` — the Standard Schema adapter over the same runtime schema.

The registry (`createModelRegistry`) resolves a model string with exact-ID match first, then
longest-prefix match. The `defaultGeminiRegistry` pre-populates descriptors for all known Gemini
models. Custom registries remain supported, but they are strict extension points only: descriptors
that omit required schema artifacts are invalid and should fail registry construction.

The engine attaches the resolved `ModelDescriptor` to `ResolvedRequest`, so adapters can branch on
`req.modelDescriptor?.capabilities?.reasoningApi` without re-deriving it from the model string.
Hosts supply a custom registry via `ClientConfig.modelRegistry` to add new models or override
provider mappings without a library release.

**Consequences:**

- Model-specific logic in the adapter is data-driven (a switch on `reasoningApi`) rather than
  string-matching (fragile against new version suffixes).
- An unknown model is still routable when only one adapter is configured; it falls back to that
  adapter with a missing descriptor. With multiple adapters, an unknown model throws
  `LlmError('bad_request')` at call time rather than silently routing wrong.
- Schema completeness is enforced at registry construction time instead of surfacing later as
  runtime drift between UI forms, persisted config, and adapter behavior.
- The registry is immutable after construction. Hosts that need to add models at runtime must pass
  a pre-built custom registry to `createClient`.

---

## ADR-007: Opt-In Middleware Chain; Retry as First-Party Middleware

**Status:** Accepted; amended by ADR-037 (a middleware cannot change the provider or model, so
provider fallback is host-side, not middleware)

**Context:**
Cross-cutting behaviors like retry, circuit-breaking, and request logging need to wrap the
per-attempt call. Baking retry directly into the engine creates coupling between retry policy and
the call pipeline; it also makes it impossible to place non-retry middleware outside or inside
the retry loop.

**Decision:**
`ClientConfig.middleware` accepts an ordered list of `Middleware` objects. The engine folds them
right-to-left (outermost-first ordering) around `runAttempt`, producing a `Handler` chain. Each
middleware receives `(req, ctx, next)` and calls `next` zero or more times: zero short-circuits,
once is a passthrough, multiple times is retry.

`retryMiddleware` is shipped as a first-party implementation of this interface. It reads
`err.retryable` and `err.retryAfterMs`, applies exponential backoff with full jitter, and never
retries `kind === 'aborted'`. It is not registered by default; callers opt in explicitly:
`middleware: [retryMiddleware({ maxAttempts: 3 })]`.

Each invocation of `next()` (i.e., each attempt) generates a fresh `attemptId` and sinks exactly
one record. The `callId` is stable across all attempts of a logical call.

**Consequences:**

- Retry policy is configurable without patching the engine: `maxAttempts`, `baseDelayMs`,
  `maxDelayMs`, and a custom `shouldRetry` predicate are all overridable.
- The middleware contract is simple enough that hosts can implement circuit-breakers or request
  tracing as middleware without forking the library. Rerouting is not middleware work (ADR-037).
- Middleware `id` uniqueness is validated at `createClient` construction to catch misconfiguration
  early.
- The retry sleep is abortable: if the caller fires the abort signal during a backoff window, the
  sleep rejects immediately with `LlmError('aborted')`.

---

## ADR-008: Rate-Limiter Ownership — Provider Enforces, Library Survives, App Owns Policy

**Status:** Accepted

**Context:**
LLM providers enforce rate limits per model and per API key. The library needs to expose a hook
for pre-send backpressure without owning any distributed state (Redis, token bucket counters)
itself. A library-owned distributed rate limiter would couple the library to a specific
infrastructure dependency.

**Decision:**
The `RateLimiter` port exposes `acquire(key, signal): Promise<Release>`. The engine calls
`acquire("${provider}:${model}")` before every adapter invocation. The port is fail-closed (not
fail-open): a rejection from `acquire` propagates to the caller.

The key format encodes both provider and model because quotas are per-model. The `Release`
function, called on every exit path (success and error), signals the end of the rate-limited
window so slot-tracking implementations can free the slot.

The library ships a `NOOP_RATE_LIMITER` as the default. Distributed implementations (Upstash
token bucket, Redis sliding window) are external packages that implement the port. Applications
running inside Temporal use Temporal's own task-queue rate limiting; the engine's rate-limiter
port is a no-op in that context.

**Consequences:**

- No Redis, Upstash, or any other infrastructure dependency in the library itself.
- The app (or a companion package) owns rate-limit policy: per-key vs global, distributed vs
  in-process, token bucket vs sliding window.
- Concurrency-slot accuracy depends on adapters honoring `ctx.signal`: if an adapter ignores the
  abort signal, the `Release` fires before the underlying HTTP request finishes, and the slot
  count under-represents actual in-flight requests.

**Amendment (ADR-041):** the port is `acquire(key, signal, hint?): Promise<Release>` with
`Release = (usage?: Usage) => void`. The engine passes `hint.estimatedInputTokens` and releases with the
attempt's usage when it has one, so a token-aware limiter can pace and reconcile. The ownership decision is
unchanged: the library holds no distributed state.

---

## ADR-009: Forward-Only JSON Schema for v1 Structured Output

**Status:** Accepted

**Context:**
Provider APIs return structured JSON output as raw strings or parsed objects. The library should
forward provider-native JSON Schema hints without choosing the caller's validation library. This
needs to stay separate from model config validation, which now has a runtime schema boundary of its
own.

**Decision:**
v1 uses a forward-only JSON Schema hint. `LlmRequest.output.jsonSchema` is typed as `JsonValue`;
the Gemini adapter forwards it as `responseJsonSchema` (ADR-034; it was `responseSchema`) and
JSON-parses the returned text when structured output was requested. The engine returns
`output: unknown` and `outputParsed`, and never validates shape.

**Amended by ADR-034:** the schema is still forwarded verbatim and the engine still never
validates the _result_, but the adapters now check the _schema_ itself before dispatch. It must be
standard JSON Schema and may use only keywords the provider enforces. Host-side validation of
`output` is unchanged and remains the host's job: a schema constrains the model, it does not
prove the answer.

**Consequences:**

- The no-Zod-runtime claim applies to structured output validation only. The library still does not
  validate `result.output` against Zod or any other schema library at runtime.
- Model config is a different boundary: built-in descriptors use runtime Zod schemas for config,
  and callers should not confuse `output.jsonSchema` with `descriptor.configJsonSchema`.
- Callers own validation, retry, and acceptance policy for `output`.
- Malformed or empty structured output is a successful provider call with `outputParsed:false`.

**Amendment (2026-10-03): `runStructured` option parity.** `RunStructuredOptions` gains `externalId`,
`attachments?: Part[]` (appended to the rendered user message), `history?: Message[]` (prepended) and
`transientProviderState`, with the same meaning and validation as on `generate`, so a host that uses call
sites no longer drops to `generate` to correlate a retry, attach a file, or send text or media history. A
rendered user message that is empty or whitespace only, with no attachments, is `bad_request` before any
request is built (row-less, like the other prologue checks); attachments alone are a valid message and
no empty text part is sent. Every `attachments` element must be a part object and every `history`
element a `{ role, parts }` message of known part kinds, else `bad_request` naming the path
(`attachments[0]`, `history[1].parts[0].kind`); `generate` applies the same shape check to `messages`.
A call site declares no tools, so `tool-call` and `tool-result` parts in `attachments` or `history` are
`bad_request`: a tool loop belongs to `generate`. `history` is sent as given: a history that ends in a
user message is followed by the rendered user message as a second consecutive user turn, and turns are
never merged. `transientProviderState` is admitted only by models that declare `providerState`, and
lets a follow-up structured call reuse what the provider returned with the earlier result. Output
validation is unchanged: none of these options makes the library validate `output`, and a host that
wants a validated answer still validates and retries itself.

---

## ADR-010: Model-Bound, Schema-Described Config

**Status:** Accepted

**Context:**
Different Gemini model families have different acceptable generation parameters. Gemini 3.x models
fix sampling; passing `temperature`, `topP`, or `topK` to them causes a provider-side error
(`bad_request`). The error is confusing to surface at the SDK level. Meanwhile, host UIs and config
editors need a machine-readable description of which knobs a model accepts, so they can build form
fields without hard-coding per-model knowledge in application code. The old contract drifted in
three directions at once: broad hand-written JSON Schema, narrower hand-written validator logic,
and a provider-options escape hatch that could overwrite already-validated fields.

**Decision:**
Each built-in `ModelDescriptor` carries three required schema artifacts:

- `configSchema` — the exact runtime Zod schema for that model's config.
- `configJsonSchema` — a plain JSON Schema object derived from `configSchema` and safe to serialize
  for UI/form generation.
- `validateConfig` — the Standard Schema v1 adapter over the same runtime schema.

`configSchema` is the source of truth. The engine parses the full resolved config against the
descriptor-owned schema before dispatch, not a narrow projection of generation knobs. Execution
fields that remain part of the public config contract, such as `timeoutMs` or the admitted
provider-specific extension lane, belong in the exact per-model schema instead of bypassing it.

Built-in JSON Schema is derived, not hand-authored. Hand-written family factories and projection-
only validators are deleted rather than preserved as compatibility helpers.

**Rejected alternatives:**

- _Per-model TypeScript types_ — would leak model-specific types into the public API surface and
  require callers to import and narrow types manually. Compile-time safety does not help when
  the model is a runtime string from a database.
- _One generic superset type_ — a single config type that accepts all parameters for all models
  cannot express per-model constraints; the only enforcement would be at the provider, which
  produces an opaque error after auth and network roundtrip.
- _Hand-written JSON Schema plus a different validator_ — this creates contract drift between the
  schema UIs render, the config callers persist, and the adapter behavior. The strict contract uses
  one schema boundary for all three.

**Consequences:**

- Config validation fires before auth, rate-limiter, and adapter — the fastest possible rejection
  for a misconfigured call.
- The `configJsonSchema` field can be serialized to JSON and returned to clients as part of a
  model-capabilities API response; no schema library is required on the client.
- Hosts that add custom model descriptors must publish the same schema artifacts as built-ins.
- Provider-specific extension keys only exist when the descriptor schema admits them; they are not
  a second caller-wins config API.

---

## ADR-011: Reference-Only Core for Stateful Resources; Optional Provider Helpers

**Status:** Accepted

**Context:**
Gemini's Files API and Context Cache API require stateful, long-lived client objects: upload a
file once, receive a `uri`; create a cached-content resource once, receive a `cacheName`; reuse
both across many requests. The core engine's call pipeline is stateless and per-attempt; it has
no ownership model for provider-hosted resources.

**Decision:**
The core engine and `@gullabs/core` types remain stateless and reference-only. `FileUriPart` and
the `providerOptions.google.cachedContent` field are reference types — they carry a URI or a
resource name, respectively. The engine passes them to the adapter verbatim; it has no upload or
cache lifecycle.

Stateful resource management lives in `@gullabs/google` as opt-in helper classes:

- `GoogleFileStore` — wraps the Gemini Files API. `upload(bytes, mimeType)` uploads and polls
  until `ACTIVE`, returning a `GoogleFileHandle` whose `uri` field can be used directly in a
  `FileUriPart`. `delete` / `deleteAll` are fail-open (errors go to `onDeleteError`, not rethrown).
  The SDK client is memoised per store instance (lazy, built at most once).
- `GoogleCacheStore` — wraps the Gemini Context Cache API. `getOrCreate(key, factory)` returns a
  live `GoogleCacheHandle`, creating one if the in-process map is empty or the entry has expired
  (with a configurable skew buffer). Reuse is **process-scoped** — the map lives in memory and
  does not survive restarts. `refreshIfExpiringSoon` extends the TTL fail-open. `delete` is
  fail-open. Optional `coalesce: true` serialises concurrent creates for the same key.

**Considered and rejected:** a generic `ResourceManager` port in `@gullabs/core` that the engine
would call to resolve URIs or inject cached content. Rejected for three reasons:

1. Upload-once-reuse-N means resource identity is process-scoped or database-backed — there is no
   single correct abstraction the library should own.
2. Entangling the engine with resource lifecycle would require a new port, new injection point in
   `ClientConfig`, and a new failure mode to classify; the per-call pipeline becomes more complex
   with no benefit to the common case.
3. Resources are not cross-provider: Gemini file URIs are useless to an Anthropic adapter. A
   shared port would be a fake abstraction that collapses to a no-op for every provider except
   the one that introduced it.

**Consequences:**

- Callers that do not need Files or Context Caching import neither class; the helpers are
  additional exports from `@gullabs/google`, not engine dependencies.
- The `GoogleFileHandle.uri` field maps directly to `FileUriPart.uri`; no conversion step needed.
- The `GoogleCacheHandle.cacheName` is passed as `providerOptions.google.cachedContent`; the
  Gemini adapter maps that allowlisted key into the SDK request.
- The helpers have injectable clients and clocks so tests run without network or real SDK.

---

## ADR-012: Flex Transport Timeout via Per-Request `httpOptions`

**Status:** Accepted

**Context:**
The `@google/genai` SDK defaults its HTTP transport timeout to ~60 seconds. Gemini Flex-tier calls
can legitimately run for up to 25 minutes. Without an explicit transport timeout, the SDK would
cancel a long Flex call before the engine's `AbortSignal`-based deadline fires. Additionally, when
callers set `timeoutMs`, the engine arms an `AbortSignal` at exactly that value. If the SDK
transport timer fired at the same millisecond, the raw SDK error would arrive instead of the
engine's clean `LlmError('timeout')`.

**Decision:**
The Gemini adapter sets `config.httpOptions.timeout` on every request according to this precedence
(highest first):

1. **Allowlisted `providerOptions.google.httpOptions.timeout`** — caller timeout wins over computed
   transport timeout. Extra `httpOptions` fields are not a general SDK escape hatch.
2. **`timeoutMs` is set** — transport timeout = `timeoutMs + TRANSPORT_TIMEOUT_BUFFER_MS`
   (currently 5 000 ms). This ensures the engine's `AbortSignal` always fires before the SDK
   transport timer.
3. **`serviceTier === 'flex'`, no `timeoutMs`** — transport timeout = `FLEX_DEFAULT_TIMEOUT_MS`
   (currently 1 500 000 ms, 25 minutes). No buffer is applied because there is no engine `AbortSignal`
   deadline in this case.
4. **`serviceTier === 'standard'`, no `timeoutMs`** — transport timeout = `STANDARD_DEFAULT_TIMEOUT_MS`
   (currently 300 000 ms, 5 minutes), backed by a client-side `AbortController` so the ceiling is a
   real client-side cutoff rather than only an SDK transport hint.

The computed `httpOptions` is built from the computed base and then the caller's value is spread on
top, so extra keys in a caller-supplied `httpOptions` object are preserved alongside any fields the
adapter sets.

**Deliberately not built:** automatic Flex → Standard fallback when a Flex call times out. Such a
fallback is a disguised retry that crosses tier boundaries without the caller's awareness. Retry
logic belongs in the middleware chain where it is explicit and auditable; routing and fallback
belong in the host (ADR-037).

**Consequences:**

- Long Flex calls complete without being killed by the SDK transport layer.
- When `timeoutMs` is set, the engine's `AbortSignal` is always the hard ceiling; the SDK transport
  timer cannot preempt it.
- `FLEX_DEFAULT_TIMEOUT_MS`, `STANDARD_DEFAULT_TIMEOUT_MS`, and `TRANSPORT_TIMEOUT_BUFFER_MS` are
  exported constants so callers can reason about the values they're building on.
- Callers that need a different transport timeout set it via `providerOptions.google.httpOptions`
  and their value wins.

---

## ADR-013: Grounding via Typed Provider Extensions; Exact Guard for Structured Output + Tools

**Status:** Accepted

**Context:**
Google Search grounding is a Gemini capability that attaches live search results to the model's
response. It is requested by including `{ googleSearch: {} }` in the Gemini `tools` array.
Grounding is not a cross-provider concept and the library does not model it as a top-level generic
field. At the same time, the old contract was too loose in two ways: it treated
`providerOptions.google` as a broad passthrough lane, and it documented grounding plus structured
output as a blanket incompatibility even after Google narrowed that restriction to exact models and
tool combinations.

**Decision:**
Grounding remains a provider-specific extension inside the Google descriptor-owned config schema:

```ts
config: {
  providerOptions: {
    google: { tools: [{ googleSearch: {} }] },
  },
}
```

The admitted Google extension keys are typed and model-aware. Descriptor-owned fields such as
`serviceTier`, sampling knobs, reasoning knobs, and response-schema fields are not overrideable via
`providerOptions.google`.

Grounding plus structured output is guarded exactly, not blanketly. The library should only admit
the documented `generateContent` model and tool combinations that Google currently supports for
structured output with built-in tools. Requests outside that exact support set fail before network
dispatch.

When grounding is active, the adapter captures `candidate.groundingMetadata` from the response
and includes it in `result.providerMetadata` alongside any `promptFeedback`. The host reads
grounding attribution from `result.providerMetadata['groundingMetadata']` as `JsonValue`; the
library does not model the grounding metadata structure as a typed field.

**Amendment (2026-10-03):** "Admit the combinations Google documents" was too generous. Live probes
(`docs/grounded-structured.md`) showed Gemini 3.x accepting `googleSearch` plus a response schema while
Flash-Lite models skipped Search and no model returned `groundingMetadata` with `responseSchema`. An
accepted request is not evidence the tool ran, so all six Gemini 3.x descriptors now set
`structuredOutputWithTools: false`. The combination fails with `bad_request` before dispatch, naming the
two-call recipe (grounded research without a schema, then structured synthesis). A host may opt in per
call with `providerOptions.google.allowSchemaWithSearch`; the search facts in usage, the grounding price
and the `requireGrounding` fail-closed check are ADR-035, which replaces the synthetic
`google_search_requested` marker this amendment first introduced.

**Consequences:**

- Grounding support stays provider-specific without pretending to be a cross-provider generic field.
- The guard follows exact public evidence instead of hiding unsupported paths behind a blanket rule
  or permissive passthrough.
- Grounding metadata is preserved in `result.providerMetadata` and persisted in the `LlmCallRecord`
  via the existing `providerMetadata` JSONB lane — no schema migration required.
- Adding first-class typed grounding support later is additive and non-breaking.

---

## ADR-014: `Cost.usd` as a Derived, Display-Only Convenience Field

**Status:** Accepted

**Context:**
`Cost.microUsd` is the canonical cost value — an integer count of micro-USD (1 USD = 1 000 000 µUSD)
computed at call time and frozen into every persisted record. Callers frequently need to display
cost in whole USD for UI labels and log lines. Dividing by `1_000_000` at every call site is
mechanical and error-prone (integer vs float rounding).

**Decision:**
`Cost.usd` is a computed field equal to `microUsd / 1_000_000` (or `null` when `microUsd` is
`null`). It is set alongside `microUsd` when `computeCost` builds the `Cost` object. It is
**display-only**: it is not persisted to the `LlmCallRecord`, and it should not be used for
financial calculations or aggregation. Micro-USD is canonical and is the only value written to the
sink.

**Consequences:**

- `result.cost?.usd` is available for immediate display without division at the call site.
- Aggregations (summing cost across records) must use `microUsd` from the persisted record to avoid
  floating-point accumulation error.
- The field is `null` when `microUsd` is `null` (unpriced model), consistent with the null
  semantics already documented on `Cost.microUsd`.

---

## ADR-015: `timeoutMs` as Overall Wall-Clock Ceiling Across Retry Attempts

**Status:** Accepted

**Context:**
`GenConfig.timeoutMs` was originally documented and implemented as a per-attempt timeout: the
engine arms an `AbortSignal` at that value for each individual adapter invocation. With retry
middleware installed, a caller setting `timeoutMs: 30_000` expected a 30-second total budget for
the entire logical call (all attempts + back-off), but the actual behavior was 30 seconds _per
attempt_ — a 3-attempt retry could run for up to 90 seconds before surfacing an error. This is
confusing and makes `timeoutMs` unpredictable as a scheduling primitive in production.

**Decision:**
When the retry middleware is installed and `req.config.timeoutMs` is set, `retryMiddleware`
enforces it as an **overall wall-clock ceiling** for the logical call. Implementation:

1. `start = Date.now()` is captured once before the first attempt.
2. Before each attempt, `remaining = timeoutMs - (Date.now() - start)` is computed. If
   `remaining ≤ 0`, the middleware throws `LlmError('timeout', retryable: false)` without starting
   another attempt.
3. The shrinking remaining budget is passed as `attemptTimeoutMs` on the cloned request (an
   internal field on `ResolvedRequest` set by the retry middleware; the engine reads it to arm the
   per-attempt `AbortSignal`, leaving `config.timeoutMs` unchanged so the persisted audit record
   always reflects the caller's original value).
4. After a failed attempt, `remainingAfter` is recomputed. If `≤ 0`, the classified error from
   the attempt is rethrown immediately (no sleep; no next attempt).
5. Back-off sleep is clamped: `delayMs = Math.min(delayMs, remainingAfter)` so the sleep never
   overshoots the deadline.
6. When `timeoutMs` is **not** set (undefined), all deadline logic is skipped because there is no
   caller-supplied wall-clock ceiling to enforce.

The `retryMiddleware` opts object gains an optional `now?: () => number` injectable clock so the
deadline logic can be tested deterministically without real timers.

**Considered and rejected:** moving the deadline enforcement into the engine's `runPipeline`
function. Rejected because: (a) the retry loop lives in middleware, not in the engine; (b) the
engine already handles per-attempt timeouts via `buildCancellationRace`; (c) placing overall-budget
logic in the middleware keeps the engine pipeline simple and separates the two concerns cleanly.

**Consequences:**

- `timeoutMs` now means what callers expect: the total wall-clock budget for the logical call,
  not a per-attempt limit.
- Retry policies that previously relied on `timeoutMs` as a per-attempt limit must either increase
  the value or remove it. This is a behavior change (though not a type-level breaking change).
- `buildCancellationRace` in the engine continues to arm per-attempt `AbortSignal` at the
  _remaining_ budget, so each attempt's HTTP timeout also shrinks — the ceiling is respected at
  both the retry level and the transport level.

---

## ADR-016: Best-Effort Secret Redaction on Error Record Persistence

**Status:** Accepted

**Context:**
Provider SDKs sometimes include the raw request URL (which may contain an API key as a `key=`
query parameter or a signed-URL `X-Goog-Signature`) in their error messages. When these errors
are classified and persisted as `LlmCallRecord.errorMessage`, secrets from the transient error
message end up in the append-only audit log. This is a credential-hygiene risk: the log may be
readable by more operators than the running service, and secrets written to a database are harder
to rotate than secrets in memory.

**Decision:**
A `redactSecrets(text: string): string` utility is added to `@gullabs/core` and applied to
`errorMessage` at the single point where it is written into `LlmCallRecord` (inside `buildRecord`
in `record.ts`).

`redactSecrets` is a best-effort, regex-based scrubber. It covers the most common patterns:

- Google API keys (`AIza[0-9A-Za-z_\-]{20,}` → `AIza…REDACTED`)
- HTTP Bearer tokens (`Bearer\s+[A-Za-z0-9._\-]+` → `Bearer …REDACTED`)
- Sensitive URL query-parameter values for keys: `X-Goog-*`, `key`, `api_key`, `access_token`,
  `token`, `signature`, `sig` — value replaced with `REDACTED`.

The live `LlmError` thrown to the caller is **not** modified. Redaction is applied only to the
persisted copy. This preserves the full error context for the caller (who already has the secret)
while protecting the audit log from accidental exposure.

**Considered and rejected:**

- _Full DLP pipeline_: a proper DLP solution with content-type detection, entropy analysis, and
  provider-specific patterns would be more thorough but is a substantial dependency. The
  risk-vs-cost trade-off favors a simple regex scrubber for v1.
- _Redacting the live error_: callers may need the full error text for debugging (e.g. to see which
  URL failed). Redacting the thrown error would make operational debugging harder without
  meaningfully improving security (the caller already holds the secret).
- _Provider-adapter responsibility_: redaction in each adapter is fragile because adapters may not
  know which parts of SDK error messages contain secrets. Centralising in `buildRecord` ensures
  every error path — regardless of provider — goes through one redaction point.

**Consequences:**

- API keys and Bearer tokens that appear in provider error messages are scrubbed from persisted
  records; the audit log is safe to export to less-privileged storage.
- False negatives are possible: custom or future secret formats may not be caught. The JSDoc on
  `redactSecrets` makes this limitation explicit.
- False positives are unlikely given the specific patterns used, but `keyword=` or `sig=` in
  benign text would be redacted. This is acceptable for error text.
- `redactSecrets` is exported from `@gullabs/core` so host applications can apply it to their own
  log lines or error reporting integrations.

---

## ADR-017: Gemini 3.x Sampling Params Are Hard-Rejected (House Policy, Stricter Than Google)

**Status:** Accepted

**Context:**
Google's documentation for Gemini 3.x models _discourages_ the use of `temperature`, `topP`, and
`topK`, recommending `temperature=1.0` and noting that changing sampling parameters "may lead to
unexpected behavior." Google does **not** hard-reject these parameters at the API level — a
request with `temperature=0.7` on a Gemini 3.x model is accepted and processed.

**Decision:**
We deliberately choose to **hard-reject** `temperature`, `topP`, and `topK` on all Gemini 3.x
models. The strict contract expresses this in the per-model runtime schema itself: fixed-sampling
models omit those fields from `configSchema`, omit them from derived `configJsonSchema`, and use
strict objects so they cannot sneak back in through provider-specific extension objects.

This is a **house-policy invariant** that is intentionally stricter than Google's advisory stance.
The `ModelDescriptor.capabilities.sampling` field encodes this as `'fixed'`, and the engine
validates the resolved config against the descriptor schema before auth and rate-limiter acquire.

**Rationale:**
A single enforced sampling contract per model family is more valuable for our typed-config and UX
story than permitting a discouraged knob. The `configJsonSchema` (used for form generation) omits
these fields entirely for `fixed` models, ensuring UIs cannot expose them. Config validation fires
before any network or auth cost, so the rejection is immediate.

**Trade-off (conscious divergence from upstream):**
We will reject some requests that Google's API would accept. Host applications that have a
legitimate reason to pass non-default sampling to Gemini 3.x models cannot do so through this
library without adding a custom model descriptor with `sampling: 'tunable'`. This is an acceptable
cost: the constraint is explicit, documented, and localized to a single descriptor flag.

---

## ADR-018: Verified `@google/genai` SDK Bugs and Mitigations

**Status:** Accepted

**Context:**
Two confirmed bugs in the `@google/genai` SDK affect Gemini Flex-tier reliability and have been
verified against the SDK source and issue tracker.

**Bug #1277 — `config.httpOptions.timeout` may be a no-op for `generateContent`:**
The SDK's `httpOptions.timeout` field is documented as the transport-layer timeout, but due to a
bug in how the SDK wires the timeout into the underlying fetch/HTTP layer, the timeout may not be
enforced for `generateContent` requests. This means a Flex-tier call that stalls at the network
layer may hang indefinitely even with `httpOptions.timeout` set.

_Mitigation:_ The Gemini adapter (`@gullabs/google`) arms a client-side `AbortSignal` to enforce
the effective timeout. For Flex calls without an explicit `timeoutMs`, the signal is set at
`FLEX_DEFAULT_TIMEOUT_MS` (1 500 000 ms, 25 min). When `timeoutMs` is set, the remaining budget from the
retry middleware is the signal deadline. The `AbortSignal` is passed as `config.abortSignal` so the
SDK will honour it regardless of whether `httpOptions.timeout` fires.

**Bug #1468 — On Vertex, `serviceTier` in the request body is ignored for Flex:**
When targeting Vertex AI (as opposed to the Gemini Developer API), the `serviceTier: 'flex'`
field in the generation config body is silently ignored. Flex calls on Vertex are billed at the
standard tier rate without any indication that the tier selection was not honoured.

_Mitigation:_ On the Vertex flex path, the adapter injected two HTTP headers:

- `X-Vertex-AI-LLM-Request-Type: shared`
- `X-Vertex-AI-LLM-Shared-Request-Type: flex`

These headers are the correct Vertex-native mechanism for requesting Flex tier and are honoured
by the Vertex AI backend independently of the body field.

**Note:** Vertex AI auth support (and this mitigation) was removed from the library — see
ADR-019, which dropped the `AuthProvider` port and made the library per-call, API-key-only
(no Vertex, no ambient/env auth). This bug and its mitigation are retained here as a
historical record only; the header-injection code path no longer exists in the current
adapter (`packages/google/src/adapter.ts`, `packages/google/src/client.ts`).

**Consequences:**

- Flex calls will time out correctly via `AbortSignal` even if the SDK's transport timeout is
  silently dropped.
- Vertex Flex calls were billed at the Flex rate when the headers were injected correctly
  (historical — Vertex support has since been removed, see the Note above). Hosts that bypass
  the adapter and call Vertex directly must inject these headers themselves.
- If Google fixes either bug, the mitigations remain harmless (belt-and-suspenders).

---

## ADR-019: Per-Call API Key Only; No Env/Ambient Auth, No AuthProvider Port

**Status:** Accepted

**Context:**
Early prototypes of the library included an `AuthProvider` port — a pluggable credential resolver
with implementations like `envAuth()` (reads `GEMINI_API_KEY` from `process.env`) and a
context-aware resolver that could select credentials based on request metadata. Client-level auth
was wired as `createClient({ auth: envAuth() })`.

This design shifted secret-source logic into the library: the engine's pipeline called
`auth.credentials(provider)` before each adapter invocation, so the library was in the business
of discovering and supplying credentials. That's a concern that belongs entirely in host
application code.

A secondary problem: Vertex AI auth used Google Application Default Credentials (ADC) — ambient
discovery from environment variables (`GOOGLE_APPLICATION_CREDENTIALS`), well-known credential
files, or the GCE metadata service. ADC is fundamentally an ambient-read pattern that cannot be
made explicit without a new credential shape.

**Decision:**
Remove the `AuthProvider` port, `envAuth()`, and all client-level auth. `AuthMaterial` is
narrowed to `{ apiKey: string }`. The caller passes `{ auth: { apiKey } }` on every `generate()`
and `runStructured()` call. `auth` is required; there is no default and no fallback.

Vertex AI auth is removed entirely for this version. It will return when an explicit, non-ADC
credential shape is designed (see ROADMAP.md).

A CI source-invariant test asserts:

1. No file under `packages/core/src` or `packages/google/src` reads `process.env`.
2. Neither `AuthProvider` nor `envAuth` appears in any package entrypoint export.

**Alternatives considered:**

- _AuthProvider port + context-aware resolver + per-call override_ — the original design. Rejected
  as over-engineering for v0: it added a port, an injection point in `ClientConfig`, three
  implementations, and a resolution step in the engine pipeline, all to solve a problem that host
  application code solves trivially in one line (`const auth = { apiKey: process.env.KEY! }`).
- _Client-level auth with per-call override_ — a single `createClient({ auth })` plus optional
  per-call override. Rejected because the "optional override" path is the only path callers
  actually need; the client-level default adds implicit state and makes the engine impure relative
  to its inputs.
- _Keep envAuth for convenience_ — rejected; convenience functions that read ambient env are the
  entire class of bug this decision eliminates. Documenting "don't use envAuth in prod" is weaker
  than not shipping envAuth.

**Consequences:**

- **Breaking.** All callers must pass `auth` on every call. There is no migration path that
  preserves the old client-level auth; callers must add `{ auth: { apiKey } }` to each call site.
- Vertex AI is not supported in this version. Callers targeting Vertex must wait for the roadmap
  item or implement their own adapter.
- The engine pipeline no longer has an `AuthProvider` step. `auth.apiKey` arrives with the call
  options and is forwarded directly to the adapter.
- The no-ambient-reads guarantee is enforced by CI, not by convention. Regressions are caught
  before merge.
- `AuthMaterial` is a narrower type than before; any host code that branched on `{ vertex: ... }`
  must be updated.

---

## ADR-020: Auth Extension Seams — Keep `AuthMaterial` Bare; Defer Discriminant and Translator Consolidation

**Status:** Accepted

**Context:**
Following ADR-019's removal of the `AuthProvider` port, a follow-up panel review (architect +
YAGNI reviewer + codex signoff) examined whether `AuthMaterial` should proactively grow a `kind`
discriminant and whether the three `GoogleGenAI` client-construction sites
(`buildGoogleClient` in `adapter.ts`, `buildCachesClient` in `cache-store.ts`,
`buildFilesClient` in `file-store.ts`) should be consolidated into a shared translator.

**Decision:**
Defer both changes. `AuthMaterial` stays as `{ apiKey: string }` with no `kind` field. The three
client-construction sites remain as independent leaf constructors.

**Rationale:**

1. **Single-kind discriminant is dead metadata.** With exactly one credential kind, a `kind`
   field carries no information and taxes every caller that must now type `{ kind: 'api-key',
apiKey: '...' }` instead of `{ apiKey: '...' }`. A discriminant earns its keep only when there
   are two or more kinds to discriminate between.

2. **Adding a kind later is a trivial, safe additive change.** When a second kind exists (e.g.
   Vertex service-account material or an OAuth bearer token), the migration is ~4 files and ~20
   lines: turn `AuthMaterial` into a discriminated union, update `requireAuth()` in `engine.ts`,
   and update the three `buildXxxClient` functions. TypeScript exhaustiveness checks will surface
   every narrowing site automatically; nothing can be silently missed.

3. **Translator consolidation buys nothing now.** The three client-construction sites are leaf
   constructors that differ only in which `GoogleGenAI` sub-API they wrap (`ai.models`,
   `ai.caches`, `ai.files`). Sharing a single translator would tie unrelated packages together
   and add a cross-package import for no practical benefit.

**The real future-design concern is not the `AuthMaterial` shape.** It is the long-lived
`GoogleCacheStore` and `GoogleFileStore` instances that capture auth at construction time and
memoize a single SDK client from it. For static API keys this is correct. For short-lived
refreshable credentials (OAuth/STS tokens) this memoized client would silently hold stale
credentials for the lifetime of the store. The primary design work when refreshable creds arrive
is these two stores, not the `AuthMaterial` type or the discriminant. Both stores are annotated
with this note (see `cache-store.ts` and `file-store.ts`).

**For the engine resolver:** when refreshable credentials are needed, widen `opts.auth` to
`AuthMaterial | ((ctx) => Promise<AuthMaterial>)` and resolve in `requireAuth()` once per logical
call. Policy questions deferred to that time: per-call vs. per-attempt resolution, mid-attempt
expiry handling, and resolver-failure classification. See the JSDoc on `requireAuth()` in
`engine.ts` for the full set of open questions.

**Consequences:**

- No code change from this ADR. All changes are documentation and comments.
- The three `buildXxxClient` sites and `requireAuth()` are marked as the exact update targets for
  the future second credential kind.
- Future contributors adding a credential kind should start from this ADR and the annotated
  seams rather than searching the codebase.

---

## ADR-021: Observability — Leveled Fail-Open Logging, Per-Attempt Records, and Consumer-Owned Metrics/OTel/Traceparent

**Status:** Accepted

**Context:**
As the engine gained retry middleware and per-attempt record persistence, the observability surface
expanded to cover: structured logging at four levels, telemetry hooks for APM integration, and
richer `LlmCallRecord` fields (notably `attemptNumber` for retry correlation). Several related
capabilities were proposed during design: a first-party OTel package, W3C `traceparent`
propagation, an in-library metrics runtime, and configurable secret-redaction patterns. A decision
was needed on which of these belong in the library and which belong in the host or in companion
packages.

**Decision:**
The library ships three observability primitives:

1. **Leveled `Logger` port** (`debug` / `info` / `warn` / `error`, object-first `(o, m)` signature
   compatible with pino/bunyan). A `makeSafeLogger` wrapper catches and swallows any exception
   thrown by the host logger so a misbehaving logger can never break or mask an LLM call result
   (fail-open).

2. **`Telemetry` port** (`onStart` / `onSuccess` / `onError`, all optional) for OTel / Sentry /
   PostHog integration. Events fire once per logical call; `onStart` may return an opaque span
   handle that is forwarded to the terminal hooks. Hook failures are swallowed fail-open and emit a
   `debug` breadcrumb (`llm.telemetry.hook.failed`).

3. **Per-attempt `LlmCallRecord`** with `callId` (stable across retries), `attemptId`
   (minted per attempt; it only absorbs an at-least-once sink re-delivering the same record, ADR-031), `attemptNumber` (1-based ordinal), `latencyMs`, token counts, `costMicroUsd`,
   `errorKind`, and verbatim `metadata`. Records are written via `UsageSink` (fail-open). Secret
   redaction (`redactSecrets`) is applied before persistence to `errorMessage` and
   `generationConfig.providerOptions` (the Google adapter admits only `httpOptions.timeout`, so no
   headers are stored). Standard
   generation knobs and host-supplied `metadata` are not scanned.

The following are **explicitly deferred as consumer concerns**:

- First-party OTel package (the `Telemetry` port is the seam; publish an integration example).
- W3C `traceparent` propagation (needs a per-call header option no adapter has; see ROADMAP.md).
- In-library metrics runtime, `/metrics` endpoint, cache-hit gauges (derive from records +
  `Telemetry`).
- Error sampling/dedup, persisted stack traces, typed provider-error schema.
- TTFB/streaming latency (requires `stream()` pipeline).
- Rate-limiter wait-time attribution, sink-side logical-call latency.
- Configurable custom-redaction-pattern API (deferred to the `Redactor` port; see the "`Redactor`
  port" entry in ROADMAP.md).

**Rationale:**
This is a library, not a service. The library's job is to provide rich, accurate data (records and
events) and stable seams (ports). Owning a metrics runtime, an OTel SDK, or an HTTP `/metrics`
endpoint would impose infrastructure dependencies on every host and duplicate concerns the host
already solves. The `Telemetry` port is deliberately OTel-shaped (start/success/error with a span
handle) so a one-file wrapper is all a host needs to bridge it to any APM system.

**Consequences:**

- Host applications get structured log events and telemetry hooks without taking on any transitive
  infrastructure dependency from the library.
- `LlmCallRecord` fields are sufficient to derive dashboards, cost aggregations, retry rates, and
  error-kind breakdowns at the sink level.
- Hosts that need `traceparent` propagation have no per-call header option today:
  `providerOptions.google.httpOptions` admits only `timeout`. xAI's `transport.fetch` is per client, so a
  host can wrap `fetch` there. Per-call headers are listed in ROADMAP.md.
- The `metadata` field is the caller's domain anchor (tenantId, runId, traceId, etc.) and is
  stored verbatim; it must not contain secrets.
- Items listed as deferred are tracked in ROADMAP.md under "Deferred observability."

---

## ADR-022: Provider-Qualified Model Identity — Explicit `(provider, model)` Everywhere

**Status:** Accepted (supersedes the derived-provider routing and bare-model registry keying in
ADR-006)

**Context:**
Model identity was a flat string: the registry, router, and pricing lookup were keyed by bare
model id, and the provider was _derived_ (registry descriptor → `provider/model` slash-string
parse → `'unknown'` fallback, with a single-adapter routing bypass). The CLI dev providers
register bare ids like `gpt-6-sol` and `claude-sonnet-5`; a future `openai`/`anthropic` API
provider registering the same ids would collide in both routing and cost lookup. The same bare
model must be able to exist under multiple providers with different config schemas.

**Decision:**
Identity is the explicit pair (`provider`, `model`) — structured fields, never slash strings:

- `LlmRequest` and `CallSite` carry a required top-level `provider`; `model` stays the bare
  provider-native string, forwarded verbatim to the SDK/CLI.
- `ModelRegistry.resolve(provider, model)`; descriptors rename `id` → `model` and are keyed by
  the pair. Matching is exact within one provider (ADR-033 removed prefix matching). The same bare `model` under
  different providers is allowed; duplicate exact pairs throw.
- Routing is always `adapterMap.get(req.provider)`. `deriveProvider()`, the slash-convention
  parse, the `'unknown'` fallback, and the single-adapter bypass are deleted. After any router
  (default or custom) returns, the engine asserts `adapter.id === req.provider`.
- `ClientConfig.pricing` becomes `pricingSources: Record<provider, PricingSource>`; the
  `PricingSource` port shape is unchanged but is now defined as provider-scoped.
- `createClient` verifies every registry descriptor's `provider` matches a configured adapter id.
- Missing `provider`, an unconfigured provider, or an unregistered (`provider`, `model`) pair
  throws `LlmError('bad_request')` at the public API boundary (reject, don't map).

**Consequences:**

- Every call site names its provider explicitly; a model swap across providers is a two-field
  change instead of relying on derivation heuristics.
- The silent `'unknown'`-provider fallthrough and cross-provider single-adapter routing are gone;
  misrouted requests fail fast instead of running on the wrong adapter.
- Records, rate-limiter keys, and telemetry events all source `provider` from `req.provider`,
  matching the persistence layer, which already stored provider and model as separate columns.
- Breaking change to `LlmRequest`, `CallSite`, `ModelRegistry`, `ModelDescriptor`, and
  `ClientConfig` (pre-1.0, per the P0 no-legacy rule: no compatibility shims).

---

## ADR-023: Provider Packages as Self-Contained Plugins

**Status:** Accepted

**Context:**
ADR-022 made model identity provider-qualified — the registry, router, and pricing lookup are
keyed by `(provider, model)`. But the closed TypeScript surface had not caught up: `ProviderOptions`
was a hand-maintained union in `@gullabs/core` (`type ProviderOptions = { google?:
GoogleProviderOptions }`), so adding a provider's typed extension lane required editing a core file.
Similarly, `GenConfig.serviceTier` was typed as Google's literal union (`'flex' | 'standard'`),
`ModelDescriptor.capabilities.serviceTiers` was untyped/implicitly Google-shaped, and retry-tier
pinning logic and an engine-level guard both encoded Google-specific assumptions directly in core.
Core also still exported every Google/Gemini/Gemma-named symbol — pricing tables, model config
schema factories, provider option types — even though ADR-022 had already made the registry and
pricing provider-scoped in principle. The `@gullabs/claude-cli` and `@gullabs/codex-cli` dev-only
CLI packages (see the "dev-only CLI providers" work referenced in the changelog) had already proven
that a provider could ship as a self-contained package — adapter, descriptors, zero core edits —
but core itself still had Google baked in, so the pattern was proven only for providers that needed
no pricing or typed options. Consumer feedback after adopting the library (see ADR-024) surfaced
more of the same friction: gaps only visible once a second/third provider or a real consumer tried
to extend the library without touching `@gullabs/core`.

**Decision:**
Core ships zero provider knowledge. Every provider-specific concern is expressed as an extensible
seam that provider packages fill in, never as a hardcoded case inside `@gullabs/core`.

1. **`ProviderOptionsMap` module augmentation.** The old closed `ProviderOptions` union is gone.
   `packages/core/src/types.ts` now declares `ProviderOptionsMap` as an empty, augmentable interface
   (`export interface ProviderOptionsMap {}`) and `type ProviderOptions = ProviderOptionsMap`.
   Provider packages extend it via TypeScript declaration merging:

   ```ts
   declare module '@gullabs/core' {
     interface ProviderOptionsMap {
       google?: GoogleProviderOptions
     }
   }
   ```

   (see `packages/google/src/types.ts`, whose module comment notes that importing anything from
   `@gullabs/google` — including this type-only re-export — pulls in the augmentation, and that
   `packages/google/src/index.ts` re-exports it unconditionally so the augmentation always loads).
   **Runtime enforcement is unchanged.** The closed TS union never provided runtime safety — only
   compile-time ergonomics. Runtime safety was, and remains, solely the per-model strict Zod schema
   (ADR-010): a model whose schema does not admit a `providerOptions` key rejects it at parse time
   regardless of what the TS type permits.

2. **`ProviderPlugin` + `composeProviders`** (`packages/core/src/plugin.ts`). A `ProviderPlugin` is
   `{ adapter: ProviderAdapter; modelDescriptors: ModelDescriptor[]; pricingSource?: PricingSource }`.
   `composeProviders(plugins: ProviderPlugin[])` returns `{ adapters, modelRegistry, pricingSources }`
   — the exact slice of `ClientConfig` a host spreads into `createClient`. It enforces one invariant
   eagerly, at composition time, because it can no longer be recovered once descriptors are
   flattened into a single registry: **every plugin's descriptors must be self-owned** — each
   descriptor's `provider` field must equal that plugin's own `adapter.id`. Two plugins sharing the
   same `adapter.id` throws `LlmError('Duplicate adapter id "..."', { kind: 'bad_request', retryable:
false })`; a plugin contributing a descriptor whose `provider` does not match its own adapter id
   throws `LlmError('Plugin "..." contributed a descriptor for model "..." with provider "..."
(expected provider "...")', { kind: 'bad_request', retryable: false })`. An empty plugin list
   composes to an empty config on purpose — `composeProviders` does not duplicate `createClient`'s
   own "no adapters configured" check.

3. **Provider-neutral service tiers.** `GenConfig.serviceTier` (`packages/core/src/types.ts`) is now
   an opaque provider-defined `string`, not Google's literal union — admitted values are constrained
   entirely by each model's strict config schema (fixed-sampling or tierless models simply omit the
   key from their schema). `ModelDescriptor.capabilities.serviceTiers` (`packages/core/src/registry.ts`)
   widened to `readonly string[]`. Retry-tier pinning (`revalidatePinnedServiceTier` in
   `packages/core/src/retry.ts`) reads the pinned tier back against
   `req.modelDescriptor?.capabilities?.serviceTiers` — fully descriptor-driven, no hardcoded Google
   tier literals anywhere in the retry path. `flexFallback` moved out of core `GenConfig` entirely
   into `providerOptions.google.flexFallback` (`packages/google/src/types.ts`) — it is Google-only
   capacity-retry behavior and has no cross-provider meaning. The engine-level guard that used to
   reject `flexFallback` when `serviceTier !== 'flex'` was deleted from
   `packages/core/src/engine.ts` (it does not appear there any more; `git log` confirms it was
   removed in the "provider-neutral service tiers" commit on this branch) — the per-model Gemini
   config schema now enforces the same constraint at the correct layer (the provider's own schema),
   not a Google-shaped `if` in the provider-agnostic engine.

   Unknown/unrecognized tiers resolve to unpriced, not a mapped default — this is a
   provider-general pattern, not a Google-specific quirk. `computeCost` in `packages/core/src/cost.ts`
   asks the provider's lookup for concrete `(model, tier)` rates. A defined tier that the lookup
   does not price returns `microUsd: null` with `Cost.unpricedReason` naming the tier; it is never
   silently coerced to standard. `packages/xai/src/pricing.ts` independently prices its documented
   `priority` and `default` tiers and rejects other defined values. The provider owns tier meaning;
   core applies no multiplier.

4. **All Google knowledge moved to `packages/google`.** `packages/core/src` exports zero Google/
   Gemini/Gemma-named symbols (verified by grepping `packages/core/src` for `Google|Gemini|Gemma`:
   every remaining hit is a code comment or a test asserting the _absence_ of these symbols from the
   public surface, e.g. `packages/core/src/index.surface.test.ts`'s
   `removedGoogleProviderOptions`/`removedGoogleSafetySetting`/`removedGoogleSearchTool` checks).
   `computeCost` (`packages/core/src/cost.ts`) is a pure, parameterized function — it takes a
   `CostRatesLookup` that returns concrete per-tier rates and a `pricingVersion` instead of reading
   a module-level Gemini table. `packages/google/src/cost.ts`'s `geminiPricingSource` wraps it,
   resolving rates from `GEMINI_PRICING` and passing the provider-owned `pricingVersion` — core
   carries zero Gemini pricing knowledge. `ClientConfig.
modelRegistry` (`packages/core/src/engine.ts`) is a required field (`modelRegistry: ModelRegistry`,
   no `?`) — there is no default registry inside core for `createClient` to fall back to; every host
   must supply one, typically via `composeProviders`.

5. **Shared `assertRegistryInvariants`** (`packages/testing/src/registry-invariants.ts`). Extracted
   from checks that used to live in `packages/core/src/registry.test.ts` and now live in each
   provider package's own model tests. It asserts, given a provider's descriptor array: every
   descriptor carries all three schema artifacts (`configSchema`/`configJsonSchema`/`validateConfig`);
   `configJsonSchema` is not stale relative to `configSchema` (deep-equal against a fresh
   `toConfigJsonSchema(descriptor.configSchema)`); the registered model-id list matches a pinned,
   explicit `expectedModelIds` list exactly and in order (guards against silently adding, removing,
   or reordering models); when a `pricingSource` is supplied, every model is either priced
   (`pricingSource.hasModel`) or present in an explicit `explicitlyUnpriced` set (never silently
   unpriced by omission); and when fixture-list options (`adapterFixtureModelIds`,
   `negativeContractFixtureModelIds`) are supplied, every model appears in them. It is
   framework-agnostic by design — it throws plain `node:assert/strict` `AssertionError`s rather than
   depending on vitest, so it runs unmodified inside any test runner's `it(...)` block, from any
   provider package.

6. **Driver: zero core edits per provider onboarding.** A new provider ships as one self-contained
   package: adapter, model descriptors, strict per-model Zod schemas, a pricing source (if priced),
   and typed provider options — registered into a host's `ClientConfig` via one `xyzProvider()`
   factory composed with `composeProviders`. The `@gullabs/claude-cli` and `@gullabs/codex-cli`
   dev-only CLI packages already demonstrated this shape (self-contained descriptors, zero core
   edits) for unpriced providers; this ADR formalizes the pattern and extends it to priced providers
   and typed provider-option extension lanes, closing the last category of provider onboarding that
   still required editing `@gullabs/core`.

**References:** ADR-001 (ports & adapters — the architectural precedent for pluggable provider
implementations behind narrow interfaces); ADR-006 (registry); ADR-010 (model-bound, schema-described
config — the runtime enforcement layer this ADR leans on now that the TS type is open); ADR-013
(typed provider extensions — the precedent `flexFallback` follows into its new home in
`providerOptions.google`); ADR-019 (auth is per-call, not ambient — an earlier instance of the same
lesson: a closed, convenience-shaped surface in core was never the actual safety net); ADR-022
(provider-qualified identity — this ADR builds directly on it: the registry and pricing sources were
already provider-scoped in principle from ADR-022, this ADR finishes the job by making the
_packaging_ — types, composition, and core's own export surface — provider-scoped too).

**Consequences:**

- **Breaking, pre-1.0, no compatibility shims (per the P0 no-legacy rule):**
  - `ProviderOptions` as a closed union is removed; it is now `ProviderOptionsMap`, an empty
    interface each provider package augments via declaration merging.
  - `GenConfig.serviceTier` widens from Google's `'flex' | 'standard'` literal union to `string`.
    Downstream narrowings widen accordingly — `packages/drizzle/src/schema.ts`'s `service_tier`
    column was already `text('service_tier')` (never a narrower SQL enum type), so no drizzle schema
    migration is needed; it was provider-neutral at the SQL layer from the start.
  - `GenConfig.flexFallback` is removed from core; it now lives only at
    `providerOptions.google.flexFallback`.
  - The engine-level guard that rejected `flexFallback` outside `serviceTier: 'flex'` is removed from
    `packages/core/src/engine.ts`; the Gemini per-model schema enforces the equivalent constraint.
  - `packages/core/src` exports zero Google-named symbols. Moved to `packages/google`: `Google
ProviderOptions`, `GoogleSafetySetting`, `GoogleSearchTool`, the Gemini/Gemma model descriptors,
    the per-model config schemas, `GEMINI_PRICING`, `geminiPricingSource`, and the
    default Gemini/Gemma model registry.
  - `ClientConfig.modelRegistry` is now a required field; there is no core-side default registry.
  - New core exports: `ProviderPlugin`, `composeProviders`, `ProviderOptionsMap`.
- `@gullabs/any-llm`'s facade (`packages/any-llm/src/index.ts`) re-exports both `@gullabs/core` and
  `@gullabs/google` (`export * from '@gullabs/core'; export * from '@gullabs/google'`), so consumers
  of the facade package still see `googleProvider`, `geminiPricingSource`, and every other
  Google-named symbol at the same import path as before — only the _home package_ of that surface
  changed (from `@gullabs/core` to `@gullabs/google`), not its availability through the facade.
- Adding a new provider (a real API provider, not just a dev-only CLI shim) with pricing and typed
  options no longer requires any `@gullabs/core` edit — the plugin composes in via `ProviderPlugin`
  and the `declare module '@gullabs/core'` augmentation.
- Hosts that previously imported Google types from `@gullabs/core` must import them from
  `@gullabs/google` (or `@gullabs/any-llm`, which re-exports both) instead.

---

## ADR-024: `countTokens`, Cache Pre-Flight, and `geminiContentToMessages` — Closing the Adoption Gap

**Status:** Accepted

**Context:**
This ADR is driven by consumer feedback surfaced after adopting the library — gaps that were only
visible once real callers tried to use `@gullabs/google`'s stateful helpers (ADR-011) and migrate
existing hand-authored `@google/genai` prompt-building code onto any-llm's normalized shape. Three
gaps were reported: (1) there was no library-native way to count tokens for a prospective request
without paying for a full generation call — callers who wanted to estimate cost or check a payload
against Gemini's context-cache minimum-token threshold had to hand-roll a raw SDK call; (2)
`GoogleCacheStore.create()`/`getOrCreate()` (ADR-011) would dispatch a `caches.create` call to Gemini
even when the payload was obviously too small, only to have Gemini reject it — wasting a network
round-trip on a failure that was knowable client-side (Gemini 3.x's context-cache `minTokens` is
2048, encoded per-model on `ModelDescriptor.capabilities.caching.minTokens` in
`packages/google/src/models.ts`); and (3) consumers migrating existing `@google/genai`-based prompt
code onto any-llm had no supported conversion path from raw SDK `Content[]`/`Part[]` shapes into
any-llm's normalized `{ system?, messages }` request shape, and were tempted to hand-rewrite prompts
by hand (a lossy, error-prone process) instead.

Since core ships zero provider knowledge (ADR-023), all three additions had to live in
`packages/google` — this ADR is entirely new google-package surface plus one small, optional
core port.

**Decision:**

1. **`countTokens` port.** `ProviderAdapter` (`packages/core/src/ports.ts`) gains an OPTIONAL
   `countTokens?(req: TokenCountRequest, ctx: AdapterCtx): Promise<TokenCount>` method. `TokenCountRequest`
   is deliberately narrower than `ResolvedRequest`: just `provider`, `model`, optional `system`, and
   `messages` — no `config`, no `outputJsonSchema`, no `modelDescriptor`, because token counting only
   needs the text-bearing payload plus model identity. `TokenCount` is `{ totalTokens: number;
details?: Record<string, number>; raw: JsonValue }`. The engine (`packages/core/src/engine.ts`)
   exposes `Client.countTokens(request, opts)`, mirroring `generate()`'s auth/signal/registry/routing
   semantics — it resolves the descriptor, routes to the adapter, asserts the router-returned
   adapter's id matches the request's provider — but with **no cost computation and no sink/record
   emission**: token counting is a dry-run query, not a billed, auditable call, so it never touches
   `PricingSource` or `UsageSink`. If the routed adapter does not implement `countTokens`, the engine
   throws `LlmError('Provider "..." does not support token counting.', { kind: 'bad_request',
retryable: false })`. Implemented for Google via `@google/genai`'s `models.countTokens`
   (`packages/google/src/adapter.ts`), sharing `mapMessagesToGeminiContents` with `run()` so both
   code paths map messages identically — a divergence here would make a token count unrepresentative
   of the actual generation call it is meant to estimate. (Google rejects `system` and `tools`; see
   ADR-029 item 9.)

2. **`GoogleCacheStore` token pre-flight.** `GoogleCacheStoreOptions.preflight` (`packages/google/src/
cache-store.ts`) is an optional `{ minTokens: number; countTokens: (payload) => Promise<number> }`
   gate. When set, `create()` counts tokens for the exact token-bearing payload of the impending
   create (`model` + `contents` + `systemInstruction` only — `ttl` and `displayName` are excluded, as
   they carry no tokens) and throws `LlmError('GoogleCacheStore preflight: counted N token(s), below
the configured minimum of M...', { kind: 'bad_request', retryable: false })` before any SDK call
   if the count is below `minTokens`. Because `create()` is the single method both the direct path and
   the coalesced `getOrCreate()` path delegate to, the gate is enforced exactly once, with no separate
   "in-flight" gap where the coalesced path could bypass it. The `preflight.countTokens` callback
   receives genai-native `Content[]`/`Content | string`, not the library's `Message[]` — this is an
   explicit seam, by design: hosts using genai-native content directly can wire this straight to a raw
   `client.models.countTokens` call, while hosts building from `Message[]` are expected to use
   `@gullabs/core`'s new `Client.countTokens` (item 1) rather than expect this callback to convert for
   them. This prevents callers from discovering a cache-creation failure only after paying for a
   failed create-cache round-trip that Gemini would reject anyway below its minimum token threshold
   (2048 for the Gemini 3.x models registered in `packages/google/src/models.ts`).

3. **`geminiContentToMessages` migration utility** (`packages/google/src/content-to-messages.ts`).
   Converts hand-authored `@google/genai` `Content[]`/`Part[]` prompts (plus an optional
   `systemInstruction`) into any-llm's normalized `{ system?, messages }` shape, for consumers
   migrating existing raw-SDK prompt-building code onto any-llm. Uses `@google/genai` types only (no
   runtime SDK dependency — it is a peer dep, imported with `import type`). Reject-don't-map
   throughout, per the repo's established convention (ADR-009/ADR-010's schema-boundary discipline
   applied here to a conversion boundary instead of a config boundary): a missing or unrecognized
   `Content.role` throws (only `'user'` and `'model'` are recognized — any-llm never infers a missing
   role); `system` is derived ONLY from the explicit `systemInstruction` input, never inferred from
   `contents`; and the part converter does an exhaustive own-defined-key scan per `Part`, so every
   part kind or sub-field it cannot losslessly represent — function calling (`functionCall`,
   `functionResponse`), executable code (`executableCode`, `codeExecutionResult`), tool-result shapes,
   thought-flagged parts, `thoughtSignature`, `videoMetadata`, `partMetadata`,
   `inlineData`/`fileData.displayName`, `mediaResolution.numTokens`, and any `mediaResolution.level`
   value outside `MEDIA_RESOLUTION_LOW`/`MEDIUM`/`HIGH` — throws `LlmError('bad_request')` naming the
   offending field or key instead of silently dropping it.
   _Amended by the ADR-029 addendum:_ `functionCall`, `functionResponse` and `thoughtSignature` are
   no longer rejected; they convert to `tool-call` / `tool-result` parts and an imported signature
   overlay. The rest of the list still throws.

4. **Provider-payload error-taxonomy correction.** `packages/google/src/cache-store.ts`'s `create()`
   and `packages/google/src/file-store.ts`'s `upload()` previously classified a malformed-provider-
   payload response (the SDK call succeeded, but the response is missing a field the store's contract
   requires — `name` for a cache, `name`/`uri` for a file) as `kind: 'bad_request'`. Per the
   `LlmErrorKind` taxonomy in `packages/core/src/errors.ts` (`'bad_request'` = "the request itself is
   malformed"; `'server'` = "transient provider error"), a malformed _response_ from a _successful_
   provider call is a provider fault, not a caller fault — the caller's request was accepted; the
   provider's own reply is broken. Both call sites are reclassified to `LlmError('...', { kind:
'server', retryable: false, provider: 'google' })`. Unlike the read-only `adapter.countTokens`
   path (item 1), which can safely retry because it has no side effect to duplicate, these two paths
   stay `retryable: false` deliberately: `create()` and `upload()` are side-effecting and not
   idempotent — the provider may have already created the cache or stored the file even though the
   payload it returned carries no handle, so an automatic retry could orphan or duplicate
   provider-side resources instead of recovering cleanly.

**References:** ADR-023 (this ADR builds directly on the plugin architecture — `@gullabs/google` is
where all of this new surface had to live, since `@gullabs/core` ships zero provider knowledge and
none of these three additions are cross-provider concepts).

**Consequences:**

- **Breaking, pre-1.0, no compatibility shim (per the P0 no-legacy rule):** `GeminiClientLike.
countTokens` (`packages/google/src/client.ts`) is a REQUIRED addition to the structural client
  interface — any test fake or injected client implementing `GeminiClientLike` must now implement
  `countTokens` alongside `generateContent`; there is no default/optional fallback.
- New public core surface: `Client.countTokens`, `TokenCountRequest`, `TokenCount`.
- New public google surface: `geminiContentToMessages`, and the `preflight` option on
  `GoogleCacheStoreOptions`.
- Cache-store and file-store callers that previously branched on `kind === 'bad_request'` for a
  malformed-payload failure must branch on `kind === 'server'` instead; the `retryable: false`
  behavior is unchanged.

---

## ADR-025: Input Contracts — Strict Interpolation, Callsite/Request Input Validation, Pre-Dispatch Ledger Rows

**Status:** Accepted

**Context:**
`any-llm` enforces OUTPUT contracts thoroughly (`outputJsonSchema`, structured-output retry,
strict per-model config schemas per ADR-009/ADR-010) but enforced zero INPUT contracts — nothing
in `packages/core` checked whether the business content of a request was complete or sane before
dispatch. A live incident (a host application, 2026-07-09/10, `docs/archive/input-validation-middleware-proposal.md`)
dispatched a prompt template filled from a request object carrying only 2 of ~9 expected context
fields; the rendered prompt reached the provider with literal blank template labels and null-filled
JSON, and two different providers returned schema-valid-but-degenerate responses. Three LLM calls
were wasted per pipeline attempt before an app-level output check caught the shape was wrong, and
diagnosing the root cause cost a multi-hour bisect because the defect was two layers upstream of
every layer any-llm actually validates. The proposal doc also surfaced a latent reject-don't-map
violation in the library's own default path: `interpolate()` silently left `{{placeholder}}`
literals in a rendered prompt when a variable was missing or `null` — the same failure class as the
incident, one layer downstream.

The original proposal shaped this as a pre-dispatch `Middleware`. Triage (recorded in the proposal
doc's "Consumer response" and "Maintainer ruling" sections) found the seam wrong on all three counts
the a host application review raised: middleware sees the post-render `ResolvedRequest`, never the raw
pre-template fields that were actually malformed; a host application calls `generate()` with already-rendered
strings, so the library never sees the pre-template value bag middleware would need; and ledger rows
for refusals require new engine wiring regardless of seam, since sink writes live inside `runAttempt`
and quota refusals produced no row at all.

**Decision:**
Four settled rulings from the proposal's maintainer ruling, then the reshaped engine-level design
implementing them (`docs/archive/input-contracts-plan.md`, codex-approved):

1. **Middleware shape withdrawn — validation is engine-level.** The middleware seam sees only the
   post-render `ResolvedRequest` and never the raw inputs that break; input contracts are checked
   inside the engine itself, at two opt-in surfaces (below), not via `Middleware`.
2. **Schema format is `StandardSchemaV1` only** (`packages/core/src/standard-schema.ts`). No JSON
   Schema input contracts, no schema-format autodetection — matching the model-config validation
   seam (the library's only other runtime-validated contract), and avoiding a
   JSON-Schema-to-validator runtime this library has never carried and will not add.
   `outputJsonSchema` deliberately stays raw JSON Schema (`output?: { jsonSchema: JsonValue }`):
   it is a provider wire hint forwarded verbatim, not a contract the engine validates at runtime.
3. **Violations classify as `bad_request`** (`retryable: false`), not a new `LlmErrorKind` member.
   `LlmErrorOptions`/`LlmError` gain a structured `issues?: readonly LlmErrorIssue[]` field
   (`{ path, message }`, dotted path, `''` for root), normalized from `StandardSchemaV1.Issue[]` by
   a shared helper (`normalizeSchemaIssues`/`toErrorIssues` in `packages/core/src/errors.ts`) so
   every message-string formatter and the `issues` array derive from the same normalized data and
   cannot drift. `validateResolvedConfig` (model-config validation) is upgraded to attach `issues`
   to the `bad_request` it already threw — one taxonomy for all caller-fault validation errors.
4. **Ledger rule: if a call got a `callId`, it leaves a ledger row.** Generalized, not
   input-contract-specific: any `LlmError` thrown inside `runPipeline` after `callId` allocation but
   before the first attempt produces a synthetic zero-usage `LlmCallRecord`, through one shared code
   path — covering input-contract refusals, `@gullabs/quota` refusals, and any future pre-dispatch
   middleware, with zero changes to `@gullabs/quota` itself. Errors thrown before `callId`
   allocation (unregistered model, missing provider, callsite prologue failures) stay row-less —
   those are misconfigurations, not calls.

Implementing surfaces:

- **D1 — strict template interpolation (breaking default, no opt-out).** In `runStructured`, every
  `{{\w+}}` placeholder referenced by `callSite.userTemplate` or `callSite.system` must have a
  string-typed value present in `vars`, or the call is refused (`bad_request`, one `issues` entry
  per violating placeholder) before any request is built — zero tokens spent. `null`/`undefined`
  and non-string values (numbers, objects — off-type but reachable from untyped callers) are
  violations, never coerced. `vars` entries unused by any template are allowed (a shared context bag
  across call sites with different template subsets is legitimate and cannot corrupt the render).
  There is no escape syntax for literal `{{...}}` text. `interpolate()`'s old leave-placeholder
  fallback is deleted, not kept behind a flag (P0 no-legacy) — `interpolate()` is now total over its
  now-guaranteed inputs. This throws in the `runStructured` prologue, before `callId` allocation:
  row-less, same layer as unregistered-model.
- **`CallSite.inputSchema`** (opt-in, `packages/core/src/callsite.ts`) — an optional
  `StandardSchemaV1` validating `vars` before D1's strict interpolation runs (so a missing business
  field surfaces as the schema's own error, in the caller's vocabulary, not a downstream
  unresolved-placeholder violation). Row-less, same prologue as D1.
- **`LlmRequest.inputContract`** (opt-in, `packages/core/src/types.ts`) — a `{ schema, value }` pair
  for the `generate()` path. Validated inside `runPipeline` immediately after `callId` allocation
  and before the middleware chain: a violation never consumes `@gullabs/quota` budget, and
  validation runs exactly once per logical call, never per retry attempt. `inputContract` is
  consumed by the engine only — never copied onto `ResolvedRequest`, no adapter sees it.
  `runStructured` never sets it (that path uses `CallSite.inputSchema` instead — one contract per
  path, no auto-population between the two). Post-`callId`: a violation writes a ledger row via the
  D5 rule.
- **`createClient({ requireInputContract: true })`** — opt-in fleet-wide strict mode, default off.
  On, `generate()` refuses any request missing `inputContract`; `runStructured` refuses any call
  whose `callSite` lacks `inputSchema`. On the `runStructured` path this is the FIRST prologue check
  — before `inputSchema` validation, D1 interpolation, and request building (row-less). On the
  `generate()` path, the existing prologue checks (provider presence, model registration,
  `validateResolvedConfig`) run first and win, row-less exactly as today; the missing-contract
  refusal fires inside `runPipeline`, right after `callId` allocation (post-`callId` → ledger row).
  `countTokens` is out of scope: it dispatches no generation and spends no tokens.
- **Generic pre-attempt ledger record.** When the middleware chain throws and no attempt ever
  started, the engine writes one synthetic `LlmCallRecord`: `status` via the existing
  `errorKindToStatus` mapping (no new status value, `recordSchemaVersion` stays `1`), all-zero
  usage, `cost` omitted (the existing "nothing was priced" convention, not a new `cost: 0` literal),
  `attemptNumber: 0`. `attemptId` is a freshly minted id (ADR-031 deleted `idempotencyKey`; the
  original first-attempt idempotency rule no longer exists). `record.ts`'s `attemptNumber`/`attemptId`
  doc contracts are rewritten: `attemptNumber` is documented as "0 = refused before any attempt ran;
  real attempts are 1-based". **Deliberate telemetry divergence:** `CallErrorEvent.attemptId` stays absent when
  no attempt ran (its existing documented semantics, unchanged) — the synthetic record's minted
  `attemptId` has no telemetry counterpart, and this divergence is intentional, not an oversight.
  **Quota-refusal observability consequence:** this is the same code path that covers
  `@gullabs/quota` refusals with zero quota-package changes — refusals that previously left no
  ledger row now appear as `error_kind: 'rate_limited'`, `attemptNumber: 0`, zero-usage rows.

**Row-less prologue boundary** (§3 of `docs/archive/input-contracts-plan.md`):

| Failure                                          | Where it throws                      | Ledger row                     |
| ------------------------------------------------ | ------------------------------------ | ------------------------------ |
| Strict interpolation (D1)                        | `runStructured` prologue, pre-callId | No                             |
| `CallSite.inputSchema`                           | `runStructured` prologue, pre-callId | No                             |
| `requireInputContract` on callsite path          | `runStructured` prologue, pre-callId | No                             |
| `LlmRequest.inputContract`                       | `runPipeline`, post-callId           | Yes (`attemptNumber: 0`)       |
| `requireInputContract` on `generate()`           | `runPipeline`, post-callId           | Yes (`attemptNumber: 0`)       |
| `@gullabs/quota` refusal (existing)              | middleware, post-callId              | Yes (`attemptNumber: 0`) — NEW |
| Unregistered model / missing provider (existing) | prologue, pre-callId                 | No (unchanged)                 |

Rationale for the asymmetry: callsite prologue failures are deterministic call-site code defects
caught on first execution in dev/tests, in the same layer as unregistered-model; the
ledger-visibility requirement in the proposal came from the `generate()` consumer (a host application), whose
path is fully covered. The rule "callId ⇒ row" stays simple and exceptionless.

**References:** ADR-021 (leveled fail-open logging, per-attempt records — this ADR's synthetic
record follows the same fail-open sink-write discipline); ADR-009/ADR-010 (strict per-model config
schema and its `Standard Schema` validation seam — `validateResolvedConfig`,
`validateCallSiteInput`, and `validateInputContract` all share that same `~standard.validate` seam
and, as of this ADR, the same issue-normalization helper).

**Consequences:**

- **Breaking, pre-1.0, no compatibility shim (per the P0 no-legacy rule):**
  - Strict interpolation is the new unconditional default: templates that previously dispatched
    with literal `{{placeholder}}` text now fail locally with a typed `bad_request` before dispatch.
    There is no opt-out and no preserved fallback.
  - Pre-attempt refusals — including `@gullabs/quota` denials — now write zero-usage
    `attemptNumber: 0` ledger rows where they previously wrote none. `record.ts`'s `attemptNumber`
    and `attemptId` doc contracts are revised accordingly (0-based sentinel added; `attemptId`
    derivation rule documented for the `attemptNumber: 0` case).
- New public core surface: `CallSite.inputSchema`, `LlmRequest.inputContract`,
  `ClientConfig.requireInputContract`, `LlmErrorOptions.issues` / `LlmError.issues`, `LlmErrorIssue`.
- No `@gullabs/quota` package changes and no release — its refusals are covered by the generic
  pre-attempt ledger wiring in `@gullabs/core` alone.
- No `errorIssues` column added to `LlmCallRecord` / `@gullabs/drizzle` in this ADR — `issues` is not
  persisted; the record keeps `errorMessage` only. A structured `errorIssues` column remains a
  possible follow-up, out of scope here.

## ADR-026: Auth Key Attribution (`keyId`) Lives in the Engine

**Status:** Accepted

**Context:**
A client team built its own per-key attribution layer on top of `any-llm`: a companion table
mapping `llm_call_context` rows to an `api_key_id`, populated from whatever key the client-side
code _believed_ it had passed for a given call. After retries, provider fallbacks, and profile
translation inside the engine, that belief drifted from reality — 364 `xai` (Grok) calls ended up
billed to the client's "Gemini paid" key in their own denormalized table, because the client-side
attribution was recorded before dispatch, not at it. The engine is the only component that
authoritatively knows which auth material was actually used for the attempt that produced a given
outcome, since it owns auth resolution (`requireAuth`), retry, fallback, and config/profile
translation. Pushing key identity through client code as a separate, parallel-maintained field is
exactly the pattern that produced this bug: two sources of truth for the same fact, one of them
derived by inference instead of by observation.

**Decision:**
Key attribution is a first-class, opaque _label_ carried on `AuthMaterial` and captured by the
engine at the same point it resolves the concrete auth material for a dispatch attempt — not
inferred, not passed separately by the caller after the fact.

1. **`ApiKeyAuth` gains an optional `keyId?: string`** (`packages/core/src/ports.ts`). Caller-chosen,
   opaque — e.g. `'gemini-paid'`, `'grok-team-A'` — with no meaning to the library beyond "a label
   to persist verbatim." It is NEVER the secret itself.
2. **Validation ("reject, don't map"):** `requireAuth` in `packages/core/src/engine.ts` — the
   library's one auth-material validation site — rejects a `keyId` that is an empty/whitespace
   string, or that equals `apiKey` (the caller passed the secret as its own label), with
   `LlmError('bad_request', retryable: false)`. No length cap, no charset rule, no other semantic
   check — the label's meaning is entirely caller-owned.
3. **Engine-resolved, not client-threaded.** The engine captures `keyId` from the exact
   `AuthMaterial` it threads through `AdapterCtx` for the attempt that produced the recorded
   outcome (`authKeyIdOf(callAuth)` at each `buildSuccessRecord` / `buildErrorRecord` call site in
   `packages/core/src/engine.ts`, including the pre-attempt synthetic record from ADR-025's D5
   rule) — the same resolved value used for dispatch, not the caller's original request input. If a
   future credential-refresh path ever swaps auth material between retry attempts, attribution
   still tracks whatever was actually used, because it reads off the same resolved value at the
   same point dispatch does.
4. **Persisted as `LlmCallRecord.authKeyId`** (`packages/core/src/record.ts`), following the
   existing conditional-spread convention for optional fields — present only when the resolved auth
   material had a `keyId`. Explicitly excluded from redaction (`redactSecrets` never sees it): it is
   a label by design, not a secret, and case (2) above is the only guard against a caller
   accidentally aliasing it to one.
5. **`@gullabs/drizzle`:** `llm_calls` gains a nullable `authKeyId: text('auth_key_id')` column,
   written from `r.authKeyId` in `drizzleUsageSink` — same pattern as every other optional
   `LlmCallRecord` field in the sink. No migration framework exists in this package (`schema.ts` is
   the single source of truth, per the precedent set when `attemptNumber` was added); this ADR
   follows that precedent rather than introducing one.

**Non-goals (explicit scope boundary):**

- **No `keyId` on `CliSessionAuth`.** CLI-session providers (`@gullabs/claude-cli`,
  `@gullabs/codex-cli`) have no key identity to attribute — the CLI binary owns its own local
  session auth out of band, and there is no caller-supplied secret to label. Adding `keyId` there
  would be a label with nothing to identify.
- **No key registry or key-management surface in the library.** `keyId` is a caller-supplied string,
  full stop — the library does not validate it against any known-keys list, does not map it back to
  a secret, and does not offer any lookup/rotation/lifecycle API around it.
- **No validation of label semantics beyond non-empty and not-the-secret.** No length cap, no
  charset restriction, no uniqueness check, no reserved-word list. Any further validation policy is
  the caller's concern.
- **No client-side companion table requirement.** This ADR does not mandate deprecating
  denormalized client-side key-attribution tables — a client project may still maintain one for its
  own convenience (e.g. joining on `metadata`). The point is that `llm_calls.auth_key_id`, populated
  by the engine at dispatch time, is now available as the authoritative source; a client table
  becomes a derived convenience instead of the only record of the truth.

**References:** ADR-019 (no-ambient-auth, per-call auth model — this ADR extends `ApiKeyAuth` within
that same per-call contract, adds no new auth-resolution timing); ADR-021 (per-attempt records,
fail-open sink-write discipline that `authKeyId` follows); ADR-025 (`buildErrorRecord`'s synthetic
pre-attempt record, which also receives `authKeyId` via the same `authKeyIdOf(callAuth)` call).

**Consequences:**

- **Breaking, pre-1.0, no compatibility shim (per the P0 no-legacy rule):** none — `keyId` is purely
  additive and optional on `ApiKeyAuth`; every existing call site that omits it is unaffected.
- New public core surface: `ApiKeyAuth.keyId`, `LlmCallRecord.authKeyId`, `BuildRecordInput.authKeyId`.
- New `@gullabs/drizzle` column: `llm_calls.auth_key_id` (nullable `text`).
- A caller that passes `keyId === apiKey` now gets a `bad_request` at call time instead of silently
  persisting its secret into an unredacted column — this is the intended fail-closed behavior for
  the exact production mistake this ADR exists to prevent.

---

## ADR-027: `llm_calls.raw_usage` Is Nullable

**Status:** Accepted (Codex-adjudicated 2026-07-12)

**Context:**
`llm_calls.raw_usage jsonb NOT NULL` (`packages/drizzle/src/schema.ts`) assumed a provider usage
payload always exists to persist. It does not. The engine's `EMPTY_USAGE` sentinel
(`packages/core/src/engine.ts`) sets `raw: null` on every record path where no provider response
was ever received: a per-attempt error caught in `runAttempt`'s catch block (`api_error`,
`timeout`, `aborted`, `content_filter`) and the ADR-025 `attemptNumber: 0` synthetic pre-attempt
record written when the middleware chain refuses a call before `runAttempt` ever begins.
`buildRecord` (`packages/core/src/record.ts`) copies `usage.raw` into `LlmCallRecord.rawUsage`
verbatim — no default substitution. Every such record therefore carried `rawUsage: null` into any
`UsageSink`, including `drizzleUsageSink`.

Because sinks are fail-open by design (ADR-002 — a broken sink write must never fail the LLM call),
the resulting `NOT NULL` constraint violation was caught, logged to `llm.call.sink.failed`, and
swallowed. The call itself succeeded or failed normally from the caller's perspective; only the
ledger row silently never existed. `ADR-002`'s fail-open policy is correct for genuine sink
infrastructure failures — it was never meant to mask a schema defect that guarantees every
error/refusal row fails to insert.

**Decision:**
`raw_usage` drops `.notNull()`. `null` means "no provider usage payload existed for this record" —
distinct from `{}`, which would assert that the provider returned an empty-but-present payload. A
`{}` sentinel would fabricate provider data that was never received; `null` is the honest
representation and is what the engine already produces, so this is not a new sentinel, only the
schema catching up to what the engine has always emitted.

The other three `NOT NULL` JSONB lanes (`token_details`, `generation_config`, `metadata`) were
audited against the same engine record paths — `buildSuccessRecord`, `buildErrorRecord`'s
per-attempt catch-block record, and the D5 `attemptNumber: 0` synthetic record:

- `token_details` — always `usage.details`, which `EMPTY_USAGE.details = {}` on every
  no-payload path. Never `null`. `.notNull()` remains correct.
- `generation_config` — always `resolvedConfig`, computed before dispatch is ever attempted and
  passed to every `buildErrorRecord`/`buildRecord` call site unconditionally. Never `null`.
  `.notNull()` remains correct.
- `metadata` — always `metadata ?? {}` (host-supplied `CallMetadata`, defaulted). Never `null`.
  `.notNull()` remains correct.

Only `raw_usage` was affected; the invariant for each lane is now documented directly on the
`schema.ts` table and column definitions so a future field addition to the engine's no-payload
paths is checked against this precedent rather than re-discovered by another silent drop.

No migration framework exists in this package (`schema.ts` is the single source of truth, per the
precedent set in ADR-026); this ADR follows that precedent. The schema doc comment states the
required consumer migration: `ALTER TABLE llm_calls ALTER COLUMN raw_usage DROP NOT NULL;`.

**Consequences:**

- **Breaking for consumers with an existing table:** the column-level `NOT NULL` constraint in a
  live Postgres database is not retroactively altered by this library change — consumers must run
  the `ALTER TABLE` migration themselves. Until they do, the defect (rows silently dropped) persists
  unless they've independently relaxed the constraint. Documented in the changeset and in
  `schema.ts`.
- Error and pre-attempt-refusal rows now insert successfully and become visible in the ledger for
  the first time. Any downstream query, dashboard, or alert built on "the ledger already contains
  every error row" was silently wrong until this fix and should be re-verified.
- `LlmCallRecord.rawUsage`'s existing type (`JsonValue`, which already includes `null`) required no
  change in `@gullabs/core` — only its doc comment was clarified. This is a schema-shape fix
  entirely local to `@gullabs/drizzle`.

**References:** ADR-002 (fail-open sink writes — the mechanism that made this defect silent rather
than loud); ADR-025 (the `attemptNumber: 0` synthetic pre-attempt record, one of the two paths that
produces `rawUsage: null`); ADR-026 (precedent for `schema.ts`-as-source-of-truth with no migration
framework in this package).

---

## ADR-028: HTTP Status Is a Hint; Adapters Overlay Structured Bodies

**Status:** Accepted (Codex-signed 2026-08-14; design in `docs/error-classification-design.md`)

**Context:**
`classifyHttpStatus` maps 403 → `invalid_auth` unconditionally. That is a reasonable
_default_ for a bare permission failure, but providers overload 403. xAI's Responses
API returns HTTP 403 with a structured body prefix
`"Content violates usage guidelines"` (live-captured 2026-08-14 as
`SAFETY_CHECK_TYPE_CYBER` on `grok-4.5`) for input safety / AUP blocks. Without an
overlay, `classifyXaiError` left that as `invalid_auth`. Ledger `status` collapsed to
`api_error`; hosts that branch on `kind` (Sentry, Temporal `nonRetryableErrorTypes`)
routed a content-policy refusal down the auth path.

The same class of defect already had a precedent: xAI invalid API keys arrive as
HTTP **400**, and `classifyXaiError` overlays the structured prefix
`"Incorrect API key provided"` to `invalid_auth`. Gemini safety blocks arrive as
HTTP **200** + `promptFeedback.blockReason` and already throw `content_filter`.

**Decision:**

1. **HTTP status is a hint, not a kind.** `classifyHttpStatus(403)` stays
   `invalid_auth`. Core stays provider-agnostic and does not grow xAI string prefixes.
2. **Adapters overlay from a structured parsed body only** — never free-form
   `Error.message` (anti-echo). xAI 403 + body prefix
   `"Content violates usage guidelines"` → `content_filter`, `retryable: false`.
   A bare 403 without that body stays `invalid_auth`.
3. **`content_filter` covers input and output** safety / AUP refusals. Comments that
   said "refused output" are wrong.
4. **No new `LlmErrorKind`.** `content_filter` is the cross-provider kind Google
   already uses.
5. **Do not rewrite Google file/cache store classifiers** in this change. ADR-024
   keeps non-idempotent `upload()` / `create()` non-retryable; `classifyGoogleError`'s
   transport overlay would flip those to `retryable: true`. Construction
   (`getClient()`) on upload/create is outside the classified catch and stays raw.
6. **Do not invent unrecorded shapes.** Positive tests use the recorded openai
   `PermissionDeniedError` string hoist only. Unknown xAI 200 `incomplete` reasons
   stay `finishReason: 'other'` until a live 200 safety fixture exists.
7. **Classification repairs onto an existing kind are patches**, matching the
   transport `unknown` → `server` precedent (xAI 0.2.4 / Google 0.8.2).

**Consequences:**

- Hosts that mapped this 403 to an auth error type will now see `content_filter`.
  That is the intended repair, not a compatibility break. No shim, no alias.
- Prefix drift (xAI rewords the 403 body) falls back to `invalid_auth`. Fail-closed
  on unrecognized bodies; recapture, do not guess.
- Docs (SPEC, architecture, skill, READMEs, classifier JSDoc) state the
  default-vs-overlay rule. Historical Files plans get a one-line clarification only.

**References:** ADR-003 (closed `LlmErrorKind` union); ADR-024 (non-idempotent store
mutations stay non-retryable); issue
[#65](https://github.com/gul-labs/any-llm/issues/65);
`docs/error-classification-design.md`.

---

## ADR-029: Function-calling seam — tools in, parts out, no agent loop

**Status:** Accepted

**Context:**
Both Google and xAI support client-side function calling. Without a generic
seam, agentic callers bypass the library and lose cost/usage/ledger on their
most expensive calls. An agent loop, tool executor, or retry-on-tool-error
policy would be framework magic this library explicitly refuses.

**Decision:**

1. **Seam only.** `LlmRequest.tools` / `toolChoice` in; `tool-call` /
   `tool-result` parts and `LlmResult.toolCalls` out. No loop, no execution.
2. **Placement.** `tool-call` only on `assistant` messages; `tool-result` only
   on `user` messages. No `tool` role. Pairing: every `tool-result.toolCallId`
   must match a prior `tool-call`.
3. **`FinishReason` includes `'tool_calls'`.** Breaking; no compat lane.
4. **`runStructured` + `tools` is `bad_request`.** Structured-final-answer
   with a tool loop is an app-layer concern. `generate` with both `tools` and
   `output.jsonSchema` is also rejected.
5. **`description` is required** on `ToolDefinition`. `toolChoice` is invalid
   without `tools`. Tool names must be unique. `toolChoice.name` must be a
   member of `tools`.
6. **Adapters gate on `capabilities.functionCalling`.** Gemini models: true.
   Gemma: absent until verified. grok-4.5 / grok-4.6 / grok-4.7: true. CLI adapters
   `bad_request` `tools` and the new part kinds.
7. **Google mix:** `LlmRequest.tools` + `providerOptions.google.tools`
   (googleSearch) is reject-always until a model is fixture-verified.
8. **xAI replay:** live-verified 2026-08-24 that `/v1/responses` accepts
   replayed `function_call` + `function_call_output` with `store: false`.
   Named `tool_choice` uses the flat Responses form
   `{ type: 'function', name }` (nested chat-completions form 422s).
9. **`countTokens`:** Google counts `system` and `tools` through the REST `countTokens`
   with a full `generateContentRequest`, because the SDK's Developer API method
   cannot carry them (ADR-036 item 16). xAI `bad_request`s `tools` (tokenize-text
   cannot represent declarations). (This item once said Google forwarded `tools` through
   the SDK; that never worked, and a short-lived `bad_request` for both was replaced by
   the REST form.)
10. **`parallelToolCalls`** is xAI-only (`providerOptions.xai`).

**Consequences:**

- Callers own dispatch and the next `generate` turn.
- DESIGN.md un-reserves `tool-call` / `tool-result`.
- P0 no-legacy: `FinishReason` widens without an alias.

### Addendum (2026-10-03): ordered assistant message, continuation rules, Gemini 3 thought signatures

**Context.** The seam returned `text` and `toolCalls` separately, so a host could not rebuild the
model turn in provider order, and it did not say how the next turn is sent. Gemini 3.x makes both
matter. Live capture (2026-10-03, all six registered 3.x models, fixture
`packages/google/src/__fixtures__/thought-signatures-2026-10-03.json`): the model returns an opaque
`thoughtSignature` on the **first** `functionCall` of each model turn (the other calls of a parallel
set carry none) and sometimes on the final text part; a replayed turn whose first call lost its
signature is HTTP 400 `INVALID_ARGUMENT` ("Function call is missing a thought_signature"), for a
single call, for a parallel set, and for either step of a two-step chain; a replay with the
signature on a text part removed is accepted. Google's documented dummy signature
(`skip_thought_signature_validator`) was accepted on every call, which proves only that it bypasses
validation. xAI grok-4.7 already needs a different rule: its provider state holds the model's own
output and the adapter rejects assistant messages sent beside it.

**Decision.**

11. **`LlmResult.message`.** Every successful result carries the assistant output as an ordered
    `Message` (`role: 'assistant'`): the representable parts in provider order, text parts kept
    separate, tool calls with id, name and arguments. Parts with no `Part` representation (thought
    parts, xAI reasoning and server-tool items, superseded xAI message items) are omitted, and
    indices are defined over `message.parts` after the omission. `text` and `toolCalls` remain as
    conveniences derived from the same output. `AdapterResult.message` is **required** on every
    adapter, including the CLI adapters and the `@gullabs/testing` fakes: the engine does not build
    one from `text` and `toolCalls` (only the adapter knows the provider's interleaving, and a
    guessed order would be replayed). A result whose provider output has nothing representable (a
    thought-only response, for example when the output cap was spent on reasoning) has
    `message.parts === []`; a host must not append it, and an assistant message with no parts is
    `bad_request` on the next request (reject, don't map: the library does not skip it). The engine
    gives the host a copy of `toolCalls`, so editing `toolCalls[i].args` cannot change the
    arguments in `message`, which a signature hashes.
12. **`capabilities.continuation` and `LlmResult.continuation`.** The descriptor declares how the
    next turn is sent, and every result repeats it so a host needs no registry lookup. `'history'`
    (the default; Gemini, grok-4.5/4.6, every provider without replay state): append
    `result.message`, send the full history, pass `result.transientProviderState` back when present.
    `'state'` (grok-4.7): send **only the new messages** plus the state; `result.message` is for
    display and storage and must not be replayed. `capabilities.providerState: true` is what lets
    the engine forward `transientProviderState` at all; `continuation: 'state'` requires it
    (`createModelRegistry` rejects the combination otherwise). `statelessReasoningReplay` is
    deleted. With `'state'`, tool-result pairing is checked by the adapter against the state; with
    `'history'` the engine still requires a prior tool call in the messages.
13. **State is provider-scoped and bound to the host's model string.** `{ google: … }` and
    `{ xai: … }`; each adapter rejects another provider's key. The xAI state becomes
    `{ xai: { model, input } }` (it was the bare `{ model, input }`). The next turn goes to the same
    `provider` and the same `model` string the host sent, an alias included: the engine never
    rewrites an alias to the canonical id (ADR-033), state is bound to that string, and
    `LlmResult.model` stays the id the provider returned and is not for routing.
14. **Gemini 3.x signatures are an overlay on the host's history, not a copy.**
    `transientProviderState` is `{ google: { signatures: [{ messageIndex, partIndex, kind, model,
partSha256, signature }] } }`. `kind` (`'text'` or `'tool-call'`) is the signed part's kind and
    decides whether a stale entry is fatal (below). `messageIndex` is relative to the messages the
    adapter receives. The adapter builds every part from `request.messages`; the
    overlay only says which built part gets which signature. `partSha256` is the SHA-256 of the
    part's RFC 8785 canonical JSON (text: `{kind, text}`; tool call: `{kind, toolCallId, toolName,
args}`), so an edited text or argument is detected, and key order does not matter, which keeps
    history stored in Postgres `jsonb` verifiable. `canonicalJson` is exported from core (about 120
    lines, no dependency); its domain is `JsonValue` and anything else (non-finite numbers, lone
    surrogates, cycles, nesting deeper than 1000 levels, symbol keys, non-plain objects; plain
    objects from another realm are accepted) is `bad_request`. `-0` is serialised as `0`, as RFC
    8785 and `JSON.stringify` do, so a value hashes the same before and after a JSON round trip.
    - Producing: the result's state is the verified incoming overlay plus one entry for each part
      of `result.message` the model signed, with `messageIndex = request.messages.length` and the
      model string the request named. Signatures on omitted parts are dropped with a warning; an
      unsigned first function call also warns. A call that was billed is never failed for a part
      that cannot be hashed (a lone surrogate in provider output): the result is returned without
      that entry, with a warning naming the part.
    - Consuming: each entry must name an assistant message whose part at `partIndex` hashes to
      `partSha256`, and its `model` must equal the request's model string. A stale
      **function-call** entry (edit, reorder, removal, out-of-range index, another model), a
      duplicate, a host part outside the JSON domain, or a malformed overlay is `bad_request`
      before dispatch. A stale **text** entry is dropped with a warning and not carried forward:
      Google treats text signatures as optional (the capture shows replays without them are
      accepted), so dropping loses nothing required. An assistant message that replays tool calls
      must have an entry for its **first** tool-call part (matching the capture: only that call is
      signed, and each sequential step needs its own); history produced by another provider fails
      this check, naming the first `toolCallId`. The rule is stricter than Google's: a live probe
      (2026-10-03, `gemini-3.1-pro-preview`, `gemini-3.8-flash`) found an unsigned call in an
      older turn accepted, because Google validates the current turn only. The library keeps the
      strict rule so unsigned history never reaches Google by accident. Google's dummy signature
      is **not** offered (BACKLOG).
    - Trimming: indices address the host's messages, so removing messages needs the entries of
      the removed messages gone and the later `messageIndex`es shifted down.
      `@gullabs/google` exports `dropMessagesFromSignatureState(state, indices)` for that; the rule
      is whole turns only, and a message that holds a function call is never kept without its
      entry.
    - `geminiContentToMessages({ contents, model })` imports signatures from model text and
      `functionCall` parts into the same overlay instead of rejecting them; a signature on any other
      part, or without `model`, is `bad_request`.
15. **Tool results are objects on the Gemini wire.** `functionResponse.response` must be an object:
    an error result is `{ error }`, a non-object result is `{ output }`, an object passes through.
    Tool-call ids: Gemini returns `functionCall.id` (`call_<number>`, live capture 2026-10-03) and
    the adapter uses and replays it. When a response has none the adapter synthesizes
    `anyllm_call_<name>_<n>`, unique among the ids already in the request's history, and never
    sends it: a response pairs with its call by name and order, which is what Gemini documents (a
    replay with provider ids, without ids, with synthesized ids and with one id repeated across
    steps was accepted on every probed model, fixture
    `packages/google/src/__fixtures__/function-call-ids-2026-10-03.json`).
16. **`@gullabs/testing` `runToolLoop(client, req, tools, { auth })`** follows `result.continuation`
    after every turn so host tests exercise the right contract. The library still runs no loop. A
    tool that throws becomes an `isError` tool result and the loop continues; a call to a tool with
    no implementation is `bad_request`.

**Consequences.**

- Breaking, pre-1.0: `LlmResult` gains required `message` and `continuation`; the xAI state shape
  changes; `capabilities.statelessReasoningReplay` is replaced by `continuation` + `providerState`;
  Gemini 3.x requests that replay tool calls need the overlay (previously they failed at Google
  with 400); non-object tool results are wrapped instead of sent bare.
- `countTokens` sends no signatures: it counts the messages as built without the overlay. The
  endpoint accepts function calls without signatures and returns the same count with or without
  them (live capture 2026-10-03), but `generate()` bills about 110 prompt tokens per replayed
  signature, so a history with function calls on a Gemini 3 model is reported as
  `accuracy: 'estimated'` (new `TokenCount.accuracy` value: the count is below what the real call
  bills by an unreported amount). Without function calls, or on Gemini 2.5, it stays `'exact'`.
- The overlay is not secret prompt text but is opaque provider data; it is never written to the
  ledger.

---

## ADR-030: xAI server-side search controls — `toolChoice`, `maxTurns`, zero-search accounting, strict-schema dialect

**Status:** Accepted (2026-10-02)

**Context:**
A host running grounded calls on `grok-4.5` saw the model skip the search on
three of five replays of one request. The library could not send
`tool_choice` unless function tools were declared. The same review turned up
three neighbouring problems, all confirmed live on 2026-10-02 against
`grok-4.5`, `grok-4.6` and `grok-4.7` (fixtures 32, 33 and 34).

**Decision:**

1. **`providerOptions.xai.toolChoice: 'auto' | 'required' | 'none'`** maps to
   the Responses `tool_choice` and is **server-tool-only**. The adapter
   rejects it without a non-empty `providerOptions.xai.tools`, together with
   function tools, together with file attachments, and together with the
   request-level `toolChoice`. xAI defines `required` as "at least one tool";
   a declared function tool, or the `attachment_search` that a file
   attachment implicitly enables, could satisfy it without a search. The
   attachment case is inferred from xAI's docs, not live-probed (the ZDR key
   blocks attachments). Live: `required` ran 3 / 2 / 2
   searches, `none` ran 0, on the three models.
2. **`providerOptions.xai.maxTurns`** (integer ≥ 1, requires search tools)
   maps to the Responses `max_turns`
   (<https://docs.x.ai/developers/rest-api-reference/inference/responses>:
   "Maximum number of agentic tool calling turns allowed for this request").
   It caps turns, not searches
   (<https://docs.x.ai/developers/tools/tool-usage-details>).
   **xAI did not enforce it on 2026-10-02**: with `max_turns: 1` the three
   models ran 11–12, 10 and 17 searches over several rounds. The owner chose
   to expose it anyway: it is a documented request field, the adapter
   forwards the value verbatim, and hosts get the cap when xAI enforces it.
   It is not a search-count or cost ceiling. `max_tool_calls` is a response
   field only and is not exposed.
3. **Zero-search accounting.** A response where no server tool ran reports
   `num_server_side_tools_used: 0` and omits `server_side_tool_usage_details`.
   The adapter treats that as an explicit zero: no missing-counter warning,
   exact cost, no tool fee. A zero that arrives with a counters object is
   contradictory and keeps the missing-counter checks. Before this, every `none` call and every `auto`
   call that skipped the search was recorded as unpriced. When the field is
   absent, or non-zero without counters, the call stays unpriced.
4. **Strict-schema dialect is rejected, never rewritten.** With
   `text.format.strict`, xAI accepts and ignores the OpenAPI `nullable`
   keyword, so the model cannot return `null` and writes `""`, `0` or the
   string `"null"`. Uppercase type names fail at xAI with HTTP 400. The
   adapter rejects both before dispatch, at JSON Schema keyword positions
   only, naming the path. A nullable field lists `'null'` in `type`.
   ADR-034 moves this check into core (`assertStandardJsonSchema`) and extends it to the
   keywords xAI does not enforce and to tool schemas.
5. **Search + structured output is admitted on all three Grok models.**
   `structuredOutputWithTools` was set only on `grok-4.6`; live calls with
   forced search and a strict schema returned valid JSON on 4.5 and 4.7 too.
6. **Tool pricing is unchanged.** Web search is $5 per 1,000 calls
   (<https://docs.x.ai/developers/pricing>, read 2026-10-02). The forced and
   zero-search calls on all three models reconcile with xAI's billed ticks
   within whole-micro-USD rounding.

**Consequences:**

- Hosts budget searches in the prompt and assert on
  `usage.details.web_search_calls`. An unbounded research call can cross
  200k input tokens and pay long-context rates (a grok-4.7 probe: 362k input
  tokens, about $1.07).
- Hosts that emit Gemini-dialect schemas must convert them before routing to
  xAI. The library offers no converter.
- Fixture 33 pins the non-enforcement evidence. When a re-recorded fixture
  shows enforcement, update the README and this ADR.
- ADR-035 adds the provider-neutral `usage.details.web_search_requested`, and a
  known zero for `web_search_calls` when xAI states that no server tool ran.

### Amendment (2026-10-03): `searchBudget`, observed after the call

`providerOptions.xai.searchBudget: { maxWebSearchCalls?, maxXItems? }` (integers >= 1, at least one
ceiling; `maxWebSearchCalls` needs a `web_search` tool and `maxXItems` an `x_search` tool; all need
`tools`) is **never sent to xAI**, which has no per-call search ceiling (`maxTurns` is not enforced,
item 2). After the response the adapter compares xAI's counters with it: `web_search_calls` against
`maxWebSearchCalls`, `x_posts_fetched` plus `x_users_fetched` against `maxXItems`. Over budget: a
warning naming each exceeded line and `usage.details.search_budget_exceeded = 1`; the result is
returned and priced as usual, because the call is already billed. A counter xAI did not report cannot be
compared and is never counted as exceeded. It is a report, not a ceiling. ADR-040 streams the call but
does not turn this into an in-flight ceiling: whether xAI stops billing an aborted stream was not
testable, so the observed-after-the-call budget stays the only budget control. `maxTurns` stays and is
re-probed at every model refresh.

---

## ADR-031: Ledger rows are per attempt; correlation is `externalId`

**Status:** Accepted (2026-10-03). Supersedes the `idempotencyKey` rule of ADR-025 and the
"idempotency key" wording of the `attemptId` contract.

**Context:**
`LlmRequest.idempotencyKey` became attempt 1's `attemptId`, and the drizzle sink inserts with
`onConflictDoNothing` on `attempt_id`. The docs recommended reusing the key across host-level retries
(a workflow activity retry, a job-queue redelivery). That is a second billed provider call whose row
is silently dropped, so every host that followed the docs under-reported spend. Two tenants that
picked the same key would also collide.

**Decision:**

1. **Delete `LlmRequest.idempotencyKey`.** `attemptId` is always minted by the engine, one per
   attempt, including the synthetic `attemptNumber: 0` refusal row.
2. **`externalId` is the correlation id.** It is persisted on every attempt row (indexed in
   `@gullabs/drizzle`) and is deliberately not unique. A host gives every retry of one logical
   operation the same `externalId`.
3. **The library never deduplicates provider calls.** Every attempt is a billed row. The sink's
   `onConflictDoNothing` on `attempt_id` stays, but it now only absorbs an at-least-once sink
   re-delivering the same record.

**Consequences:**

- Spend is complete: a host retry that reuses an `externalId` shows up as extra rows under it, each
  with its own cost.
- Hosts with history keyed on old key-derived `attemptId`s (`key`, `key:2`, ...) must join on
  `externalId` going forward. Existing rows are not rewritten.
- A host that wants to avoid a duplicate provider call must check its own state before calling.

---

## ADR-032: xAI transport and timeout

**Status:** Accepted (2026-10-03). Twin of ADR-012, which covers the same problem for Gemini.

**Context:**
A non-streamed xAI reasoning or agentic call can run for many minutes before the first response
byte, because the Responses API sends nothing until the answer is complete. Two independent timers
sit between the host and xAI:

1. The `openai` SDK's own deadline (`timeout`), which defaults to 10 minutes.
2. Node's `fetch` (undici), which has a header timer and a body timer of 300 s each. These are not
   controlled by the SDK `timeout`.

`buildXaiClient` set neither, and per-request options carried only `signal`. A call past 300 s died
in undici, the SDK reported it as a timeout, the adapter classified it `timeout` with
`retryable: true`, and the retry middleware ran it twice more. Each retry died at the same limit and
the spend repeated.

**Decision:**

1. **SDK deadline per request.** The adapter passes `timeout` in the per-request options:
   `config.timeoutMs + XAI_TIMEOUT_BUFFER_MS` (5 000 ms) when `timeoutMs` is set, otherwise
   `XAI_DEFAULT_TIMEOUT_MS` (3 600 000 ms, one hour). The buffer keeps the engine's own deadline,
   armed at exactly `timeoutMs`, ahead of the SDK's, as in ADR-012. `XaiClientLike.responses.create`
   options widen to `{ signal?: AbortSignal; timeout?: number }`.
2. **Host-supplied transport.** `xaiAdapter({ transport: { fetch, fetchOptions? } })` (also reachable
   through `xaiProvider`) is passed to the SDK client unchanged. The SDK timeout alone does **not**
   lift undici's 300 s header timer. Only a matching undici `fetch` with
   `new Agent({ headersTimeout, bodyTimeout })` in `fetchOptions.dispatcher` does. The README shows
   the setup. The library does not build the agent itself: it has no undici dependency and the
   dispatcher must come from the same undici the host's `fetch` comes from. ADR-040 (xAI calls stream
   internally) removes the need for long reasoning calls and says exactly which calls still need it.
3. **Reject, don't map.** `transport` combined with an injected `client` is `bad_request` (the client
   owns its transport). `transport.fetchOptions` may not carry `headers`, `signal`, `body` or `method`;
   those belong to the request and are `bad_request`.
4. **Classification.** An undici header or body timeout (matched by `UND_ERR_HEADERS_TIMEOUT` /
   `UND_ERR_BODY_TIMEOUT`, or the class name, anywhere in the `.cause` chain), and the SDK's own
   deadline (`APIConnectionTimeoutError`), classify as `kind: 'timeout'`, `retryable: false`,
   `reason: 'transport_timeout'` (ADR-036). A retry reaches the same limit and repeats the spend.
   A connect timeout (`UND_ERR_CONNECT_TIMEOUT`), an OS `ETIMEDOUT` and a TLS handshake timeout are
   not matched: nothing reached xAI, so they stay retryable. The `openai` SDK wraps every fetch
   failure whose text mentions "timed out" as `APIConnectionTimeoutError`, so the class alone is not
   the SDK deadline. The adapter treats it as the SDK deadline only when the error has no cause or
   only the `AbortError` of the SDK's own controller, and the call ran at least as long as the
   `timeout` the adapter set; `classifyXaiError(error, { timeoutMs, elapsedMs })` takes that context
   and never reports an SDK deadline without it. The engine's own `timeoutMs` deadline is unchanged.
5. **Transport scope and validation.** `transport` also carries `countTokens`
   (`POST /v1/tokenize-text`) so a host's proxy or egress policy covers every request the adapter
   makes. The adapter validates it once (a `fetch` function, an object `fetchOptions` without the
   reserved keys) and copies it, so later mutation of the host's object cannot bypass the check.
   `timeoutMs` above 2147478647 (`2^31 - 1` minus the 5 s buffer) is `bad_request` in the grok
   config schemas: the SDK's timer would overflow and fire after 1 ms.

**Deliberately not built:** a library-owned undici agent; an automatic retry with a longer timer;
reading a request-level header timeout from `providerOptions`. Streaming internally is the
long-term fix and is a separate decision.

**Consequences:**

- Hosts that run xAI calls longer than 300 s had to pass a `transport` (Amendment A: ADR-040 removes the
  need for long reasoning calls); without it a non-streamed call failed at 300 s, as a single
  non-retryable `timeout` with `reason: 'transport_timeout'` instead of three billed attempts.
- `XAI_DEFAULT_TIMEOUT_MS` and `XAI_TIMEOUT_BUFFER_MS` are exported.
- Whether xAI bills a call aborted by a timeout, and what usage a timed-out attempt reports, is not
  decided here; it needs a live probe.

### Amendment A (2026-10-03): streaming changes what the timeout and the transport are for

ADR-040 sends every xAI call as a stream. Two statements above change:

- **The SDK `timeout` bounds a stream only until the response headers arrive** (openai 7.25.0:
  `fetchWithTimeout` clears its timer when `fetch` resolves, and `parseResponseWithTimeout` returns a
  streaming response unbounded). The deadline the adapter computes (decision 1) is therefore applied
  twice by the real client: as the SDK `timeout` for the header wait, and as the client's own timer over
  the rest of the stream, so it still bounds the whole call. A stream that outlives it ends as the same
  non-retryable `timeout` with `reason: 'transport_timeout'`. There is no separate idle timer.
- **The transport is no longer required for long reasoning calls.** Node's body timer is an inactivity
  timer, and a stream is never quiet for 300 s; the host transport remains for a proxy, mTLS or egress
  policy, and for the tool-using case ADR-040 names.

---

## ADR-033: Exact model ids plus declared aliases

**Status:** Accepted (2026-10-03). Supersedes ADR-006.

**Context:**
ADR-006 resolved a model string by exact match, then longest prefix. A request for
`gemini-2.5-flash-image`, `gemini-2.5-pro-preview-tts` or a live-audio variant resolved to the text
model's descriptor and was validated, adapted and priced as that text model, exact-looking and
wrong. Both adapters also guarded `descriptor.model === req.model`, so any attempt to repair this
with an alias list would have been rejected on its first call.

**Decision:**

1. **Exact match only.** `ModelRegistry.resolve(provider, model)` matches a descriptor's canonical
   `model` or one of its declared `ModelDescriptor.aliases?: readonly string[]` (real version
   suffixes). The prefix walk is deleted. An alias is unique within its provider and may not equal
   any canonical id or other alias; the registry throws at construction otherwise.
2. **Unknown ids are rejected** with `bad_request` naming the closest registered ids of that
   provider (edit distance, canonical ids and aliases).
3. **Adapters accept aliases through one core helper,**
   `assertModelMatchesDescriptor(req, descriptor, adapterProvider)`: `descriptor.provider` must
   equal both `req.provider` and the adapter's provider id, and `req.model` must be the descriptor's
   canonical id or a declared alias. The Google and xAI adapters use it.
4. **The request string is never rewritten.** It is forwarded to the provider unchanged and
   recorded on the ledger row as the host sent it. Pricing and the rate-limiter key use the
   canonical descriptor (`pricingFamily ?? model`), so a model and its aliases are priced alike and
   share a limiter bucket.
5. No built-in alias is declared without evidence of the provider serving it (ADR-013).

**Consequences:**

- Hosts that relied on prefix resolution (a dated or `-latest` suffix) must name a registered id or
  add the suffix as an alias in a custom registry.
- A new model variant is unpriced-by-mistake no more: it fails closed until it is registered.
- The Claude and Codex CLI adapters keep their own exact-id guards; they declare no aliases.

### Amendment A (2026-10-03): descriptor limits and admitted input media types

_Points 1, 2 and 4 are revised by Amendment C below: a `null` output limit, no exact-string media
matching, no `vision` / `audioInput` flags._

**Context:**
A host learned a model's output cap, window and image formats from a 400 after dispatch: xAI rejects
WebP, Gemini rejects `maxOutputTokens` above 65,536, and neither fact was on the descriptor.

**Decision:**

1. **`ModelDescriptor.limits: { contextWindow; maxOutputTokens }` is required.** There is no optional
   form and no default: every descriptor (built-in, CLI, host-authored, test fixture) states them.
   `createModelRegistry` rejects a descriptor whose limits are missing, not positive integers, or
   whose `maxOutputTokens` exceeds `contextWindow`. `maxOutputTokens` counts reasoning tokens on
   providers that reason.
2. **Values come from the provider's own documentation,** with the page and the read date in a source
   comment next to the table (ADR-013): Google model pages and the Gemma 4 model card, xAI model
   pages, Anthropic and OpenAI model pages, all read 2026-10-03. Where a provider documents no
   separate output limit (Gemma 4, xAI Grok 4.x), `maxOutputTokens` equals `contextWindow`: output is
   bounded by the window and the provider rejects what it cannot serve. This replaces the earlier
   "no artificial ceiling" wording for xAI, whose schemas accepted any positive integer.
3. **Config schemas cap `maxOutputTokens` at `limits.maxOutputTokens`,** from the same constant the
   descriptor uses, so they cannot drift. `assertRegistryInvariants` (`@gullabs/testing`) checks every
   descriptor: valid limits, and a schema with a `maxOutputTokens` field accepts exactly the limit and
   rejects one more. The CLI providers expose no output-size knob, so their schemas have no such field
   and their limits are informational.
4. **`capabilities.inputMimeTypes?: readonly string[]` lists the IANA types a model accepts in
   `inline-media` and `file-uri` parts.** Absent or empty means no media input. Adapters call one core
   helper, `assertInputMimeTypesAdmitted(messages, descriptor, adapterProvider)`, before dispatch
   (and in `countTokens`); the match is exact on the string the host sent (no case folding, no
   parameters, no `image/jpg` for `image/jpeg`) and a miss is `bad_request` naming
   `messages[i].parts[j]` and the admitted types. xAI admits `image/jpeg` and `image/png` (WebP is not
   listed in xAI's image-understanding page); Gemini admits the image, audio, video, PDF and plain-text
   document types its documentation lists; Gemma 4 admits PNG and JPEG (the types its vision examples
   use; its pages list none); the CLI providers are text-only and list none.

**Consequences:**

- Every host-authored descriptor must add `limits` (and `inputMimeTypes` if it takes media).
- A host sending a media type the provider does not document now fails before dispatch with the type
  in the message instead of a provider 400 (or silently, where the provider ignores it). xAI no longer
  accepts the non-standard `image/jpg`.
- A `maxOutputTokens` above the documented limit fails config validation instead of reaching the
  provider; for xAI that bound is the 500,000-token window.

### Amendment B (2026-10-03): registry introspection

**Context:**
A host that keeps provider-neutral call-site config, or routes a model string to a provider, had no way
to ask the registry what it knows: `resolve` needs the provider already, `listDescriptors` was optional
(so `strictPricing` failed on a custom registry that lacked it), and a model's accepted config keys
lived only inside its Zod schema.

**Decision:**

1. **`ModelRegistry.findByModel(model)`** returns every descriptor whose canonical id or declared alias
   equals `model`, across providers, in registration order (empty when none). The same bare id can
   exist under several providers (ADR-022), so it returns all of them and never picks one. Exact match,
   like `resolve`; a defensive copy.
2. **`ModelRegistry.listDescriptors()` is required** (a copy, registration order). The optional form and
   the `strictPricing` error for registries without it are deleted; `createClient` throws `bad_request`
   when `modelRegistry` lacks `resolve`, `findByModel` or `listDescriptors`.
3. **`ModelDescriptor.configKeys: readonly string[]`** is a required, derived artifact beside
   `configJsonSchema`: the sorted, de-duplicated top-level keys the schema names across all branches of
   a union (`toConfigKeys(configSchema)`, exported). It names keys only; a key can be admitted on one
   branch and not another, so the schema stays the authority for a given config. `createModelRegistry`
   rejects a descriptor with missing or stale `configKeys`, and `assertRegistryInvariants` checks it
   against `configSchema`.
4. **No pruning helper.** A host that keeps provider-neutral config builds each target's config
   explicitly (ADR-037: hosts route and fall back); `configKeys` is what it checks that against.

**Consequences:**

- Custom `ModelRegistry` implementations must add `findByModel` and `listDescriptors`; custom
  descriptors must add `configKeys` (use `toConfigKeys(configSchema)`).

### Amendment C (2026-10-03): honest limits, normalised media-type admission, snapshot registry

**Context:**
An audit of Amendments A and B found a figure no provider publishes, an admission rule stricter than
the providers, and registry answers that could drift: `limits.maxOutputTokens` was set to the context
window for xAI and Gemma 4 (neither documents an output limit), which also made the schema reject
500,001 where xAI had been live-verified to accept 100,000,000; media types were matched as exact
strings, so `IMAGE/PNG`, `text/plain; charset=utf-8` or an empty type had no accepted spelling and
Gemini's open-ended document list (`TXT, Markdown, HTML, XML, etc.`) was cut to four types; a file
uploaded with `GoogleFileStore` could be refused later by `generate`; `vision` and `audioInput` could
disagree with `inputMimeTypes`; `configKeys` was checked against the declared JSON Schema, not the
schema; shared `limits` objects were writable; `listDescriptors` was live while `resolve` was a snapshot.

**Decision (supersedes Amendment A points 1, 2 and 4 where they differ):**

1. **`limits.maxOutputTokens: number | null`.** A number is a figure the provider documents. `null`
   means the provider documents no output limit for the model: no figure is invented, the config schema
   applies no cap, and the provider decides. `null` is not "unlimited" and not the context window. It is
   required (an omitted value is refused, not read as `null`); `contextWindow` stays a required positive
   integer. The schema helper `maxOutputTokensSchema(limits)` caps only for a number, and
   `assertRegistryInvariants` checks both cases. xAI Grok 4.x and Gemma 4 are `null`; the live-verified
   acceptance of very large xAI values is restored. Every other model's figures were re-read against the
   cited pages on 2026-10-03.
2. **Media-type admission is one function, `assertMediaTypeAdmitted`,** used by
   `assertInputMimeTypesAdmitted` (every adapter, `countTokens` included) and by
   `GoogleFileStore.upload`, so a file that uploads can be used. The check reads the type
   case-insensitively with `; parameters` stripped; the string sent to the provider is never changed
   (admission is not a rewrite). An empty or malformed type is `bad_request` with its own message. An
   `inputMimeTypes` entry is a lower-case `type/subtype` or a family wildcard `type/*` (registry-checked,
   frozen). Aliases are still not mapped: `image/jpg` is not `image/jpeg`.
3. **Per provider.** xAI admits exactly `image/jpeg` and `image/png`: its image page lists the
   extensions "jpg/jpeg or png", not media types, and `image/jpg` is not a registered type, so it stays
   rejected. Gemini admits `application/pdf` and the families `text/*`, `image/*`, `audio/*`, `video/*`:
   Google lists image, audio and video types but, for documents, only "TXT, Markdown, HTML, XML, etc.";
   a type inside a family that Google does not accept is Google's error to give. `application/json` and
   other `application/*` types stay rejected. Gemma 4 admits `image/*` and `video/*`: its model card lists
   image input and video as frames (no media types are named), and audio is for other Gemma sizes. That
   the Gemini API's Gemma endpoint accepts a video part is not probed.
4. **The `vision` and `audioInput` capability flags are deleted.** `inputMimeTypes` is the single
   statement of multimodal support; `isMediaTypeAdmitted(type, list)` answers "does it take images".
5. **`createModelRegistry` trusts no declared artifact.** `configKeys` and `configJsonSchema` are compared
   with what `configSchema` yields, and `toConfigKeys` follows local `$ref`s into `$defs` (a schema with
   `.meta({ id })`) and reports an unrepresentable schema as `LlmError('bad_request')`. The registry freezes
   each descriptor's `limits`, `inputMimeTypes`, `aliases` and `configKeys`, and answers `resolve`,
   `findByModel` and `listDescriptors` from one copy of the descriptor list taken at construction.

**Consequences:**

- A custom descriptor sets `maxOutputTokens: null` when its provider documents none, and drops
  `vision` / `audioInput` for `inputMimeTypes`.
- `GoogleFileStore.upload` throws `bad_request` for an empty or unadmitted type before any bytes are sent.
- Descriptors whose `configJsonSchema` was hand-written must use `toConfigJsonSchema(configSchema)`.

---

## ADR-034: One JSON Schema dialect, fail closed

**Status:** Accepted (2026-10-03)

**Context:**
`output.jsonSchema` and `tools[].inputJsonSchema` reached the two providers in different
dialects. The Google adapter sent the output schema as `responseSchema`, the OpenAPI-flavoured
field: the SDK rewrote it, passed `$schema`, `const`, `$ref` and `$defs` through untouched,
left `$defs` types lowercase and ordered keys alphabetically. Tool parameters switched dialect on
the presence of `$schema`. xAI takes standard JSON Schema and rejects the OpenAPI dialect
(ADR-030). One schema could not serve both.

Worse, both providers accept every keyword and silently ignore the ones they do not enforce. A
live probe (P3, 2026-10-03, every Gemini and Gemma model the key could reach, no tools,
`responseJsonSchema`) asked the model to violate each keyword in turn. `const`, `allOf`,
`exclusiveMinimum`, `multipleOf` and `uniqueItems` were ignored on every model, and `oneOf` was
read as `anyOf` (an overlapping branch returned a value a true `oneOf` forbids). No request was
rejected. A host that writes `z.literal('x')` gets a schema Google accepts and does not enforce.

The same probe showed the other half: `$ref` / `$defs` (recursive too), `anyOf`, `items: false`,
`prefixItems` and `additionalProperties` are enforced on every model, and key order is preserved.

**Decision:**

1. **Contract.** `output.jsonSchema` and `tools[].inputJsonSchema` are standard JSON Schema
   (2020-12 subset). The Google and xAI adapters enforce it (they run the checks below before
   dispatch). `claude-cli` passes `--json-schema` to the CLI untouched and `codex-cli` runs its
   own OpenAI-strict preflight (`output-schema.ts`), so neither rejects `nullable` or uppercase
   types; this ADR covers the HTTP providers. `@gullabs/core` exports
   `assertStandardJsonSchema(schema, path)` (moved from `@gullabs/xai`): it rejects `nullable`,
   uppercase or unknown `type` names, `items` as an array, boolean subschemas
   (`additionalProperties` and `items` may be boolean), a value in a schema position that is not
   a schema (`properties: { a: 'string' }`), a malformed keyword value (a string `maxLength`, a
   negative or fractional count, a non-numeric `minimum`, a `required` that is not a list of
   names, a `pattern` that is not a valid regular expression), and a cyclic or more than
   128-deep object (recursion is `$ref` / `$defs`, never a cyclic JavaScript object). Only schema
   positions are inspected; `enum`, `const`, `default` and `examples` values and property names
   are data. Only the 2020-12 spellings are accepted: xAI says Draft-07 also works, but
   `definitions`, `dependencies` and `$anchor` are rejected with a hint (`$defs`, host-side
   validation, a `$defs` pointer) so one schema reads the same on Google and xAI. Error paths
   bracket-quote names that contain `.`, `[`, `]`, `"` or `\` (`properties["a.b"]`).
2. **Three keyword classes.**
   - **Annotations** (`$schema`, `$id`, `$comment`, `title`, `description`, `examples`,
     `default`, `deprecated`, `readOnly`, `writeOnly`) constrain nothing. Accepted by every
     profile and passed through.
   - **Applicators and assertions** are checked against a profile each adapter declares: the
     keywords it enforces, from the provider's own documentation (read date in the adapter) and
     live probes. Anything outside the profile is `LlmError('bad_request')` with the path
     (`output.jsonSchema.properties.kind`, `tools[1].inputJsonSchema...`) before dispatch.
     Nothing is rewritten: `const` is not turned into a one-value `enum`; the host writes the
     `enum`.
   - A keyword a provider documents as **reinterpreted** counts as not enforced. Both Google and
     xAI read `oneOf` as `anyOf`, losing the exclusive-match rule, so `oneOf` is in neither
     profile.

   **When a keyword is "enforced".** A keyword is in a profile when the provider documents it as
   enforced or live probes show it constraining the output. It is outside the profile when the
   provider ignores it: for the live probe, violated in at least 6 of 7 samples on every model of
   the family. A keyword that is supported but violated less often is **soft** (probabilistic),
   stays accepted and is documented as soft; the library never validates the result (ADR-009).
   `pattern`, `minLength` and `maxLength` are the soft keywords on Gemini (worst cell 4 of 7).
   So the accurate statement is: no keyword the provider ignores is accepted, and a soft keyword
   is a hint the host must still validate.

3. **Profiles** (`assertJsonSchemaProfile(schema, path, profile)` in core; the Google profile in
   `@gullabs/google`, the xAI profile in `@gullabs/xai`). Besides the keyword list a profile
   declares the enforced `format` values, numeric limits (`maxLength` etc.), whether recursive
   `$ref` is supported, whether `items: false` is enforced and whether `pattern` is held to the
   regex subset (no backreferences, property escapes anywhere including inside a character
   class, word boundaries, lookaround or inline modifiers). `$ref` must be local (`#` or
   `#/...`) and must resolve to a schema (not to data such as `#/properties` or `#/enum/0`); a
   chain of `$ref`s that never reaches a schema is rejected everywhere; where recursion is
   unsupported every cycle is rejected (the error names the `$ref` that closes it, and a cyclic
   `$defs` entry nothing points at is found too). A `type` array is accepted only as one type
   plus `'null'`; other unions use `anyOf`. An empty `enum` or `anyOf` is rejected.
   `propertyNames: { type: 'string' }` constrains nothing (JSON keys are strings), is what
   `z.record(z.string(), X)` emits and is accepted by every profile and sent verbatim; any other
   `propertyNames` is rejected.
4. **The portable subset** is the intersection of the **Gemini 3.x and xAI** profiles. Core
   exports it as `PORTABLE_JSON_SCHEMA_KEYWORDS` (plus `PORTABLE_JSON_SCHEMA_FORMATS`; both
   frozen) and `assertPortableJsonSchema(schema, path?)`, so a host can lint every call site in a
   build-time test. It is **not** "every provider", and a schema that passes is not guaranteed
   enforced everywhere:
   - **Gemma 4** has a stricter profile: it additionally rejects `format`, `minLength` and
     `maxLength` (it ignored them), so a portable schema can still be `bad_request` on a Gemma
     model.
   - **`claude-cli` and `codex-cli`** do not run these checks (see §1).
   - **`pattern`, `minLength` and `maxLength` are soft** on Gemini (§2): the portable check says
     both providers accept them, not that the model always obeys them.

   A test in `@gullabs/any-llm` keeps every field of the portable profile (`keywords`, `formats`,
   `limits`, `circularRefs`, `booleanItems`, `patternSubset`) equal to what the Gemini 3.x
   profile of every registered Gemini 3.x model and the xAI profile imply. Adapters do not call
   the portable check; they enforce their own profile.

5. **Google sends `responseJsonSchema` and `functionDeclarations[].parametersJsonSchema`, always.**
   `GeminiSchema`, `responseSchema` and `parameters` are deleted. The schema reaches the wire
   verbatim and in the host's key order (the wire tests assert the exact serialisation), so a
   host can put `reasoning` before `answer`. xAI runs the same assertion on tool schemas as on
   output schemas. The Gemma profile is chosen from the resolved descriptor's canonical model
   (`gemma-` prefix), never from the request string, so a declared alias still gets it.
6. **Per-provider evidence.**
   - Google's set comes from its structured-output guide (read 2026-10-03: types incl.
     `["T", "null"]`, `properties`, `required`, `additionalProperties`, `enum`, `format`,
     `minimum`/`maximum`, `items`, `prefixItems`, `minItems`/`maxItems`) plus P3 for `anyOf`,
     `$ref` / `$defs`, `items: false`, `pattern`, `minLength`, `maxLength`. P3 exercised the
     `format` values `date-time`, `date` and `email` only; `time` is named in the guide but no
     capture exercised it, so it is rejected until one does. Gemma 4 violated `format` on 7 of 7
     samples on both models and `minLength`/`maxLength` on 7 of 7 and 6 of 7, so the adapter
     rejects those three keywords for Gemma models (`pattern` was violated 0 of 7 and 4 of 7:
     soft, kept). P3 probed one simple pattern, so Google's `pattern` is held to the regex subset
     too until a capture shows lookaround or `\b` enforced.
   - **Tool schemas on Google.** P3 ran `responseJsonSchema` only. The `parametersJsonSchema`
     live evidence is P2's trivial schemas (an object with one string property and
     `additionalProperties: false`, and an empty `properties`) on the six 3.x models. `$schema`,
     `$ref` / `$defs`, `anyOf`, `items: false` and type arrays are verified for output schemas
     only; the same profile is applied to tools on that basis. Treat tool-schema acceptance
     beyond trivial schemas as resting on the output-schema probe until a tool-path probe runs.
   - xAI's set comes from its structured-outputs guide (read 2026-10-03): `$ref` / `$defs` are
     documented as non-circular only, so recursion is rejected; `format` is enforced for date,
     time, date-time, email, uuid, ipv4, ipv6 and uri; `minLength`/`maxLength` up to 2,048,
     `minItems`/`maxItems` up to 256 and `minProperties`/`maxProperties` up to 64 are enforced
     and a larger value is rejected; `pattern` is a regex subset; `allOf` is enforced for a
     single subschema only and is rejected outright; `not`, `if`/`then`/`else` and unlisted
     formats are best-effort and rejected. `items: false` is undocumented and rejected. The
     guide does not list `properties`, `required`, `items` or `prefixItems` as keywords (it
     names `properties` and `prefixItems` in its 400 list), so those four rest on the listed
     `object` and `array` types. `additionalProperties` as a schema (and Zod's
     `additionalProperties: {}`) is forwarded on the strength of the guide's `additionalProperties`
     entry; no xAI capture exercised it.

| Keyword                                                               | Google (Gemini)                        | xAI                                                 | Portable                          |
| --------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------- | --------------------------------- |
| `type` (incl. `['T', 'null']`), `properties`, `required`              | yes                                    | yes                                                 | yes                               |
| `additionalProperties` (boolean or schema)                            | yes                                    | yes                                                 | yes                               |
| `enum`, `anyOf`                                                       | yes                                    | yes                                                 | yes                               |
| `$ref` / `$defs` (local)                                              | yes, recursive too                     | yes, non-circular                                   | non-circular                      |
| `items`, `prefixItems`, `minItems` / `maxItems`                       | yes                                    | yes (up to 256)                                     | yes (up to 256)                   |
| `minimum` / `maximum`                                                 | yes                                    | yes                                                 | yes                               |
| `format`                                                              | date-time, date, email                 | date, time, date-time, email, uuid, ipv4, ipv6, uri | date-time, date, email            |
| `pattern`, `minLength` / `maxLength`                                  | yes, soft; `pattern` is a regex subset | yes (up to 2,048; `pattern` is a regex subset)      | yes (same limits), soft on Gemini |
| `propertyNames: { type: 'string' }` only                              | yes (no-op)                            | yes (no-op)                                         | yes (no-op)                       |
| `items: false` (closed tuple)                                         | yes                                    | no                                                  | no                                |
| `const`                                                               | no (ignored)                           | yes                                                 | no                                |
| `exclusiveMinimum` / `exclusiveMaximum`                               | no (ignored)                           | yes                                                 | no                                |
| `minProperties` / `maxProperties`                                     | not probed                             | yes (up to 64)                                      | no                                |
| `oneOf`                                                               | no (read as `anyOf`)                   | no (read as `anyOf`)                                | no                                |
| `allOf`                                                               | no (ignored)                           | no (single only)                                    | no                                |
| `multipleOf`, `uniqueItems`                                           | no (ignored)                           | undocumented                                        | no                                |
| `not`, `if`/`then`/`else`, other `propertyNames`, `patternProperties` | no                                     | no                                                  | no                                |

The table is for Gemini; Gemma additionally drops `format`, `minLength` and `maxLength`.

**Consequences:**

- Breaking. Schemas using the OpenAPI dialect, `const`, `oneOf`, `allOf`, `exclusiveMinimum`,
  `multipleOf`, `uniqueItems`, a constraining `propertyNames` or an unlisted `format` are
  rejected before dispatch on the provider that would ignore them, and so are malformed schemas.
  The changeset says what hosts change.
- Zod: `z.toJSONSchema` emits `const` for `z.literal('x')` (use `z.enum(['x'])`; `z.literal(['a',
'b'])` already emits `enum`), `oneOf` for `z.discriminatedUnion` (model the variants with
  `z.union`, which emits `anyOf`), `items: false` for `z.tuple`, a multi-type `type` array for a
  union of primitives, and a recursive `$ref: '#'` for a recursive type. `z.record(z.string(),
X)` emits the no-op `propertyNames: { type: 'string' }` and works; `z.record(z.enum([...]), X)`
  and `z.record(z.string().regex(...), X)` emit a constraining `propertyNames` and are rejected.
  `reused: 'ref'` emits `$defs`/`$ref`, which both providers accept. Zod's `startsWith`,
  `endsWith` and `includes` (and `z.iso.duration()`) emit a non-standard `format` next to a
  `pattern`; the format is rejected (it is not enforced anywhere). For the first three, keep the
  pattern and drop the format with `.meta({ format: undefined })` after the check, or write
  `z.string().regex(...)` directly; `z.iso.duration()`'s pattern uses lookahead and is outside
  the regex subset, so validate durations host-side. The pinned fixture
  `packages/core/src/__fixtures__/zod-4.6.5-json-schemas.json` records the output and the
  verdict per provider and for the portable subset (including both workarounds); a Zod upgrade
  that changes the output fails its test. Re-pinning (`PIN_ZOD_FIXTURES=1`) is refused when `CI`
  is set.
- Hosts that need a schema one provider rejects either change the schema or validate that
  constraint themselves. The library offers no converter.
- The Codex and Claude CLI adapters keep their own schema rules (codex-cli's strict preflight;
  claude-cli forwards the schema untouched); this ADR covers the HTTP providers.
- Fixtures: `packages/google/src/__fixtures__/response-json-schema-2026-10-03.json` (P3 counts per
  keyword and model), `packages/xai/src/__fixtures__/structured-output-schema-docs-2026-10-03.json`
  (the documented rules), and the Zod fixture above (ADR-013).

---

## ADR-035: Search usage facts; grounding cost is estimated

**Status:** Accepted (2026-10-03). Amends ADR-013 and ADR-030; replaces the `google_search_requested`
marker.

**Context:**
A pricing source sees only `(model, usage, tier)`. The first fix for unpriced Gemini grounding
(ADR-013's 2026-10-03 amendment) had the adapter write a Google-only synthetic key into `usage.details` so
the pricing source could mark the cost estimated. That key said that Search was requested, nothing about
whether it ran or how often, and the cost still left out the fee. xAI already reported a search count
(`web_search_calls`) and a separate `server_tools_requested` flag, under names a host cannot share with
Google. A host that wants to know "did Search run, and what did it cost" read a different place per provider.

Live evidence (2026-10-03):

- **P4**, every Gemini 3.x model with and without a response schema, `googleSearch` on, four calls each:
  without a schema every model returned `groundingMetadata` with at least one query on 4 of 4 calls. With a
  schema, 3.1 Pro returned it on 2 of 4 and the other five models on 0 of 4 (a prompt-token jump with no
  metadata appeared on some, so some schema calls probably searched without saying so). No model reached the
  3-of-4 bar this record set for turning the pair on by default.
- **P5**, a grounded Gemini 2.5 call told to repeat one query three times: `webSearchQueries` held three
  identical entries (3 occurrences, 1 unique) and `usageMetadata` carried `toolUsePromptTokenCount`
  (77 on Flash, 141 on Pro), counted in `totalTokenCount` but not in `promptTokenCount`. Gemini 3.x
  deduplicated its queries on 14 of 14 attempts and reported no tool-use tokens. Whether Google bills a
  repeated query, or bills tool-use tokens as input, could not be reconciled: the billing export was not
  available.

**Decision:**

1. **Two normalised facts, on every provider.** `usage.details.web_search_requested` is `1` when the
   request enabled web search and absent otherwise. `usage.details.web_search_calls` is the observed
   number of searches, absent when the response does not say; an explicit zero is a known zero. xAI
   already emitted the count; it now also sets `web_search_requested`, and reports `0` when xAI states that
   no server tool ran. Google counts **occurrences** in `groundingMetadata.webSearchQueries` (a repeated
   query counts each time); `webSearchQueries` absent or metadata absent means the count is unknown. The
   Google-only `google_search_requested` key and its exported constant are deleted.
2. **Occurrences, always estimated.** Occurrences are the conservative count: nothing measured shows a
   repeat is free. Because the free daily allowance Google publishes is shared across a project's calls, no
   single call can know it was free, so every grounding fee is charged in full and a call that ran Search
   is always `confidence: 'estimated'`. A known zero (Search requested, response reports zero queries) did
   not run it and prices exactly.
3. **The `tools` lane.** The Google pricing source adds the grounding fee to `Cost.details.tools`
   (`microUsd` stays the sum of four lanes): Gemini 3 charges per query, `web_search_calls x 14_000` uUSD;
   Gemini 2.5 charges per grounded prompt, `35_000` uUSD once however many queries ran. Rates are from
   Google's pricing page, read 2026-10-03, and carry `pricingVersion` `gemini-2026-10-03`. Requested with the
   count unknown: the lane stays `0`, the cost is estimated and the adapter warns that the fee is not
   included. Gemma has no token price in the snapshot, so it has no grounding price.
4. **Warnings.** A call that requested Search and whose response has no `groundingMetadata`, or metadata
   with no `webSearchQueries`, carries a warning saying so, on the result and on the attempt's row, also
   when the attempt fails after billing.
5. **`requireGrounding` fails closed.** `providerOptions.google.requireGrounding: true` passes only on
   positive evidence: `groundingMetadata` present and `web_search_calls >= 1`. Anything else throws
   `LlmError` kind `server`, `retryable: true`, reason `grounding_missing`, with the attempt's usage
   attached so the billed tokens reach the ledger. It needs `googleSearch` in the same request
   (`bad_request` otherwise). It is off by default except as item 6 says.
6. **Schema plus Search is an opt-in.** `structuredOutputWithTools` stays `false` on all six Gemini 3.x
   descriptors (P4). `providerOptions.google.allowSchemaWithSearch: true` admits the pair on such a model
   and turns `requireGrounding` on unless the host passes `requireGrounding: false`, so the default for an
   opted-in call is to fail rather than return an unsearched answer. The flag needs `googleSearch` and
   `output.jsonSchema` in the request, and a model with `capabilities.grounding`. A descriptor may set
   `structuredOutputWithTools: true` only on evidence of at least 3 of 4 schema calls returning metadata
   with a query.
7. **Tool-use tokens and inconsistent totals.** `usage.details.tool_use_prompt` records
   `toolUsePromptTokenCount` whenever Google reports it; it is not added to input and not priced.
   Core's `normalizeUsage` compares `totalTokens` with `inputTokens + outputTokens`: a larger total adds a
   warning and the engine reports the call's cost as `'estimated'`, for any provider. A Gemini 2.5 grounded
   call trips it.
8. **Citations.** `Citation.cited` and `Citation.textRange` (UTF-16 offsets into `LlmResult.text`) come
   from Gemini `groundingSupports` (chunk referenced by a support; first supported segment, converted from
   the UTF-8 byte offsets Google documents) and from xAI `url_citation` annotations (a non-empty range is an
   inline citation and covers xAI's inline marker; a zero-width annotation is a source that is not cited
   inline). xAI no longer reports a numeric-only title (its marker number) as a title. Google's
   `searchEntryPoint`, which Google requires a grounded answer to display, is also on
   `providerMetadata.google.searchEntryPoint`. The `googleSearch` options (`excludeDomains`,
   `timeRangeFilter`) stay out of the strict schema until a probe shows what they do (BACKLOG).

**Consequences:**

- Breaking. `GOOGLE_SEARCH_REQUESTED_DETAIL` and the `google_search_requested` detail are gone: read
  `web_search_requested` (and `web_search_calls`). Grounded Gemini rows now carry a priced `tools` lane in
  `cost.details`; `cost_micro_usd` includes it. The ledger has no confidence column yet, so a row that ran
  Search is still recognised by `token_details->>'web_search_requested' = '1'`; treat its cost as an
  estimate that can overstate (free allowance) or understate (unpriced tool-use tokens, unknown counts).
- **Open question, recorded rather than guessed:** whether Google bills repeated queries, and whether it
  bills `toolUsePromptTokenCount` as input. Both can only be settled against a billing export. Until then
  occurrences are counted and tool-use tokens are recorded unpriced, and the cost stays estimated.
- Schema plus Search on Gemini 3.x is possible but not default. The measured rates are in
  `docs/grounded-structured.md`.
- Fixtures (ADR-013): `packages/google/src/__fixtures__/grounding-schema-matrix-2026-10-03.json` (P4) and
  `grounding-usage-fields-2026-10-03.json` (P5), redacted: model answer text and call cost removed. Amendment A adds
  `grounding-supports-2026-10-03.json`, one full grounded response with `groundingSupports` (Japanese and
  emoji answer, thought parts), redacted to distinct redirect placeholders.
- Request-side search intent (one option that means "search" on every provider) is deferred to its own
  decision.

### Amendment A (2026-10-03, grounding audit)

An adversarial audit of the grounding release found money and correctness defects. Item 5, item 6 and the xAI
`cited: false` half of item 8 above are replaced by the rules here; everything else stands.

1. **`grounding_missing` retryability depends on the schema.** With an output schema attached the error
   is `retryable: false`: the capture shows the same schema + Search request missing on every call of
   five of six Gemini 3 models (0 of 4), so a retry repeats a billed failure, the argument ADR-036 made for
   `transport_timeout`. Without a schema it stays `retryable: true`: the same models grounded on 4 of 4
   calls. A retry middleware therefore makes one attempt and writes one billed row for the schema case.
   A host that wants more attempts overrides `shouldRetry` and accepts the spend. `LlmResult.cost` of a
   retried success covers only the final attempt; the earlier attempts' spend is in the ledger rows.
2. **`requireGrounding` is judged after the finish reason.** Only a candidate that finished normally
   (`STOP`, or no finish reason) is checked for evidence. A `SAFETY`, `RECITATION`, `BLOCKLIST`,
   `PROHIBITED_CONTENT` or `IMAGE_SAFETY` candidate with no evidence throws `content_filter`,
   `retryable: false`, usage attached, instead of `grounding_missing`; a filter block is deterministic and
   the host must see it. A filtered candidate that does carry evidence, and any other non-`STOP` finish
   (`MAX_TOKENS` is `length`), is returned as it is without the flag.
3. **Schema + Search opt-in only where it was measured.** `structuredOutputWithTools: false` means a
   capture showed Search missing and the host may opt in per call. Absent means nothing was measured:
   the pair is rejected with or without `allowSchemaWithSearch`. Gemini 2.5 and Gemma have no capture
   (P4 probed Gemini 3.x only), so both reject, with a message saying so. A non-boolean
   `allowSchemaWithSearch` or `requireGrounding` is a `bad_request` that names the field and the received
   type, checked before any other rule.
4. **Queries are non-empty strings.** `web_search_calls` and the `requireGrounding` evidence count only
   non-empty strings in `webSearchQueries`. An empty array is a known zero; a non-empty array that names
   no query is unknown (the cost is estimated with an empty `tools` lane and `requireGrounding` fails).
5. **Tool-use prompt tokens stay unpriced.** `usage.details.tool_use_prompt` is recorded and not priced; a
   Gemini 2.5 grounded call is therefore understated by those tokens at the input rate (about 176 uUSD on
   the P5 Pro sample). Whether Google bills them is the open billing question above; no upper bound is
   guessed into the price.
6. **xAI `cited` and ranges.** `cited` is never `false` on xAI: a `0`/`0` annotation means no marker range
   was reported, and a captured X Search answer (fixture 19) shows inline citation markup in its text with
   only `0`/`0` annotations, as do the structured answers (fixtures 18, 27, 32), so `cited` stays absent
   there. A non-empty range is `cited: true` and is checked: the slice of the joined text must be exactly
   `[[label]](<the annotation's url>)`, indexed UTF-16 from the start of its `output_text` part; otherwise
   the range is dropped with a warning and the source stays `cited: true`. A title is dropped only when it
   equals that marker's label, so a numeric real title survives. Whether xAI counts code points or UTF-16
   around emoji, and how it indexes a multi-part message, is not in any capture; the check makes a wrong
   assumption lose a range instead of emitting a wrong one.
7. **Gemini `textRange` is verified, not assumed.** A live capture (Japanese answer with emoji, two thought
   parts before the answer; fixture `grounding-supports-2026-10-03.json`) showed that `startIndex` and
   `endIndex` are UTF-8 bytes into the answer part, and that `partIndex` does not count thought parts (the
   answer sat at parts index 2 and its segments omitted `partIndex`). The adapter indexes non-thought parts
   and checks every range against `segment.text`: when the answer at the converted range is not exactly
   that text the range is dropped, the source stays `cited: true`, and the result carries a warning. A
   segment without `text` is accepted on the offsets alone.
8. **`searchEntryPoint` is stored once,** at `providerMetadata.google.searchEntryPoint`; the raw
   `providerMetadata.groundingMetadata` omits it. The HTML is kilobytes and persisted on every grounded row.
   It is untrusted markup (Google's CSS plus model-chosen query strings): the README says to render it in
   a sandboxed iframe.
9. **`pricingVersion` `gemini-2026-10-03` marks the new grounding lane,** not a token re-read: token rates
   were last verified 2026-09-25. A row priced under the older version has no `tools` lane.

---

## ADR-036: Retry honours provider delays; errors carry typed reasons

**Status:** Accepted (2026-10-03). Part 1 (reasons), the core half of Part 2 (retry, deadline, sink,
classification) and the adapter items (10-20) are implemented.

### Part 1 — Error reasons are a closed, typed vocabulary

**Context:**
`LlmErrorKind` and `retryable` say what class of failure happened and whether a retry may help, but
several distinct causes share one kind: a local quota window, a provider daily quota and an account
out of credits are all `rate_limited, retryable: false`, and a host reacts to each differently
(reschedule, alert, top up). Hosts were left matching message text.

**Decision:**

1. **`LlmError.reason?: LlmErrorReason`,** a closed union exported from `@gullabs/core`. Members:
   `transport_timeout`, `quota_window`, `daily_quota`, `credits_exhausted`, `spend_ceiling`,
   `grounding_missing`, `cache_not_found` (and `quota_store_unavailable`, added by
   ADR-041 Amendment A; `search_budget_exceeded` was reserved here and deleted by ADR-040). `kind` and `retryable` stay
   authoritative; `reason` only says why within a kind, and is absent when no named cause applies.
   `retryable` follows whether a retry can change the outcome: `grounding_missing` is `retryable: true`
   only when no output schema is attached (a schema + Search call keeps missing, ADR-035 Amendment A).
2. **The union is closed on purpose,** so adapters cannot invent reasons. Adding a member is a core
   minor release under the lockstep versioning in `RELEASING.md` (pre-1.0, so a minor may break an
   exhaustive `switch`). The changeset lists the new members and hosts keep a `default` branch. There is no
   namespaced extension form: a provider-specific condition that needs a reason gets a core member.
3. **The reason is persisted and observable.** `LlmCallRecord.errorReason` (absent on success and when
   the error has no reason), the `error_reason` text column of `llm_calls`, and
   `CallErrorEvent.reason`. It is written on provider-attempt rows and on refusal rows
   alike (ADR-037 item 6).
4. **The database column has no CHECK constraint.** The vocabulary lives in the TypeScript union; a new
   member must never need SQL. A host that wants database-side validation can add its own constraint and
   owns keeping it in step with the changeset notes.
5. **SQL ships with the column.** `@gullabs/drizzle` ships `sql/install.sql` (fresh install),
   `sql/upgrades/0001-add-error-reason.sql` (from the 0.7.2 shape, idempotent) and a migration test
   that proves the upgraded table equals a fresh install and keeps existing rows. A
   `recordSchemaVersion` bump alone would migrate nothing, and the record version stays `1`: the field is
   additive and optional.
6. **Wrappers keep the reason.** Adapter overlays that rebuild an `LlmError` (`classifyGoogleError`) copy
   `reason`; an adapter or middleware that throws a reasoned `LlmError` is persisted as thrown.

**Consequences:**

- Hosts branch on `error.reason` (or the `error_reason` column) instead of message text.
- Existing rows keep `error_reason` NULL. Hosts using `@gullabs/drizzle` apply
  `sql/upgrades/0001-add-error-reason.sql` before upgrading the sink, or inserts fail on the missing
  column. The sink stays fail-open (ADR-002) and has no compatibility path for the old shape, so
  the failure is made loud instead: every dropped row is logged at `error` as the stable event
  `llm.call.sink.failed` (with `callId`, `attemptId`, `attemptNumber`, `provider`, `model`), and
  `assertLlmCallsSchema(db)` lets a host check the table from a deploy step, readiness endpoint or
  boot without a running client.
- Some members are declared before every emitter ships; the changesets say which release emits which
  reason.

### Part 2 — Retry honours provider delays; the engine bounds its own waits

**Context:**
Several waits in the engine had no bound, or undercut one a provider asked for. `retryMiddleware`
clamped a provider `Retry-After` to `maxDelayMs` and retried early; a retry whose backoff outlasted
the `timeoutMs` budget slept the whole budget away and then threw a synthetic, non-retryable
`timeout` that hid the real failure; a sink that never answered held a billed result past `timeoutMs`
and ignored abort; middleware time was never counted against `timeoutMs`; a limiter slot leaked when
`acquire` resolved after a timeout won; `countTokens` had no timeout; `classifyError` read the message
before the status, so an `HTTP 400` whose text said "timeout" was retried and a refused connection
was a non-retryable `unknown`.

**Decision (core):**

1. **A valid provider delay is honoured, never undercut.** `computeBackoffMs` treats the provider's
   `retryAfterMs` (positive and finite; `NaN`, zero and negative values are not delays) as a floor and
   adds jitter on top (at most 10 % of it, at most 1 s), so workers limited together do not retry in
   the same millisecond. When the failed attempt carries a delay longer than `maxDelayMs`, or one that
   leaves the next attempt no usable window before the deadline, `retryMiddleware` stops and rethrows
   that attempt's own error with `retryAfterMs` intact, so an orchestrator can schedule the work. This
   holds whatever a custom `shouldRetry` says. There is no clamp option: a retry before the provider's
   delay is refused again and billed again. `maxDelayMs` caps only the computed backoff; its default is
   60 s, equal to `@gullabs/quota`'s `maxDeferMs`, so a per-minute quota deferral is slept and retried.
   `maxAttempts` must be a positive integer and `baseDelayMs` / `maxDelayMs` finite numbers from 0 to
   2^31 - 1 (`bad_request` at construction).
2. **The retry shares the engine's budget and rethrows the attempt's own error.** The engine puts the
   end of the call's budget on `EngineCtx.deadlineAt` (on the client's `Clock`); retry measures against
   it, never against the time it was entered, so middleware time before it counts. It does not sleep
   into, and does not start an attempt in, a window shorter than 250 ms (a request that short cannot
   complete and only adds a billed row): it rethrows the error of the attempt that just failed, the
   same object with `cause` and `retryAfterMs` intact, never a synthetic one. The engine's own deadline
   errors (the gate, a refused attempt) carry the last attempt's error as `cause`, and surface that
   error itself when it is a `timeout` or carries a provider delay. `timeout` is retryable wherever
   Core produces it (the engine's timer, a 408, the deadline); an adapter may mark a specific
   transport timeout non-retryable with `reason: 'transport_timeout'` (xAI does).
3. **The logical-call deadline starts with the call.** `runPipeline` arms `timeoutMs` before the
   middleware chain, so middleware time counts against it, and merges it into `EngineCtx.signal`.
   An attempt's window is what the deadline has left, measured on the injected `Clock` (the timers
   that enforce it are monotonic `setTimeout`s). While no attempt is in flight the deadline rejects
   the call with `timeout` (`timeout` wins over any abort error a cooperative middleware throws in
   reaction), and an orphaned continuation of a middleware that wakes later is refused before it can
   dispatch or write a row. While an attempt is in flight, including its sink write, the attempt
   enforces the deadline itself and records the failure as its own row; the deadline waits and, one
   macrotask after the attempt ends, ends the call if it is still pending, so an outer middleware that
   hangs after a failed attempt cannot hold `generate()`. If the attempt produced a result, that
   billed result is returned, not turned into a timeout, including when work after `next()` runs past
   the deadline or hangs (only that work's changes to the result are lost). Caller abort is still
   enforced by each attempt, as before; a middleware that ignores the signal is not interrupted by
   abort, only by the deadline. A signal that is already aborted never starts a call or dispatches an
   attempt (the call fails with `aborted` and one refusal row; `countTokens` calls no adapter).
   `config.timeoutMs` must be a finite number greater than 0 and at most 2^31 - 1 (`bad_request`
   before any row), as must `sinkTimeoutMs` and `countTokens`' `timeoutMs`: a longer timer fires after
   1 ms. The gemini and grok config schemas cap `timeoutMs` at 2^31 - 1 minus the 5 s SDK buffer, since
   the SDK's own deadline is `timeoutMs` plus that buffer.
4. **The sink write is bounded by `sinkTimeoutMs` (default 5 s) and by abort and the deadline.** On
   expiry the engine logs `llm.call.sink.timeout` at `error` (`callId`, `attemptId`, `attemptNumber`,
   `provider`, `model`, `timeoutMs`), abandons the write (a late rejection is swallowed) and carries
   on. The wait also ends 100 ms after the caller aborts or the deadline timer fires
   (`llm.call.sink.interrupted`, same fields plus `graceMs`); the write is always started, a healthy
   sink still has the grace to land its row, and a hung one no longer holds an abort or the deadline
   for `sinkTimeoutMs` per row. This extends ADR-002's fail-open rule to a sink that does not fail but
   does not answer.
5. **A late `acquire` is released.** When a timeout or abort wins the race against
   `rateLimiter.acquire`, the engine calls the `Release` that `acquire` resolves with later. `acquire`
   must still honour the signal; this only stops a limiter that cannot cancel from leaking a slot.
6. **`classifyError` weighs structured evidence first.** Order: `LlmError`, `AbortError`, an HTTP
   status (an integer 100-599, or a three-digit numeric string, as `status`, `statusCode`, `code` or
   under `response` / `error`, on the error or any error on its `cause` chain), `TimeoutError` by
   name, a transport failure, then the message heuristic last. `isTransportError` is exported from
   core and is the one matcher, with `causeChain` as the shared bounded, cycle-safe walk: a `code`
   of `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE`, `ENOTFOUND`, `ENETUNREACH`,
   `EHOSTUNREACH` or an undici connection code (`UND_ERR_CONNECT_TIMEOUT`, `_HEADERS_TIMEOUT`,
   `_BODY_TIMEOUT`, `_SOCKET`, `_RES_CONTENT_LENGTH_MISMATCH`; undici's programming errors are not
   transport failures), or an error whose whole message is `fetch failed`, `connection error` or
   `socket hang up` (or a Node syscall failure such as `connect ECONNREFUSED 127.0.0.1:443`). Adapters
   call `classifyError` and overlay what a structured body proves; none keeps its own matcher. A
   transport failure is a retryable `server` error, except undici's own deadlines
   (`UND_ERR_*_TIMEOUT`), which stay retryable `timeout`. `classifyHttpStatus` maps 404 and 413 to
   `bad_request` (not retryable), leaves 409 `unknown`, and carries the provider's delay on every
   retryable status (408, 429, 5xx). A provider overlay can still reclassify from a structured body
   (ADR-028).
7. **`parseRetryAfter(headers, now)`** reads `retry-after-ms`, `retry-after` (delta-seconds with
   decimals, an HTTP-date, or a duration such as `6m0s`) and the reset headers (`x-ratelimit-reset`,
   `-requests`, `-tokens`, `ratelimit-reset`; above 1e9 a Unix timestamp in seconds, above 1e12 in
   milliseconds). Several values of `retry-after` (an array, or comma-joined duplicates) give the
   longest. The reset headers say when each limit resets, not which one refused the call (OpenAI
   sends `x-ratelimit-reset-tokens: 1s` beside `x-ratelimit-reset-requests: 6m0s`), so the delay is
   the longest reset among windows whose `-remaining` is 0 and otherwise the shortest reset of all: the
   earliest moment a retry can succeed, never a delay that stops the retry because an unrelated
   window is long. A value that is not a positive delay is ignored, results round up, and the cap is
   24 hours. It is exported, and `classifyError` uses it for `retryAfterMs` (from `headers` or
   `response.headers`).
8. **`countTokens` uses the cancellation race and takes `timeoutMs`.** `CountTokensOptions` adds an
   optional `timeoutMs` (finite, greater than 0 and at most 2^31 - 1, `bad_request` otherwise; no
   default). Abort and the timeout end the call even when the adapter ignores its signal.
   `countTokens` has no limiter and writes no row.
9. **`generate`, `runStructured` and `countTokens` reject only with `LlmError`.** Anything else
   thrown on the way (a host registry, a middleware, a bug) is passed through `classifyError` and the
   original is kept as `cause`. A caller abort keeps `AbortSignal.reason` as `cause`, including when a
   cooperative adapter or middleware throws that reason itself.

**Reconciled with earlier work:** the middleware boundary guard (ADR-037) is unchanged; the quota
`maxDeferMs` cap stays, the retry middleware's `maxDelayMs` default (60 s) equals it so a per-minute
deferral is slept and retried, and a deferral longer than a smaller `maxDelayMs` ends the retry with
the deferral error instead of waking early; xAI's non-retryable
`transport_timeout` classification runs before `classifyError` and is unchanged; the
`llm.call.sink.failed` event is unchanged and `llm.call.sink.timeout` and
`llm.call.sink.interrupted` are its siblings.

**Decision (adapters):** structured errors read from the parsed body only, never the message text
(ADR-028).

10. **Google error overlays** (`classifyGoogleError`, over core's `classifyError`):
    - `RetryInfo.retryDelay` (a protobuf Duration, `"34s"`) becomes `retryAfterMs`, read through core's
      `parseRetryAfter` so rounding and the 24-hour cap are shared. The SDK's `ApiError` keeps no
      headers, so the body is the only source.
    - A `QuotaFailure` violation whose `quotaId` contains `PerDay` is `rate_limited`,
      `retryable: false`, `reason: 'daily_quota'`, with no `retryAfterMs` (the delay in the body is the
      per-minute one and would mislead a scheduler).
    - `ErrorInfo.reason` `API_KEY_INVALID` or `API_KEY_EXPIRED` is `invalid_auth`. Google sends the
      invalid-key case as HTTP 400, which read as a caller bug.
    - A 403 whose body message starts `CachedContent not found` is `bad_request`,
      `reason: 'cache_not_found'`. Google gives no structured reason for it, so this is the one
      overlay keyed on a body message; a real permission failure cannot be told apart from it
      (the message itself says "or permission denied"), and a genuine 403 with any other message
      stays `invalid_auth`.
    - `retryDelay` must be a protobuf Duration: decimal seconds with an `s` suffix (`"34s"`,
      `"0.847655010s"`), or an object `{ seconds, nanos }` rendered to the same text. Anything else
      (`"3"`, `"1h"`, `"6m0s"`) is ignored, and a zero delay is not a delay, so the caller's own back-off
      applies.
    - Evidence: the invalid key and stale-cache bodies are live captures (probe P6, 2026-10-03,
      `__fixtures__/error-bodies-2026-10-03.json`). `API_KEY_EXPIRED` could not be produced (an expired
      key cannot be fabricated), and **no Gemini 429 body survives**: the probe log (P3) records that
      Gemma answered HTTP 429 with the words "exceeded your current quota" on 22 of 92 calls at 8-way
      concurrency, but those bodies were overwritten, so it is unverified whether a real 429 carries a
      `QuotaFailure` or `RetryInfo`. The expired-key, per-minute and per-day bodies are therefore
      **doc-derived**: only structure, taken from the field names of `google.rpc.ErrorInfo`, `RetryInfo`
      and `QuotaFailure` in googleapis' `error_details.proto` (read 2026-10-03), with no message text
      and no quota values (a `quotaId` is an illustrative name that exercises the `PerDay` substring
      match). The fixture says so. The overlays read those details only when present; the `PerDay`
      match should be re-checked against a real capture.
    - `GoogleFileStore` and `GoogleCacheStore` classify every SDK failure (upload, polling, delete, cache
      create) through the same function, so a bad key on an upload is `invalid_auth`, a per-day quota is
      `daily_quota` and is not retried (the bytes are not sent again), and the stores' errors carry
      `provider: 'google'`. Only a malformed payload after a successful call stays `server`, not retryable
      (the resource may exist).
    - A transport failure is core's job (item 6): the local Google and xAI regex copies and the
      Google model-not-found overlay (now core's 404 rule) are deleted. xAI keeps only the `openai` SDK
      `APIConnectionError` class match, which a caller-chosen message can hide from core, and its
      undici timeout rules, which run first and stay non-retryable.
11. **An output-side filter stop is a failure.** A candidate whose `finishReason` is `SAFETY`,
    `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_SAFETY`, `IMAGE_PROHIBITED_CONTENT`
    or `IMAGE_RECITATION` and that has no non-thought text and no tool call throws `content_filter`,
    `retryable: false`, with the billed usage (and `servedServiceTier`) attached; the message names the
    raw reason, a bounded `finishMessage` and the safety ratings (`category=probability`, `(blocked)`
    for the one that blocked), and `cause` carries the raw `finishReason`, `finishMessage` and
    `safetyRatings`. Error rows store only the message, so the blocking category reaches the ledger. A
    blocked prompt names `promptFeedback.safetyRatings` the same way. A stop that kept partial text or a call is a success with
    `finishReason: 'content_filter'`. The check runs before `requireGrounding` is judged, so a filtered
    empty candidate is never reported as `grounding_missing` (ADR-035); the existing rule that a
    filtered candidate with partial text and no grounding evidence throws `content_filter` is kept.
    `providerMetadata.google.candidate` carries the candidate's raw `finishReason`, `finishMessage`,
    `safetyRatings`, `citationMetadata` and `urlContextMetadata` when present, so `'other'` (a malformed
    function call, a language refusal) is distinguishable. Every successful row therefore carries at
    least the raw finish reason. The copy is bounded because it is persisted on every row and
    `finishMessage` can hold the model's own malformed call text: `finishMessage` is cut at 512
    characters, a list at 50 entries, a string at 2048 characters and nesting at 8 levels, with a
    warning when anything was cut.
12. **Flex capacity is HTTP 503 only.** `isGeminiCapacityError(err)` is true for HTTP 503. Google's Flex
    page (dated 2026-09-23) lists 503 and 429 for "no capacity" but names no field that tells a capacity
    429 from a quota 429, and no real 429 body was captured (item 10), so no 429 is inferred to be
    capacity. A Flex 429 is the ordinary rate limit: the `RetryInfo` delay is honoured by
    `retryMiddleware`, no Standard call is dispatched at once (it would undercut the delay, add a call to
    a rate-limited project and bill the logical call at the Standard rate), and the engine does not pin
    the tier. Revisit only with a captured capacity 429 that carries a structured marker. The old
    message regexes and the short-lived `RESOURCE_EXHAUSTED`-without-`QuotaFailure` inference are
    deleted; nothing reads the message text.
13. **xAI credits exhausted.** HTTP 429 or 403 whose structured body text matches
    `Your team <id> has either used all available credits or reached its monthly spending limit` is
    `rate_limited`, `retryable: false`, `reason: 'credits_exhausted'`; the error message omits the team id
    (an account identifier that would reach logs and ledger rows) and the id stays on `cause`.
    **This body is doc-derived, not a capture:** probe P7 could not exhaust the account, xAI's error reference
    (`docs.x.ai/docs/key-information/debugging`, read 2026-10-03) lists 403 and 429 with no body, and
    the sentence comes from public bug reports of the live API (one reports a 429, one a 403). The code
    comment, the fixture's `_note` and this item say so; replace the fixture with a capture when one
    exists. A bare 403 stays `invalid_auth`, and the sentence in free text never matches.
14. **A 200 that reports failure is an error.** A Responses object with `status` `failed` throws,
    classified by `error.code`, with the response's usage attached when it reports token counts:
    `server_error` is a retryable `server` error, `rate_limit_exceeded` a retryable `rate_limited`;
    `bio_policy`, `misalignment_policy_violation` and `image_content_policy_violation` are
    `content_filter`; `invalid_prompt`, `data_residency_mismatch` and the `invalid_image*` family are
    `bad_request`; any other or missing code is `unknown`. Only the first two are retried: a
    deterministic failure is refused and billed again. `status: 'cancelled'` is `unknown`, not
    retryable (a cancel is deliberate). An `error` object beside a completed response is **not** a
    failure: it is not a documented shape (`error` is set only on a failed response, and live captures
    carry `error: null`), and the billed answer is kept. Provenance: xAI's API reference
    (docs.x.ai/docs/api-reference, read 2026-10-03) lists `status` `completed`, `in_progress` and
    `incomplete` and names an `error` object without its codes; `failed`, `cancelled` and the codes
    come from OpenAI's Responses object as typed in the openai SDK (`ResponseError.code`), which
    xAI's API is compatible with. None was captured (doc-derived fixture, placeholder messages). `incomplete_details.reason: 'content_filter'` is **not** mapped to
    `finishReason: 'content_filter'`: no fixture shows that reason, so it stays `'other'` until one does.
15. **`parallelToolCalls` needs a tool.** `providerOptions.xai.parallelToolCalls` with neither function
    tools nor `providerOptions.xai.tools` is `bad_request` before dispatch (same rule as `toolChoice`).
16. **Google `countTokens` carries `system` and `tools`.** The SDK's Developer API `countTokens` throws on
    both, so with either present `buildGoogleClient` sends the REST `countTokens` with a
    `generateContentRequest` (`model` as `models/<id>`, `contents`, `systemInstruction`, `tools`; the
    request form excludes top-level `contents`, per `ai.google.dev/api/tokens`, dated 2026-08-17). A
    non-2xx response is thrown as the SDK's own `ApiError`, so it classifies exactly like a
    `generateContent` failure; the body is read once, a structured `{ error }` body is passed on as
    sent, anything else (an HTML proxy page, an unparseable JSON body) is wrapped with its text cut to
    500 characters and classified by status, and a 200 whose body is not a JSON object is a retryable
    `server` error. **This REST form has not been checked against a live call** (probe P2c counted
    `contents` only; the wire tests stub `fetch`), so its exact accuracy with `system` and `tools` is
    unproven. An empty `system` string is absent in `countTokens`, `generate()` and the `cachedContent`
    conflict check. A messages-only count still goes through the SDK. The tool schemas are
    held to the same JSON Schema profile as `generate()`. The R1.3 rule stands: function calls in the
    history of a Gemini 3 model keep `accuracy: 'estimated'` (replayed signatures are billed and the
    count carries none). Wire tests run the real SDK with only `fetch` stubbed. This replaces the
    short-lived `bad_request` for these fields.
17. **`cachedContent` excludes `system` and `tools`.** Gemini rejects a request that sets
    `system_instruction`, `tools` or `tool_config` together with `cachedContent`, so that combination
    (including `providerOptions.google.tools`) is `bad_request` before dispatch, with an `issues` entry
    per field. `GoogleCacheStore.create` and `getOrCreate` accept `tools` and `toolConfig`, and the
    pre-flight token count sees the tools, so a tool-calling call can use an explicit cache.
18. **`safetySettings` values are enumerated.** `category` is one of the six `HarmCategory` values the API
    reference lists as supported (`HARM_CATEGORY_HARASSMENT`, `_HATE_SPEECH`, `_SEXUALLY_EXPLICIT`,
    `_DANGEROUS_CONTENT`, `_CIVIC_INTEGRITY`, `_JAILBREAK`) and `threshold` one of
    `HARM_BLOCK_THRESHOLD_UNSPECIFIED`, `BLOCK_LOW_AND_ABOVE`, `BLOCK_MEDIUM_AND_ABOVE`,
    `BLOCK_ONLY_HIGH`, `BLOCK_NONE`, `OFF`. Sources, read 2026-10-03: `ai.google.dev/api/generate-content`
    and `ai.google.dev/gemini-api/docs/safety-settings` (dated 2026-09-17), cross-checked against the SDK
    enums; the SDK's `HARM_CATEGORY_IMAGE_*` members are marked unsupported in the Gemini API and are not
    admitted. The one list (`safety-settings.ts`) feeds the adapter check and every model's config
    schema, so a typo fails before a round trip and the derived JSON Schema shows the choices.
19. **CLI runners.** Both runners add a `stdin` `error` listener (a CLI that exits early made the write
    raise an unhandled `EPIPE` that crashed the host), decode stdout and stderr with a `StringDecoder`
    (a multibyte character split across chunks was corrupted), cap stdout at 32 MiB (past it the process
    is killed and the call rejects with an `OutputLimitError`; stderr keeps its last 1 MiB), and
    `codex exec` receives the prompt on stdin with `-` as the positional argument instead of one argv
    entry (Linux caps one argument at 128 KiB, so a large history failed with `E2BIG`). Each CLI is
    spawned `detached` (its own process group on POSIX) and a timeout, abort or cap kill signals the
    group (`SIGTERM`, then `SIGKILL` after 5 s, then the runner closes its pipe ends), so a grandchild
    that inherited the pipes cannot hold `close` open past the deadline (a repro with a 0.5 s timeout
    settled after 12 s before). The CLI no longer receives the host's Ctrl-C.
20. **File upload and size limits.** `GoogleFileStore.upload` passes `signal` to the SDK and also races
    the wait against it, because `@google/genai` 2.25.0 does not act on `abortSignal` in `files.upload`
    (an abort releases the caller; the bytes may still be stored). A `FAILED` file keeps the provider's
    `File.error` (message in the text, the status as `cause`), and follows its `google.rpc.Code`:
    `DEADLINE_EXCEEDED` (4), `INTERNAL` (13) and `UNAVAILABLE` (14) are a retryable `server` error (the
    failure is the provider's; a fresh upload can succeed), any other code or none is a non-retryable
    `bad_request`. A polling timeout is `kind: 'server'`, `retryable: false`, not `timeout`: this item
    and the table in `docs/architecture.md` give `timeout` one retryability rule (retryable), and the
    upload already succeeded, so a retry would upload the bytes again and orphan the first file
    (ADR-024); `server` non-retryable is the existing shape for a resource-creating call that must not
    be repeated (a malformed upload or cache-create payload).
    The adapter rejects before dispatch an inline PDF over 50 MB or a request whose inline data and text
    certainly exceed 100 MB (`ai.google.dev/gemini-api/docs/files` and `/file-input-methods`, both dated
    2026-09-23; MB read as MiB, the looser reading), pointing at `GoogleFileStore`.

**Delay against the default retry policy:** `retryMiddleware`'s default `maxDelayMs` is 60 s. A typical
Gemini per-minute `retryDelay` (about 30 to 40 s) is slept in full and retried; a longer one (a delay over
60 s) stops the retry and surfaces the 429 with `retryAfterMs` for a scheduler (item 1), so a host that wants
to wait longer in process raises `maxDelayMs`. xAI and the other providers go through the same rule.

**Reconciled with earlier work (adapters):** ADR-029 item 9 is corrected; ADR-035's `requireGrounding`
ordering is kept (item 11); ADR-028's rule that overlays read structured bodies is followed, with the
stale-cache message as the one documented exception.

**Consequences:**

- Hosts that relied on the retry middleware sleeping a clamped `Retry-After` now see the 429 surface
  with `retryAfterMs` set after the first attempt when the delay exceeds `maxDelayMs`. Raise
  `maxDelayMs` to wait longer in process, or reschedule from `retryAfterMs`.
- A call with `timeoutMs` and a backoff that cannot fit now fails with the provider's error (for
  example `server`, `retryable: true`) rather than a `timeout`. Hosts matching on the synthetic
  message must match on `kind`.
- `retryMiddleware` no longer takes a `now` option (it reads `EngineCtx.clock` and `deadlineAt`), and
  rejects invalid `maxAttempts`, `baseDelayMs` and `maxDelayMs` at construction. Its default
  `maxDelayMs` is 60 s.
- `EngineCtx.signal` can now abort with an `LlmError('timeout')` reason; middleware that waits should
  honour it.
- A host that passed `opts.timeoutMs` to nothing before can pass it to `countTokens`.
- 404 and 413 stop being retried or treated as unknown: they are `bad_request`.
- Google: a per-minute 429 now waits the provider's `retryDelay`; a per-day quota is `daily_quota`
  and not retried; a bad key is `invalid_auth`; a stale `cachedContent` is `bad_request` with
  `cache_not_found` (the host drops the handle and recreates the cache); the file and cache stores
  classify the same way; a Flex 429 follows the rate-limit path (only a 503 falls back to Standard); an empty filtered candidate
  throws `content_filter` instead of returning an empty success; `countTokens` accepts `system` and
  `tools`; `cachedContent` with `system` or `tools` and an unlisted `safetySettings` value are
  `bad_request`; a `GoogleFileStore` polling timeout is a non-retryable `server` error.
- xAI: a team out of credits is `credits_exhausted` and not retried (hosts alert instead of
  rotating keys); a failed 200 is classified by its `error.code` with its usage (only `server_error` and
  `rate_limit_exceeded` retry; `invalid_prompt` is `bad_request`, policy codes `content_filter`, a cancel
  and unknown codes `unknown`);
  `parallelToolCalls` without tools is `bad_request`.
- `codex exec` gets the prompt on stdin; a host that inspected the argv for the prompt must read the
  runner's `input` instead.

### Amendment: advisory spend preflight emits `spend_ceiling` (2026-10-03)

`spendPreflightMiddleware({ limitMicroUsd, key, spentSoFar })` in `@gullabs/core` is the first emitter of
`reason: 'spend_ceiling'`. The host supplies `spentSoFar(key)` from its own ledger; at or above
`limitMicroUsd` the call fails before dispatch with `rate_limited`, `retryable: false`, `reason:
'spend_ceiling'`, so the retry middleware does not sleep on it, and a refusal row is written
(ADR-037 item 6). It is **advisory**: the read and the dispatch are not atomic, so concurrent calls can
each pass and overshoot; the call that crosses the ceiling is allowed; and billed calls with unknown
usage (`microUsd: null`) count only if the host's `spentSoFar` counts them. A ceiling that holds needs atomic
reservation and reconciliation, an own design tracked in `BACKLOG.md`. It sets no `Middleware.role`:
it is correct inside or outside retry (outside: once per logical call; inside: re-read per attempt), so
the quota-inside-retry rule does not apply to it. Placed inside retry, a provider failure followed by a
ceiling hit leaves the caller with the `spend_ceiling` error; the provider's error stays in the earlier
attempt's sink row.

A ledger that cannot be read fails the call closed with `server`, `retryable: false` and the ledger's
error as `cause` (not `rate_limited`: no ceiling was reached; not `unknown`; not retryable: the retry
would read the same ledger, and a host that falls back to another provider on `server` should not take
a ledger outage for a provider fault). An invalid reading is `bad_request`.

**`search_budget_exceeded` was reserved and is now deleted (ADR-040).** It was held back for a streaming
release that would abort a call once an xAI search counter crossed the budget. That release streams the
call but does not abort it (whether xAI stops billing an aborted stream could not be tested), so nothing
emits the reason, and a closed union holds only members that are emitted. The xAI `searchBudget` option
(ADR-030 amendment) observes the budget after a billed call and reports it as a warning and
`usage.details.search_budget_exceeded`, never an error. A later in-flight abort adds the member back with
its emitter.

---

## ADR-037: Middleware cannot reroute

**Status:** Accepted (2026-10-03). Amends ADR-007.

**Context:**
ADR-007 described middleware as a way to build provider fallback. The engine let a middleware change
`provider` or `model` on the request, but validated, priced and authenticated with the original call's
descriptor and auth. A Google-to-xAI switch sent Gemini's `serviceTier: 'flex'` to xAI and recorded
`microUsd: null`; a same-provider switch was priced at the original model's rates with no warning.
The owner decided hosts own routing and fallback; the library offers neither.

**Decision:**

1. **Boundary check.** The engine wraps the `next` it hands to every middleware and compares
   `req.provider` and `req.model` with the call's values at that boundary. A difference fails with
   `bad_request` ("middleware may not change the provider or model; route in the host and make a
   new call") with an `issues` entry per changed field. The offender is caught as it calls `next`,
   before anything inside it runs, so quota middleware inside it consumes nothing. A middleware
   outside the offender has already run and is not refunded. The rejection writes a zero-usage
   refusal row: `attemptNumber: 0` when no attempt had run yet, otherwise the number of the refused
   attempt (see item 6).
2. **Call identity.** At call start (synchronously at the top of `generate()` / `runStructured()`,
   before any `await`, so a host reusing and reassigning one request object cannot change it) the engine records `{ provider, requestedModel, descriptor }`:
   the provider, the exact model string the host sent (a declared alias stays an alias, ADR-033) and
   the descriptor object it resolved. `runAttempt` dispatches, validates config, prices, routes and
   authenticates with these and never reads `provider`, `model` or `modelDescriptor` from the
   request it receives. The boundary also overwrites a swapped `modelDescriptor` with the
   pinned one before an inner middleware sees it, so a quota policy that reads the descriptor counts
   under the model that is dispatched.
3. **Scope.** The library does not copy or freeze requests or descriptors to defend against a
   middleware that mutates nested data in place after calling `next`. That is a host bug the
   boundary check cannot see, and guarding it needs deep copies and frozen descriptors, which break
   `AbortSignal`, functions and Zod schemas. The middleware contract says: treat the request as
   immutable once passed to `next`; to change data, pass a new object.
4. **No rerouting API, no fallback middleware.** A host that wants fallback catches the error and
   calls `generate` again with the other target's config and auth: a separate logical call with its
   own `callId`, priced and recorded correctly by construction. Hosts link the two with the same
   `externalId`.
5. **Quota placement.** `Middleware` gains a readonly `role?: 'retry' | 'quota'`, set by
   `retryMiddleware` and `providerQuotaMiddleware` and not configurable. `createClient` rejects, with
   `bad_request`, a client that puts a quota middleware before a retry middleware: quota accounts
   one unit per provider dispatch, which needs it inside retry. The check reads `role`, never `id`,
   runs over a copy of the list frozen at `createClient` (reordering the host's array afterwards
   changes nothing), and cannot see a wrapper or composed middleware that does not carry the inner
   one's `role`.
6. **Refusal rows.** The call's final error is always in the ledger. When it did not come out of
   `runAttempt` (input-contract refusal, boundary refusal, quota deferral, retry budget exhausted,
   abort during back-off) the engine writes one zero-usage, unbilled row with the error's kind and
   `reason`: `attemptNumber: 0` when no attempt had run, otherwise the refused attempt's number (never
   below the last real attempt + 1). An attempt a middleware refused and a later attempt re-ran
   leaves no row, so a gap in attempt numbers means "refused before dispatch".
7. **The engine re-checks the registry (ADR-033).** After `registry.resolve`, `generate`,
   `runStructured` and `countTokens` verify that the descriptor belongs to the provider and that the
   requested string is its canonical id or a declared alias, so a host registry that prefix-matches
   or falls back is refused instead of mispricing.

**Consequences:**

- ADR-007's statement that provider fallback is implementable as middleware is deleted.
- Hosts that rerouted in middleware move that logic outside `generate`; see the README "Fallback"
  section.
- Middleware can still pass a new request object with changed config, messages or metadata to
  `next`.

---

## ADR-038: Opt-in payload storage

**Status:** Accepted (2026-10-03). Extends ADR-002 (fail-open sinks), ADR-027 and ADR-039 (the ledger). Amended
2026-10-03 after the R11 audit: bounded, linear-time redaction; payload built after the outcome inside the sink
budget; a truthful statement of what `llm_calls` holds; reused transaction handles; batched purge; a stricter
upgrade guard.

**Context:**
`llm_calls` stores usage, cost, configuration, metadata, citations, tool calls and reasoning text, but not the
prompt and not the model's answer. A host that has to debug or audit a call (what exactly was sent, what exactly
came back, why a structured output failed to parse) builds its own payload table and wires the write by hand
at every call path, each with its own redaction, size limit and retention. The stored text can hold customer
data, so the library must not store the full prompt and response by default, and a payload write must never cost
a ledger row or fail a call.

The ledger row is not text-free, and that is the existing contract (ADR-027, ADR-039): it carries the model's
tool-call arguments, its reasoning text, the error message of a failed attempt, citations and the host's
`metadata`. The payload opt-in does not change that and does not govern it. This ADR says so, and the table in
decision 3 lists every text-bearing place.

**Decision:**

1. **Opt-in per client.** `ClientConfig.payloads?: { redact?, maxChars?, include? }`. Absent, nothing is
   captured and the sink is called exactly as before. Present, every attempt that reached the adapter, success
   or failure, gets one payload, unless `include(request)` returns anything but `true` or the call opts out.
   `payloads` without a `sink` is `bad_request` at `createClient`, as is an unknown key, a non-function or
   `async` `redact` / `include` (detected by the function's type, plus a thenable returned at run time, which
   drops the payload with a warning), or a `maxChars` that is not an integer of at least 1,000 (below that the
   JSON skeleton alone does not fit). The config is copied and frozen at `createClient`. The sink must declare
   `UsageSink.acceptsPayloads: true` (`drizzleUsageSink` and `RecordingSink` do); otherwise `createClient` logs
   one `llm.config.payloads.sink_ignores_payloads` warning and no payload is built, so a sink that would drop
   the second argument costs no capture work. An attempt refused before dispatch (a middleware refusal, a config
   failure, a limiter that rejected) sent nothing and has no payload.
2. **Per-call opt-out on both entrypoints.** `generate(request, { auth, storePayload })` and
   `runStructured(callSite, vars?, { auth, storePayload })`. `false` skips the payload for the call; `true` or
   absent follows the client; `true` never switches storage on for a client that did not enable it. Any
   non-boolean is `bad_request`. `runStructured` builds its request internally, so the option cannot live on
   the request.
3. **What is captured, and what is not.** The payload is `{ request, response }`. Request, as the adapter
   received it (after middleware), snapshotted at dispatch so that a host changing its request during the call
   changes nothing stored: `system`, every message as `{ role, parts }`, text verbatim, tool-call arguments and
   tool-result values as JSON, an inline media part as `{ kind, mimeType, bytes, sha256 }` (decoded size and
   SHA-256, never the bytes; above 20 MiB decoded it is `{ bytes, sha256: null, skipped: 'too_large' }`, and
   data that is not valid base64 is `{ bytes: null, sha256: null, skipped: 'invalid_base64' }`, dropping only
   that part), a `file-uri` as scheme, host and path only (userinfo, query string and fragment are removed: a
   signed URL is a credential), a `file-ref` as its id, and tools as `{ name, schemaSha256 }` (SHA-256 of the
   canonical JSON of `inputJsonSchema`; descriptions are not stored). Response: the raw model text, or the raw
   JSON text of a structured output when the adapter returned only the parsed value, and the attempt's error
   message when it failed. `transientProviderState` is never stored. Reasoning text and the model's tool calls
   are not repeated in the payload; they are on the ledger row.

   What holds text, and what governs it:

   | Where                                                  | What it holds                                                                                                                                                          | Core secret patterns                                          | Governed by `payloads` / `include` / `storePayload` / purge and delete |
   | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
   | `llm_calls.reasoning_text`                             | The model's reasoning text, when the provider returns it (16 KiB cap)                                                                                                  | Yes                                                           | No                                                                     |
   | `llm_calls.tool_calls`                                 | The tool calls the model made: id, name, arguments as JSON                                                                                                             | Yes: every string, and the value of a key named like a secret | No                                                                     |
   | `llm_calls.error_message`                              | The error text of a failed attempt (provider error text, which can echo part of a request; 16 KiB cap)                                                                 | Yes                                                           | No                                                                     |
   | `llm_calls.metadata`                                   | The host's `CallMetadata` bag, verbatim                                                                                                                                | No, never scanned                                             | No                                                                     |
   | `llm_calls.citations`                                  | Source URL, title and source name of a grounded answer                                                                                                                 | No                                                            | No                                                                     |
   | `llm_calls.provider_metadata`, `raw_usage`, `warnings` | Provider-reported JSON and engine diagnostics                                                                                                                          | No                                                            | No                                                                     |
   | `llm_calls.generation_config`                          | The call's settings; `providerOptions` is scrubbed (the Google adapter admits only `httpOptions.timeout`, so no headers are ever in it)                                | Partly                                                        | No                                                                     |
   | `llm_call_payloads.request`                            | The system prompt; every message part (text, tool-call arguments, tool-result values); media as type, size and SHA-256; file references; tools as name and schema hash | Yes, then the host's `redact`                                 | Yes                                                                    |
   | `llm_call_payloads.response`                           | The raw model text, or the attempt's error message                                                                                                                     | Yes, then the host's `redact`                                 | Yes                                                                    |

   `storePayload: false`, `include` and the off-by-default setting govern the payload table only; they never
   keep the `llm_calls` text columns out of the ledger, and `purgeLlmCallPayloads` / `deleteLlmCallPayloads` do
   not touch them. There is no second opt-out for the ledger columns (the ledger contract is unchanged): a host
   that needs no text in the ledger wraps the sink and drops those columns before delegating, and a tenant
   deletion also updates or deletes the `llm_calls` rows.

4. **Bound, redact, cap, in that order, on every string.** (a) U+0000 and unpaired surrogates are stripped,
   so a secret split by U+0000 is recognised and redacted whole (`buildRecord` does the same for the ledger
   row). (b) A string longer than `maxChars + 256` is cut to that window, and the unbroken token at the cut
   edge is dropped, so the work of every later step is bounded by the cap and a secret cut in half cannot
   survive as a fragment too short to match; such a string ends in `[truncated]`. (c) Core's `redactSecrets`,
   which runs in time linear in the string (bounded key names, no backtracking), and, for tool-call arguments
   and tool-result values, replacement of the value of an object key named like `password`, `secret`, `token`,
   `api_key`, `authorization`, `credential` or `private_key` (any case, as a substring) with `[REDACTED]`. The
   covered credential shapes are listed in the `@gullabs/core` README; they are credentials, not personal data.
   (d) The host's `redact(payload)`, synchronous, on a copy it may change, returning the payload to store.
   (e) The caps, last, so a redactor cannot push stored text over the limit: every string over `maxChars`
   (default 200,000 characters) is cut and ends in `[truncated]`, and the serialized payload is capped at
   `4 x maxChars` by replacing the largest strings, then the largest tool arguments and results, with
   `[dropped: over the payload size cap]` until it fits. (f) U+0000 and unpaired surrogates are stripped again
   (Postgres cannot store them, as in ADR-039, and a host redactor can add them). A payload that still does not
   fit is dropped. A throwing or non-payload-returning `redact`, a throwing `include`, a payload that cannot be
   capped, a payload not built before the sink wait ends and a request that cannot be copied drop the payload
   and log `llm.call.payload.dropped` at `warn` with the `stage`, the error class name and a fixed sentence.
   Raw error text is never logged: a redactor's error can contain the payload. The call is never failed.
5. **Persistence, and what bounds the work.** `UsageSink.record(record, { payload?, logger? })`. The context is
   passed only when there is a payload, and `logger` is the client's, for a sink that recovers from a payload
   problem. The request is snapshotted at dispatch (containers copied, tool arguments and results deep-copied,
   strings and media data shared), and `include` is called then, once per attempt. The payload is built after
   the attempt's outcome is known and inside the bounded sink write: `recordToSink` races the build against the
   `sinkTimeoutMs` timer and the abort and deadline interrupts, and the build checks for abandonment and yields
   to the event loop (the client's scheduler, `setTimeout(0)`) every 4 million characters or bytes of work.
   When the wait ends first, the build stops at its next step, the payload is dropped with a warning and the
   ledger row is still written. Two things are not interruptible: a single synchronous step (one string is at
   most `maxChars + 256` characters of linear work, a 1 MiB hashing chunk) and the host's synchronous `redact`;
   what bounds the total is the pre-redaction cap, not a timer. Media is hashed with `node:crypto` in 1 MiB
   chunks of base64 (about 1 MiB of extra memory per part at a time, not a decoded copy) with a yield between
   chunks.
6. **`drizzleUsageSink({ db, transaction? })`.** BREAKING: the sink took a structurally typed
   `drizzleUsageSink(db, table?)` with only `insert`; that option shape is deleted (no shim, no `table`
   argument, and `assertLlmCallsSchema` / `assertLlmCallPayloadsSchema` lose theirs). `db` is a Drizzle
   Postgres database (`PgDatabase`); one without `transaction()` and without a `transaction` helper is
   `bad_request` at construction, with no fallback. A record **without** a payload is one `INSERT ... ON
CONFLICT (attempt_id) DO NOTHING` on `db`: no transaction, one round trip, and it works on a driver without
   transactions. A record **with** a payload runs in one transaction: the ledger insert, then, behind a
   `SAVEPOINT` named uniquely per write, the payload insert (`ON CONFLICT DO NOTHING`). A payload failure is
   rolled back to the savepoint, logged as `llm.call.payload.failed` (the driver error under Drizzle's query
   error, bounded to 300 characters, because Drizzle's own message carries the statement's parameters, which
   here are customer text) and the transaction commits. A ledger-row failure aborts the transaction, so there
   is no orphan payload, and `record` rejects (`llm.call.sink.failed`). `transaction?` is a host helper
   `(fn) => Promise` that receives the handle, for databases whose standard routes every transaction through its
   own helper; when given it takes over every write. The helper must open a transaction per call; if it hands
   every call the same ambient handle, the sink serializes its writes per handle (a queue keyed by the handle),
   because Drizzle's own nested transaction names every savepoint alike and concurrent writes on one connection
   would roll each other back. A rollback of such a host transaction takes the ledger rows with it. A write the
   engine stopped waiting for keeps its connection until the database finishes it; hosts set
   `idle_in_transaction_session_timeout` and `statement_timeout` for the sink's role.
7. **Schema and SQL.** `llm_call_payloads(attempt_id TEXT PRIMARY KEY REFERENCES llm_calls(attempt_id) ON
DELETE CASCADE, request JSONB NOT NULL, response JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT
now())` with an index on `created_at`; `created_at` is the record's timestamp. `sql/install.sql` creates it;
   `sql/upgrades/0003-llm-call-payloads.sql` adds it to a table at the previous shape. The upgrade is one
   transaction with a transaction-local `lock_timeout`, and it refuses (with an error) to run over a table that
   already has the name unless that table has exactly the four columns with these types, nullability and
   default, the primary key on `attempt_id` and the foreign key to `llm_calls(attempt_id)` with `ON DELETE
CASCADE` under the expected name, so a host's own `llm_call_payloads` is renamed first rather than silently
   adopted. `assertLlmCallPayloadsSchema(db)` is the `assertLlmCallsSchema` counterpart.
8. **Retention and deletion are the host's.** The library never deletes on its own.
   `purgeLlmCallPayloads(db, { olderThan, batchSize? })` deletes payloads older than a cutoff in batches (the
   `created_at` index finds them, the primary key deletes them; 5,000 rows per statement by default, each
   statement returning a count and never the ids) and returns the total; `deleteLlmCallPayloads(db, { callIds })`
   deletes the payloads of the given calls and returns the count (a sparse or non-string list is `bad_request`).
   There is deliberately no delete by `externalId`: it is host-supplied, not unique, and can repeat across
   tenants, so such a helper could delete another tenant's payloads. `callId` is minted by the engine and
   globally unique; a host resolves a tenant's calls through its own scoping and passes the resulting ids.
   Neither helper touches `llm_calls`, so a subject deletion also updates or deletes the ledger rows' text
   columns (decision 3). `llm_call_payloads` has no tenant column: hosts read it through `llm_calls` and write
   row-level security as an `exists` over `llm_calls`. Drizzle's query logger and Postgres statement logging
   record bound parameters, which for a payload insert is the payload.
9. **Testing.** `RecordingSink.payloads` is a `Map` of `attemptId` to payload, and `RecordingSink` declares
   `acceptsPayloads`.

**Consequences:**

- Hosts that call `drizzleUsageSink(db, table)` change to `drizzleUsageSink({ db })`; a custom table object
  is no longer accepted. Their `db` must have `transaction()`. A record without a payload stays a single
  INSERT; only a payload write opens a transaction.
- Hosts with a custom `UsageSink` that wants payloads set `acceptsPayloads: true` and read the second argument.
- Hosts that turn on `payloads` apply `sql/upgrades/0003-llm-call-payloads.sql` first. Without the table every
  payload insert fails, is logged as `llm.call.payload.failed`, and the ledger rows still commit.
- The ledger row now redacts `tool_calls` arguments and `reasoning_text` with core's patterns, and strips
  U+0000 before redacting `error_message`, `reasoning_text` and `provider_options`. The columns themselves are
  unchanged.
- Stored payloads can contain customer data. Core's patterns are best-effort, not DLP: a host that stores
  payloads supplies its own `redact`, a retention job and a tenant deletion path, and a wrapping sink if no text
  may reach `llm_calls`.
- `maxChars` below 1,000, an `async` `redact` / `include`, a sink without `acceptsPayloads` and a `db` without
  `transaction()` are now refused or warned about at construction.
- Node-postgres coverage runs only where a server is available (`ANY_LLM_TEST_POSTGRES_URL`); CI runs the
  same behaviour on PGlite.

---

## ADR-039: Ledger v2: cost confidence and lanes are persisted

**Status:** Accepted (2026-10-03). Extends ADR-027 and ADR-035.

**Context:**
The engine computed `Cost.confidence`, the four-lane `Cost.details` and `Cost.unpricedReason` for every
call, and `buildRecord` dropped all three. A row that priced a call from guessed or missing web-search counters
was indistinguishable in SQL from an exact one, the tool-fee lane could not be separated from token spend,
and the reason a row had no cost lived only in the free-text `warnings` column. The ledger schema also had
no index on `created_at`, no CHECK on its closed `status` and `error_kind` vocabularies, and no cap on
`reasoning_text` / `error_message` although the SPEC said they were truncated. Cost accuracy had four
gaps: Gemini audio was priced at the text rate and marked exact, xAI's own billed total was never compared
with the snapshot, a non-zero xAI tool counter with no rate left the call exact, and `claude-cli` usage
dropped both cache lanes and thinking.

**Decision:**

1. **Record version 2.** `LlmCallRecord.recordSchemaVersion` is `2`. New optional fields:
   `costConfidence` (`'exact' | 'estimated'`, present whenever a `Cost` was computed), `costDetails`
   (`{ input, cached, output, tools }`, present only when priced) and `costUnpricedReason` (present only when
   `costMicroUsd` is `null`). Refusal rows, which have no cost, carry none. `@gullabs/drizzle` adds
   `cost_confidence` (text), `cost_details` (jsonb) and `cost_unpriced_reason` (text). Rows written before
   version 2 keep NULL: their confidence was never stored and is not backfilled.
2. **Schema hygiene.** Indexes `llm_calls_created_at_idx (created_at)` and
   `llm_calls_call_site_created_at_idx (call_site_id, created_at)`. CHECK constraints on `status` and
   `error_kind` (the closed core unions; the Drizzle schema fails to compile if core adds a member, and a new
   member ships with SQL). **No CHECK on `error_reason`** (ADR-036 item 4 stands). The `drizzle-orm` peer
   range is `>=0.36 <1`.
3. **Truncation.** `buildRecord` caps `reasoningText` and `errorMessage` at 16 KiB of UTF-8, marker included,
   cutting on a code point and ending in `…[truncated]`, and adds a warning. `errorMessage` is redacted
   before it is cut. The live result and the thrown error keep the full text.
4. **SQL ships with the schema.** `sql/install.sql` is the fresh table; `sql/upgrades/0002-ledger-v2.sql`
   takes the previously published shape (0.7.2 plus upgrade 0001) forward, is idempotent, validates existing
   rows against the CHECKs, and notes that index builds lock a very large table. The migration test runs both
   on PGlite and proves the upgraded table, indexes and checks equal a fresh install.
5. **Per-attempt and per-call cost.** `Telemetry.onAttempt?(AttemptEvent)` fires once per provider attempt,
   after its row went to the sink, with usage, cost and, on failure, kind, reason and `retryable` (refusal
   rows that never reached an attempt emit none). `LlmResult.callCost?: { microUsd, attempts }` sums every
   attempt's priced amount (retries and billed failures included) and counts attempts that ran; it is absent
   when nothing was priced or any attempt that reported usage was unpriced, because a sum with a hole is not
   reported. `CallErrorEvent` gains `usage` and `cost` of the last failing attempt (when it reported usage)
   and the same `callCost`.
6. **Provider-reported total.** `Cost.providerReported?: { microUsd }` carries the total a provider says it
   billed. For xAI it is `usage.cost_in_usd_ticks` (1 tick = 1e-10 USD) rounded to whole µUSD like each
   priced lane; it is present even when the snapshot cannot price the call. `Cost.microUsd` stays the
   snapshot price; the provider's figure never replaces it. Only totals are compared, because xAI reports no
   lanes. The engine adds a `cost drift` warning when the totals differ by more than 1 µUSD per priced
   (non-zero) lane, minimum 1: the snapshot is stale or a billed lane is missing. (The audit proposed 2 µUSD
   per lane; with whole-µUSD rounding on both sides, 1 per lane is the bound.)
7. **Fail closed on unpriced xAI tools.** A non-zero `*_calls` counter that is neither `web_search_calls`
   nor the superseded `x_search_calls` makes the call `'estimated'` and the adapter warns. The priority tier
   with a warm cache is pinned by fixture `35-priority-warm-cache.json` (live probe, 2026-10-03; all three
   models reconcile to billed ticks, the cached lane at 2x its standard rate); fixture 33's five usages are
   reconciled to ticks, which also pins that the long-context band applies to the summed agentic input.
8. **Gemini input is priced per modality where the page does.** Gemini 2.5 Flash, 2.5 Flash-Lite and 3.1
   Flash-Lite publish a separate audio input and cached-audio rate (standard and flex); every other model
   lists one rate for all modalities. The adapter records `promptTokensDetails` / `cacheTokensDetails` as
   `details.input_<modality>` / `cached_<modality>`; the pricing source bills audio tokens at the audio
   rates and the rest at the text rate. When audio was sent and the response reports no audio tokens, or
   cached tokens sit beside audio with no cached split, the cost is `'estimated'`. Rates are from
   https://ai.google.dev/gemini-api/docs/pricing, read 2026-10-03 (page last updated 2026-10-01); the
   earlier statement that per-modality lanes are unneeded (SPEC) and the "deferred seam" comment
   (`pricing.ts`) are both removed.
9. **No batch tier.** The Batch API has no path in this library and no schema admits a batch tier, so the
   unreachable `batch` rates are deleted from the snapshot; `'batch'` is an unpriced tier.
   `GoogleCacheHandle.totalTokenCount` returns the create response's `usageMetadata.totalTokenCount` so a host
   can price cache storage (per token-hour).
10. **claude-cli usage follows Anthropic's accounting.** `input_tokens` excludes both cache lanes, so
    `inputTokens = input + cache_read + cache_creation`, `cachedInputTokens = cache_read`,
    `details.cacheWrite = cache_creation`, `thinkingTokens = output_tokens_details.thinking_tokens`. The
    adapter stays unpriced.
11. **xAI response metadata.** The built-in client reads the response through the SDK's `.withResponse()`
    and reports `x-request-id` and the remaining-quota headers (`x-ratelimit-remaining-*`,
    `ratelimit-remaining*`) to the adapter, which puts `requestId` and `rateLimitRemaining` on
    `providerMetadata.xai`. Headers of a failed call are not captured. No capture of xAI's real
    rate-limit header names exists in the evidence, so the header match is by prefix and the values are kept
    verbatim; the names are not asserted against a live response.

**Consequences:**

- Hosts using `@gullabs/drizzle` apply `sql/upgrades/0002-ledger-v2.sql` before deploying this version; the
  sink writes every column, so without it every insert fails (logged as `llm.call.sink.failed`;
  `assertLlmCallsSchema` detects it).
- Hosts that wrote their own sink or table add the three cost columns (all optional) and read
  `recordSchemaVersion: 2`.
- Dashboards can separate tool fees from token spend and exact from estimated spend in SQL.
- `Telemetry` implementers may add `onAttempt`; no existing hook changes meaning.
- A host that switched on the three-member `GEMINI_PRICED_TIERS` loses `'batch'`.

### Amendment A (2026-10-03): R7 audit fixes

An adversarial audit of ADR-039's implementation found four P2 and nine P3 defects. This amendment
supersedes the items below where they differ. Numbering follows the ADR's items.

**Item 7 (xAI tool counters).** The `*_calls` suffix rule is replaced by an explicit table,
`XAI_SERVER_TOOL_COUNTERS` (`packages/xai/src/pricing.ts`), over the members of
`usage.server_side_tool_usage_details`: `priced` (`web_search_calls`, `x_posts_fetched`,
`x_users_fetched`), `superseded` (`x_search_calls`), `fee_unpriced` (`code_interpreter_calls`,
`file_search_calls`, `document_search_calls`, `image_generation_calls`: xAI charges per use and the
snapshot has no rate) and `token_only` (`mcp_calls`). A non-zero `fee_unpriced` or unknown counter makes
the call `estimated` with a warning; a `token_only` counter does not, because the tokens already priced
are the whole cost. The sources are xAI's pricing page (https://docs.x.ai/developers/pricing, read
2026-10-03, no date on the page): code execution $5/1k calls, file attachments $5/1k, collections search
$2.50/1k, image generation at Imagine API rates, and Remote MCP, image understanding and X video
understanding token-only. The last two are not in the table because no counter for them has been
captured (xAI's tools docs name `SERVER_SIDE_TOOL_VIEW_IMAGE` in another usage field). Unknown counters are
found in the nested counters object, because `usage.details` also flattens unrelated numeric usage fields.
No fixture has a non-zero MCP counter; the tests for it are synthetic and say so.

**Item 4 (migration 0002).** The upgrade is hardened for a table that cannot be locked for a scan:

- It starts with `SET lock_timeout = '3s'` (reset at the end), so a statement that cannot get its lock fails
  instead of queueing behind an analytics query and blocking every sink insert behind it. The sink is
  fail-open, so a stalled migration would otherwise drop billed rows.
- The `status` / `error_kind` CHECKs are added `NOT VALID`, guarded by a `pg_catalog.pg_constraint` check in a
  `DO` block: new and updated rows are enforced at once, no table scan runs under ACCESS EXCLUSIVE, and a
  re-run neither drops nor re-adds a constraint. Every statement in the file is idempotent on its own, so a
  run that stops partway is finished by running the file again, in one transaction or statement by statement
  (the previous drop-and-add left a window with no constraint and re-scanned the table on each run).
- Validation is a separate file, `sql/upgrades/0002-validate-checks.sql` (`VALIDATE CONSTRAINT`, SHARE UPDATE
  EXCLUSIVE, writes continue). Rows that `@gullabs/core` 0.2.0 wrote (`status` and `error_kind` =
  `parse_error`; no later release wrote a value outside the vocabularies) make validation fail. The file
  documents the query that finds them and one suggested `UPDATE` that keeps the original values in
  `metadata`. The library never rewrites history; the constraints may stay `NOT VALID` indefinitely.
- Index creation keeps plain `CREATE INDEX IF NOT EXISTS` (SHARE lock for the build) and documents the
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS` alternative for large tables, which cannot run in a transaction,
  and how to find and drop an INVALID index a failed concurrent build leaves.
- Migration tests compare column, index (`pg_get_indexdef`) and CHECK (`pg_get_constraintdef`) definitions of
  the upgraded table with a fresh install, and `schema.ts` with `install.sql`, instead of names; they run the
  file statement by statement twice, with violating rows present. The `drizzle-orm` peer floor (0.36) is
  declared and not tested (only the dev-dependency version can be installed).

**Item 5 (`callCost`).** The shape is `{ microUsd, attempts, unpricedAttempts }` (exported as `CallCost`).
`microUsd` sums only the attempts that were priced. `unpricedAttempts` counts attempts that were dispatched
but have no priced usage: a timeout, abort or connection failure that reported no usage, usage the pricing
source could not price, and an attempt still in flight when a deadline ended the call. The provider may have
billed them, so `unpricedAttempts > 0` means `microUsd` is a lower bound. The previous rule, which dropped
`callCost` when an attempt reported usage that could not be priced, reported two timeouts followed by a
success as the success alone, presented as complete. Attempts known to cost nothing are not counted: one that
ended before dispatch (waiting on the rate limiter), kinds providers do not bill (`bad_request`,
`invalid_auth`, `rate_limited`), and any other HTTP error answer that is not a timeout or abort. `callCost` is
present whenever an attempt ran (absent only for a refusal before any attempt), so a call whose attempts were
all unpriced reports `{ microUsd: 0, attempts, unpricedAttempts }`. It is added to `CallSuccessEvent`
(an `onSuccess`-only metrics hook could not read it) as well as `CallErrorEvent` and `LlmResult`. The ledger
statement that the SQL sum equals `callCost` now holds as stated: `SUM(cost_micro_usd)` over the call's rows
equals `microUsd`, NULL rows being the unpriced attempts.

**Item 8 (Gemini audio confidence).** Four corrections to when an audio-priced call is `'estimated'`:

- A request with audio and a response that reports `{ AUDIO, 0 }` is estimated, exactly like an absent AUDIO
  entry (audio always has tokens, so a zero is the same missing information). The adapter's warning and the
  pricing source read one predicate (`audioTokensReported`), and the modality is compared after
  `mapUsage` lower-cases it (the warning compared the upper-case spelling).
- Cached tokens beside new audio are exact when the cached part is provably audio-free: a
  `cacheTokensDetails` that lists no audio and whose entries sum to at least `cachedContentTokenCount` makes
  the adapter record `details.cached_audio = 0`. A listing that covers fewer tokens than were cached leaves
  the remainder unknown (estimated), as before. Previously every audio call with a text cache was estimated
  although its amount was right.
- Audio inside a `cachedContent` is invisible to the request (the adapter sees only the cache name), so the
  `audio_input_requested` marker cannot cover it. The response decides instead: on a model with an audio rate,
  cached tokens with neither `promptTokensDetails` nor `cacheTokensDetails` make the call estimated and warn,
  because the cached text rate would understate a cache that holds audio. A response that splits the
  prompt and shows no audio proves the cache holds none and stays exact. No capture with cached tokens
  exists in the evidence; the rule is fail-closed on a split Google documents as optional.

**Postgres-safe text and the drift tolerance.** `buildRecord` removes U+0000 and replaces each unpaired
surrogate with U+FFFD in every string and object key of the record, once, last (redaction and the byte cap
see the original text), and adds a warning when it changed anything. Postgres `text` cannot hold U+0000 and
`jsonb` rejects both it and an unpaired surrogate (which `JSON.stringify` writes as an escape), so such a
string used to fail the insert and the fail-open sink dropped the billed row. The cleaning is copy-on-write,
so a clean record aliases its inputs as before and the caller's data is never mutated. The drift tolerance
(item 6) counts the lanes that can carry rounding, 1 µUSD each, minimum 1: a lane with a non-zero amount or
tokens for it (billable input, cached input, output), not only lanes whose rounded amount is non-zero. A lane
that rounds to 0 can still hold up to 0.5 µUSD, so four sub-µUSD lanes and a rounded provider total could
differ by 2 against a tolerance of 1 and raise a false drift warning.

**Item 11 (xAI response headers).** The claim that no capture of xAI's real header names exists was wrong:
fixtures 02, 12 and 16 to 23 store the `headers` of real responses. They carry `x-request-id`,
`x-ratelimit-remaining-requests` and `x-ratelimit-remaining-tokens` (and the `x-ratelimit-limit-*` ceilings,
which are not kept). A test reads every such fixture through `readXaiResponseMeta` and pins the request id
and exactly the remaining headers. The `ratelimit-remaining*` prefix, which no capture has, is removed from the match. A failed call has no `providerMetadata`, and `LlmError` has no request
id field; the id of a failed call is `error.cause.requestID` (the SDK error keeps the response headers),
which a stubbed-500 test pins. No new field is added.

---

## ADR-040: xAI adapter streams internally

**Status:** Accepted (2026-10-03). Amends ADR-032 (the transport and the SDK deadline) and ADR-036 (deletes
`search_budget_exceeded`). Amended by Amendment A below (failure handling, usage estimates, the idle timer,
real event captures), which supersedes decisions 2 (the failing disagreement), 3 (retry and usage of a
failed stream) and 4 (no idle timer).

**Context:**
A non-streamed xAI call sends nothing until the answer is complete, so a reasoning or agentic call waits
past Node's 300 s header timer (ADR-032). Streaming keeps the connection busy. Live probes on 2026-10-03
(fixture `36-streamed-responses.json`, real xAI, Node's default `fetch`, no custom undici `Agent`):

- **P12.** Five streamed reasoning runs of 999 to 1,705 s (grok-4.5 high, grok-4.6 xhigh x3, grok-4.7
  xhigh) all completed with `response.completed`, first event in about 2 s, and a **maximum gap between
  events of 15.0 s** (5% of the 300 s body timer). No `error` or `response.failed` event.
- **P12b.** A streamed grok-4.6 xhigh call with 20 `web_search` calls ended at 99 s (max gap 15 s).
- **P9a.** The streamed `response.completed` carries the same `usage` keys, `cost_in_usd_ticks` and
  `server_side_tool_usage_details` as the non-streamed object, and the ticks reconcile with
  `computeXaiCost` within rounding on all 8 responses. **But the streamed final object lacked the
  `reasoning` item in 2 of 2 search runs** (`[web_search_call, message]` against the non-streamed
  `[web_search_call, reasoning, message]`), and the stream announced no reasoning item either.
- **P9b** (does xAI stop billing an aborted stream) **could not be tested**: no console billing access.

**Decision:**

1. **`run()` always streams.** The real client (`buildXaiClient`) sends `stream: true` with
   `Accept: text/event-stream` and reads the events to the terminal one. There is no non-streamed path
   and no flag. `XaiClientLike.responses.create` still resolves to one response object, so fakes
   (`@gullabs/testing`) and the adapter's mapping are unchanged. A public `stream()` stays on the ROADMAP;
   the streaming is internal to `run()`.
2. **The output item list is rebuilt from the events and reconciled with the final object.** The final
   `output` is what the assistant message, citations, annotations and the `'state'` continuation
   (ADR-029: the provider's own output items, encrypted reasoning included) are built from, and P9a showed
   it can be incomplete. `XaiStreamReducer` folds `response.output_item.added/done`, content-part, text,
   annotation, reasoning-summary and function-argument events into items, then:
   - matches items by `id` **and occurrence**: live fixtures carry two `message` items with one `msg_` id
     and two `reasoning` items with one `rs_` id, so an id alone is not a key; an item without an id is
     matched to the same type's n-th id-less item;
   - treats the final object as authoritative for an item it carries, fills a field it lacks from the
     completed (`done`) event, and keeps the final's value, with a warning naming the field, when both carry
     different values;
   - inserts an item the stream completed and the final object lacks at its `output_index`;
   - assembles an item the stream never completed and the final object lacks from the deltas, marks it
     finished (`incomplete` when the response is), and says so in a warning (a replayed `in_progress` item
     would not be valid);
   - ~~fails with `server`, `retryable: true` when events and final object disagree~~ **Superseded by
     Amendment A:** reconciliation never fails a call once the final event carries a response object. A
     delta for an item the stream never opened is ignored: a lost delta must not fail a billed call.
     The warnings are `{ type: 'other' }` entries on the result; a stream whose events and final object agree
     adds none. What the stream never announced cannot be rebuilt: when xAI emits no reasoning item at all
     (the P9a shape), the state replays without it; the library does not warn, because billed reasoning
     with no reasoning item is not by itself a stream artifact.
3. **Terminal and error events map as the non-streamed path does (R4).** `response.completed` and
   `response.incomplete` go through the mapping unchanged (`incomplete` + `max_output_tokens` is
   `finishReason: 'length'`). `response.failed` becomes a response with `status: 'failed'` and goes through
   the failed-response rule (the `error.code` table, billed usage attached). An `error` event or `event:
error` frame goes through the same `error.code` table: `server_error` and `rate_limit_exceeded` are
   retryable, policy codes are `content_filter`, prompt and image codes are `bad_request`, anything else
   is `unknown` and not retryable. A stream that ends without a terminal event, or whose body is not
   valid event JSON, is `server`; **Amendment A** makes it retryable only while no output event arrived,
   and replaces the snapshot usage by a lower-bound estimate after output began. An attempt with no usage
   is unpriced (ADR-039, `callCost.unpricedAttempts`), never zero.
4. **Deadlines and aborts.** The adapter still computes `timeoutMs + 5 000`, or one hour (ADR-032). The
   openai SDK `timeout` covers a stream only until the response headers arrive, so the client applies the
   same deadline to the rest of the stream with its own timer: a stream that outlives it ends as
   `kind: 'timeout'`, `retryable: false`, `reason: 'transport_timeout'` (the retry reaches the same limit
   and repeats the spend). ~~There is no idle timer~~ (Amendment A adds the optional `idleTimeoutMs`); a
   stream that keeps sending is cut at the deadline too.
   The SDK ends a stream quietly when its request is aborted, so the client checks the caller's signal
   afterwards and throws the abort (an `LlmError` abort reason, the engine's deadline, reaches the caller
   unchanged). A transport failure or Node's body timer mid-stream classifies as before (ADR-032).
5. **The transport.** P12 shows streaming removes the need for the ADR-032 undici transport for **long
   reasoning calls**: the connection was never quiet for more than 15 s. **A tool-using call that itself
   runs past 300 s was not tested**: the longest tool run (P12b) ended at 99 s. A host with tool-using
   calls expected to run past 300 s without any streamed event should keep the transport. The `transport`
   option stays for proxies, mTLS, egress policy and custom `fetch`, and still carries `countTokens`.
6. **No in-flight search-budget enforcement.** P9b could not be run, so there is no evidence that aborting
   a stream stops xAI's search loop or its billing; an abort that saves nothing would only lose the
   result. The observed-after-the-call `searchBudget` (ADR-030 amendment) stays the only budget control.
   `LlmErrorReason` loses `'search_budget_exceeded'` (ADR-036): nothing emits it, and the closed union holds
   only members that are emitted. In-flight abort is a BACKLOG item that needs P9b first.

**Deliberately not built:** a public `stream()`; in-flight search-budget abort; an idle-gap timer; a
non-streamed fallback or a flag to choose; a library-owned undici agent; rebuilding an item the stream
never announced.

**Consequences:**

- A host with reasoning-only xAI calls can drop the undici transport. A host with tool-using calls that
  can run past 300 s without streamed events keeps it.
- `XaiResponseMeta.streamNotes` carries what reconciliation did; the adapter reports each note as a
  warning.
- `countTokens` is untouched (`POST /v1/tokenize-text`, not a stream).
- **Evidence and what is synthetic (ADR-013).** The probes kept event-type counts, usage, output item
  types and timings, not event bodies. The real P9a usage objects and event types are pinned in
  `36-streamed-responses.json`. The event sequences in the tests are synthesised from the recorded
  non-streamed fixtures with the OpenAI Responses streaming grammar (`test-sse.ts`) and labelled synthetic;
  a test pins the synthetic event types to the real ones. **Amendment A pins real event bodies** (fixture
  `37-streamed-events.json`) and the field-level equality of a streamed `done` item with the final
  object's. Not tested against a live stream: any stream longer than 300 s that runs server tools.
- Re-probe when xAI changes streaming: P9b (aborted-stream billing), a tool run past 300 s, and whether
  the streamed final object keeps its reasoning item.

### Amendment A (2026-10-03): failures, estimates, the idle timer and real captures

An adversarial audit of the first implementation (every point reproduced against the real `openai` SDK
with a stubbed `fetch`) and a live run of every streamed path through the built adapter (2026-10-03,
about US$0.46 over two passes; fixture `37-streamed-events.json`, raw event text; the second pass reran
every feature class through the rebuilt client of this amendment, plus an idle timer that tripped and one
that did not) changed seven rules.

**What the live bodies showed** (the earlier probes kept event types only). Every item event and delta
carries an integer `output_index`. `output_item.done` equals the final object's item field for field, except
a `web_search_call`: the final object reports `action.sources` cumulatively for the whole run on every
search call. A function call streams its whole argument string in one `function_call_arguments.delta`; an
X search streams as a `custom_tool_call` with `custom_tool_call_input.delta/.done`. `response.incomplete`
(`max_output_tokens`) arrives with no `*.done` event at all. The snapshots carry `usage: null`. A strict
schema came back as one message item. The `'state'` replay built from a real stream is, field for field, the
input of the request xAI accepted. Nothing broke (no P0), but the first implementation warned about a
disagreement on every web search because of the cumulative `sources`.

1. **Reconciliation is enrichment, never a gate.** Once the terminal event carries a response object the
   call is billed and answered. A type disagreement keeps the final object's item (warning); an event with
   no integer `output_index` or typed item is skipped (warning); a final `output` that is not an array of
   objects is replaced by the items the events built (warning); a frame with no `data`, `[DONE]` and a typeless
   JSON frame are skipped. A divergence is reported only for the item types the adapter reads (`message`,
   `reasoning`, `function_call`): server-tool items replay verbatim from the final object. Items are matched
   by id and occurrence, aligned from the start or the end of a group, whichever pairs more identical
   items; an unmatched item whose content (ignoring id and status) equals an unmatched final item is that item,
   not a second one. `response.incomplete` is incomplete whatever its response object says, as
   `response.failed` is failed. The only malformed shapes that fail a call are a terminal event without a
   response object and a body that is not JSON.
2. **A stream that fails after output began is not retried.** Retry is safe only while nothing was
   generated: a reasoning call burns tokens before its first visible event, a retry repeats spend that
   cannot be resumed, and whether xAI bills a cut call is unknown (P9b); this is ADR-032's reasoning for
   timeouts. Before the first output event (or an HTTP status error, or a connect failure) a failure stays
   retryable and unpriced. After it, a cut connection, an early end, a malformed body and an `error` event
   are `retryable: false` with the transport error as `cause`; Node's own timers keep `kind: 'timeout'`.
   A mid-stream `rate_limit_exceeded` is never retried, and `server_error` only before output.
3. **Usage of a failed stream is an estimate, never exact.** After the terminal event it is the terminal
   usage (exact, ticks included). After output began, before it, the error carries a lower bound: request
   length over 4 for input (core's `estimateInputTokens`), received characters over 4 for output, marked
   `usage.details.usage_estimated = 1`, which the xAI pricing source reports as `confidence: 'estimated'`.
   No `cost_in_usd_ticks` is attached and snapshot usage is never used. It understates (hidden reasoning,
   the provider's prompt overhead and tool fees are not counted); a failure before output has no usage and
   stays an unpriced attempt.
4. **A mid-stream `error` event is never known-free.** `LlmError.mayHaveBilled` (core, additive) says the
   provider had started work; `failedAttemptCostsNothing` returns false for it whatever the kind, so
   `rate_limited` and `bad_request` events count as an unpriced attempt (an HTTP 429 or 400 still does not).
   The audit's alternative, a check on the cause's type, would have put an xAI class in core.
5. **`transport.idleTimeoutMs`** (optional, off by default): bytes of any kind, heartbeat comments included,
   reset it; silence for that long ends the stream as a non-retryable `timeout`, `reason: 'transport_timeout'`.
   The client reads the response body itself (`asResponse()` plus a small SSE reader, `sse.ts`) because the
   SDK's iterator hides comments from any idle timer and throws a `SyntaxError` on a bare `event:` frame.
   The SDK still sends the request and turns an HTTP error status into its `APIError`. The advice to raise
   undici's `bodyTimeout` and `headersTimeout` to the whole deadline is withdrawn: while events flow the
   body timer is moot and a stream sends headers at once, so raising them only removed a tool-using host's
   protection against a half-open connection.
6. **`transport.fetch` must return the request's `text/event-stream` response.** A `Response` whose
   content type is anything else (a record/replay or caching wrapper that buffers the answer) fails
   non-retryably as `bad_request` naming the cause, and is booked as possibly billed.
7. **A terminal response without token counts** is a typed non-retryable `server` error naming the response
   id (it was a `TypeError`). Any other failure to map a complete response (a shape this version did not
   expect) is the same kind of error and carries the response's exact usage, ticks included.

`makeFakeXai` still replaces `responses.create`, below which the stream lives, so a test through `{ client }`
does not exercise the reducer or the timers: `@gullabs/testing` has no dependency on `@gullabs/xai` to
build a stream, and a fake that reimplements the SSE path would be a second implementation. A parity test pins
that a streamed run of the same response gives the same result; a streaming failure is tested by stubbing
`transport.fetch` with a `text/event-stream` body (documented in the package README).

**Not built:** resuming a cut stream (nothing is resumable: `store: false`); billing a cut stream as free or
as exact; a public `stream()`.

**Evidence.** Real: the 10 raw streams of fixture 37 (event bodies, one per feature class), asserted
through the reducer, the real SDK and the adapter, including the request body and `'state'` replay. Still
synthetic: error events, cuts and the idle case (injected through a stubbed `fetch`). Not measured: a tool
call past 300 s, billing of a cut or aborted stream (P9b), and an `error` event's real shape.

---

## ADR-041: Quota windows, token pacing, the scheduler port and the test package

**Status:** Accepted (2026-10-03). Extends ADR-008 and ADR-036.

**Context:**
`@gullabs/quota` limited requests per minute and per UTC day only. Google resets its daily request quota at
midnight Pacific time, so a UTC bucket was offset by 7 or 8 hours from the provider's window. Both Gemini and
xAI enforce input tokens per minute, which the library could not pace, and the `RateLimiter` port carried no
token estimate and got no usage back. The only store was Upstash, so a single-node host or any test suite
hand-wrote a store, and the middleware refused to run without one. A slow store call was unbounded: the
engine starts the attempt timer only after middleware returns, so a hung store held a call past its
`timeoutMs`. `@gullabs/testing` could not reproduce failures (no error factories, timers on real time, a
sink that did not dedupe like the ledger, a `FakeAdapter` that turned a mistyped result into a thrown value).

**Decision:**

1. **The day boundary is a time zone.** `ProviderQuotaRule.dayBoundary?: { timeZone }` (an IANA name,
   resolved with `Intl.DateTimeFormat`, no dependency). Both stores key the per-day counter by the local date
   and the zone name, and set its TTL to the time until the next local midnight. The boundary is found by
   searching for the first instant whose local date is later, so it is right on 23- and 25-hour days and in a
   zone whose DST change skips midnight; it is never `now + 24h`. An unknown zone is `bad_request`. Without a
   boundary the day is the UTC day, as before.
2. **Gemini's default is Pacific time, and the source is cited.** `quotaPolicyForGemini` sets
   `dayBoundary: { timeZone: 'America/Los_Angeles' }`. Google's rate-limits page,
   https://ai.google.dev/gemini-api/docs/rate-limits, re-read on 2026-10-03, states that requests-per-day
   (RPD) quotas reset at midnight Pacific time, that limits apply per project and not per API key, and names
   three dimensions (RPM, input TPM, RPD). It gives no per-model numbers. This closes the audit's Q-02.
3. **`quotaPolicy` is the builder; the presets sit on it.** `quotaPolicy({ provider, models, defaults,
dayBoundary?, scope? })`; `quotaPolicyForGemini` and `quotaPolicyForXai` call it (their `defaultLimits`
   option is now `defaults`, one name). The xAI preset carries **no numbers**: xAI's rate-limits page,
   https://docs.x.ai/developers/rate-limits, re-read on 2026-10-03, publishes limits per tier and model, but a
   team's tier follows its cumulative spend and changes automatically, so the host passes its own
   (`rpm`, `tpm`). xAI states requests per second and tokens per minute and documents no daily limit, so the
   preset has no `rpd` and no boundary.
4. **Tokens per minute, estimated and reconciled.** `ProviderQuotaRule.tpm` (a positive integer).
   `RateLimiter.acquire(key, signal, hint?: { estimatedInputTokens? })` and `Release = (usage?: Usage) =>
void` (ADR-008's port, widened). The engine hands `acquire` `estimateInputTokens(effectiveReq)` on every
   attempt and calls `Release` with the attempt's normalized usage when there is one (a success, a billed
   failure) and with none otherwise. `estimateInputTokens` is exported from core: the characters of system,
   text parts, tool calls, tool results, tool declarations and the output schema over 4, rounded up. It is a floor for a
   request with media or file parts (they carry no text) and exists to pace, never to bill or refuse, so the
   real usage corrects it. The store reserves the estimate in the minute's counter under the same atomic
   check-and-consume as the request windows (R1.5 semantics unchanged: a denied call consumes nothing; one
   call larger than the whole window passes into an empty window rather than waiting for a window it can
   never fit) and `QuotaStore.adjustTokens({ scope, nowMs, tokens })` adds `actual - reserved` to the
   acquire minute's counter, floored at 0, leaving a window that has ended alone. An attempt that ends
   with no usage keeps its reservation (the provider may have counted it). A reconciliation failure is a
   `backend_error` event, never a call failure, and the correction is started without being awaited
   (Amendment A). `adjustTokens` is required on `QuotaStore` (greenfield: a store that enforces no `tpm`
   implements it as a no-op).
5. **`inMemoryQuotaStore({ clock })`.** The same windows and rule in a `Map`. The clock is the store's own
   time source for counter expiry, as a Redis server's clock is, while the window a call falls in is named by
   the `nowMs` the caller passes; tests pass the client's `FakeClock`.
6. **The middleware runs without a store.** `providerQuotaMiddleware` with no `store` still evaluates
   rules: `rpd: 0` denies with `provider_disabled` and a `deny` event. Windows cannot be checked and are
   skipped with one `warn` (`llm.quota.windows_skipped`) per instance and scope. The consume-only-on-allow
   semantics, the role-order rule (quota inside retry) and `maxDeferMs` (60 s default) are unchanged.
7. **Store failure is a stated choice, and a store call is bounded.** `onStoreError: 'fail-open' |
'fail-closed'` has no default on the middleware, the rate limiter and `enforceProviderQuota` when they have
   a store (missing or unknown is `bad_request`). A caller abort or deadline that interrupts the store call
   is never fail-open. `upstashQuotaStore({ url, token, timeoutMs? })` bounds each call (default 2 000 ms),
   passes the caller's signal, and takes a `scheduler` for the timer. The Lua check takes
   `(limit, ttl, cost)` per window and `INCRBY`; a second script corrects a token counter. Found in a host
   sign-off on 2026-10-03: a hung store call was unbounded.
8. **A `Scheduler` port.** `ClientConfig.scheduler?: { setTimeout, clearTimeout }`, default the platform's
   timers, runs every wait the engine owns (the attempt timeout, the logical-call deadline, the sink waits).
   It is on `EngineCtx.scheduler`, which `retryMiddleware`'s default sleep uses (its `sleep` option remains
   a way to observe delays), and on `AdapterCtx.scheduler`, which `FakeAdapter` and `SignalAwareFakeAdapter`
   delays use. `FakeClock` implements both `Clock` and `Scheduler`; `advance` fires due timers in order and
   `advanceAsync` lets promise continuations run between them. The deadline stays measured on the
   `clock` (ADR-036: the engine owns the call deadline, `ctx.deadlineAt` is on `ctx.clock`, and
   `retryMiddleware` reads `ctx.clock.now` and has no separate `now` option), and the scheduler
   enforces it, so a scheduler on a different time scale than the clock is a misconfiguration.
9. **`@gullabs/testing` reproduces failures.** Error factories (`fakeHttpError`, `fakeNetworkError`,
   `fakeBilledFailure`, `fakeProviderError('google' | 'xai', scenario)`): the provider scenarios build the
   real `@google/genai` `ApiError` and `openai` `APIError.generate(...)` from the bodies pinned in the
   provider packages' fixtures (copied into the package, with a test that fails if a copy drifts; the
   captured and doc-derived scenarios are listed on the types and in the README, ADR-013). The SDKs are
   optional peer dependencies loaded with `require`, so the class is the SDK's CommonJS build. Also
   `RecordingSink({ dedupeOn: 'attemptId' })`, `RecordingTelemetry`, `RecordingLogger`, `fakeLlmResult`,
   `FakeClient` (request capture, `expectRequest`), `FakeGoogleFileStore`, `FakeGoogleCacheStore`,
   `FakeCliRunner`. `FakeAdapter` and `SignalAwareFakeAdapter` throw `TypeError` at construction for an
   entry that is neither an `Error` nor a complete `AdapterResult`; a plain `{ status: 429 }` is no longer
   thrown as an error. What a factory error becomes in a whole-adapter fake is Amendment A.

**Consequences:**

- Hosts that build a quota middleware, rate limiter or `enforceProviderQuota` call with a store add
  `onStoreError`. Hosts with their own `QuotaStore` add `adjustTokens`. `defaultLimits` is `defaults`.
- A host that implements `RateLimiter` ignores the new `hint` and `usage` arguments to keep its behaviour.
  A host `EngineCtx` literal (a middleware unit test) adds `scheduler`.
- Gemini RPD buckets move from the UTC day to the Pacific day: counters keyed the old way are not reused.
- Test suites replace `{ status: 429 }` entries with `fakeHttpError(429)` and drive time with one
  `FakeClock` passed as both `clock` and `scheduler`.
- A request with media is under-estimated for `tpm`; the reconciliation corrects the counter after the call,
  not before it.

### Amendment A (audit of R8, 2026-10-03)

An adversarial audit of this decision's implementation found five behaviours that contradicted the
intent. Each is fixed; the contract is now:

1. **A fail-closed store outage is a quota-store failure, not a provider failure.** Every store failure
   under `onStoreError: 'fail-closed'` (a timeout, an HTTP failure, a transport failure, a malformed reply,
   a store that throws its own `rate_limited`) is one `LlmError`: `kind: 'server'`, `retryable: false`,
   `reason: 'quota_store_unavailable'`, the store's error as `cause`. `quota_store_unavailable` is a new
   member of the closed `LlmErrorReason` union (ADR-036 item 2: a new member is a core minor; hosts keep a
   `default` branch). It is not retryable on purpose: the audit reproduced a store timeout classified
   `timeout` by message text, retried three times (three store calls, 6 s, load on an already degraded
   store) and written to the ledger as a provider timeout for a call that never reached the provider. Now
   there is one store call per dispatch and one refusal row (`server` / `quota_store_unavailable`). `server`
   is otherwise retryable; this is the one non-retryable exception, kept by `retryable: false`, which stays
   authoritative. A caller abort or deadline that interrupts the store call is still the abort or the
   timeout, never a store failure, and never fail-open. A `backend_error` event is emitted once per failed
   call.
2. **Reconciliation never delays or masks a call.** `providerQuotaMiddleware` starts `adjustTokens` when the
   attempt ends and does not await it (as `providerQuotaRateLimiter`'s `Release` already did), on a result
   and on an error alike. It is at-most-once: a process that ends first loses the correction and the
   reservation stays, which over-counts until the minute ends (the safe side). `Release` and
   `QuotaAdmission.reconcile` correct once however often they are called. A failure is the `backend_error`
   event plus an `llm.quota.reconcile_failed` warning. The store bounds its own call
   (`upstashQuotaStore`'s `timeoutMs`); a custom store must too.
3. **The shipped Lua runs on a real interpreter in CI.** The CI quality job installs `lua5.4` and sets
   `REQUIRE_LUA=1`; with it set a missing interpreter fails the run, otherwise the real-Lua tests skip
   locally. They cover both scripts and the Upstash store end to end (rpm, a time-zone rpd, tpm, the
   adjust script). Redis embeds Lua 5.1 and the shim is not Redis; that stays a stated limitation.
4. **`0` means disabled for every window.** `rpm: 0`, `rpd: 0` and `tpm: 0` all deny with
   `provider_disabled`, with or without a store; a negative or fractional limit is `bad_request`. (Before,
   `rpm: 0` meant unlimited and `tpm: 0` was `bad_request`.) The policy builders reject an unknown option or
   limit key (`defaultLimits`, a misspelt `rpmm`, `rpd` on the xAI preset) instead of dropping it.
   `onStoreError` is validated when the middleware or limiter is built.
5. **Day counters are keyed by the canonical zone.** `US/Pacific` and `America/Los_Angeles` share a counter,
   and UTC spelled any way is the same window as no boundary. The skipped-windows warning's message is the
   event name `llm.quota.windows_skipped` (fields `callId`, `provider`, `model`, `scope`) once per scope.
   `estimateInputTokens` now counts the output schema. `upstashQuotaStore` releases the timer and listener
   when a custom `invoke` throws synchronously and cancels the body of a non-OK response.

**The test package.** A provider-shaped error thrown by a whole-adapter fake behaves as the real adapter's
does. `fakeProviderError` still returns the raw SDK error (the SDK-level fakes hand it to the real adapter,
which classifies it) and marks it; `FakeAdapter`, `SignalAwareFakeAdapter` and `FakeClient` run a marked error
through `classifyGoogleError` / `classifyXaiError` (loaded from `@gullabs/google` / `@gullabs/xai`, now
optional exact-version peer dependencies of `@gullabs/testing`; `classifyGoogleError` and
`GEMINI_INPUT_MIME_TYPES` are exported from `@gullabs/google` for this) before throwing, so a per-day quota
stops a retry loop, exhausted xAI credits are `credits_exhausted`, a bad Gemini key is `invalid_auth`, and
the error is an `LlmError` of the host's copy of core (fields carried over when the classifier came from the
other module format). Tests run the same scenario through a `FakeAdapter` and through the real adapter
over `makeFakeGemini` / `makeFakeXai` and require identical results. `FakeClient` rejects only with
`LlmError`: it classifies an `Error` entry with core's `classifyError`. Smaller: `FakeClock`'s methods work
detached (`Clock.now` and `Scheduler.*` are `this: void`) and `advance` rejects `NaN`, infinite and negative
amounts and is re-entrant; concurrent delayed `FakeAdapter` calls each take their own entry;
`FakeGoogleFileStore` applies the shared media-type admission and `failUpload`, `FakeGoogleCacheStore` takes
`failCreate`, `preflight` and `coalesce`; `fakeLlmResult` is unpriced by default and numbers its ids;
`fakeProviderError('xai', ...)` takes response `headers`; `fakeNetworkError` names the syscall and errno of
its code. `GoogleFileStore` takes a `scheduler` for the poll wait and the Gemini flex/standard client-side
ceiling runs on `ctx.scheduler`, so a `FakeClock` fires both (a CLI runner's process timers are not on the
port). The packed-install check imports `@gullabs/testing` and runs a fake call and a classified provider
error in ESM and CommonJS under pnpm and npm.

**Consequences:** hosts that matched `reason` exhaustively add `quota_store_unavailable`; a host that
relied on `rpm: 0` as "unlimited" omits `rpm` instead; a test that threw a `fakeProviderError` through a
`FakeAdapter` now sees the real classification; `@gullabs/testing` peers on the provider packages at the
release version.

---

## ADR-042: Runtimes, the Node floor and the release checks

**Status:** Accepted (2026-10-03).

**Context:**
The audit found four gaps in what the packages promise. CI ran one Node version while `engines` said
`>=22.12.0` and the SPEC said "Node ≥20". Every `exports` map served the ESM `.d.ts` to `require`
(are-the-types-wrong: "masquerading as ESM"), and nothing linted the packed manifests. `@gullabs/core`
imported `node:crypto`, so the entry failed to load on any runtime without Node built-ins, and the
supported runtimes were not written down. The README and doc examples were not compiled, and
`examples/basic.ts` no longer ran.

**Decision:**

1. **One Node floor, `>=22.12.0`, tested.** It is the `engines.node` of every published package, the
   README and SPEC figure, and the CI matrix floor. The code needs no newer Node: no API later than 22
   is used, and the dependencies' floors are lower (`openai` `>=22.0.0`, `@google/genai` `>=20`). The
   repository's own tooling needs Node 24 (pnpm 11 requires `>=22.13`, ESLint 10 `^22.13`), so the root
   `engines` stays `>=24` and the `node-matrix` CI job installs and builds with the `.nvmrc` Node, then
   switches to 22.12.0 and 24.x and runs the tests, the doc snippets and the built-ins check with `node`
   directly. A test pins `engines`, the README, the SPEC and the CI matrix to the same figure.
2. **Nested `exports` conditions.** `import` carries `{ types: index.d.ts, default: index.js }` and
   `require` carries `{ types: index.d.cts, default: index.cjs }`. `publint --strict` and
   `attw --pack` (pinned dev dependencies) run for every package in `pnpm quality` (`check:packages`);
   attw was red for `require` before and is green for node10, node16 from CJS, node16 from ESM and
   bundler now.
3. **No Node built-in in the runtime-agnostic packages.** `core`, `google`, `xai`, `quota`, `drizzle` and
   `any-llm` import no `node:` module and use neither `Buffer` nor `process`. Ids come from
   `globalThis.crypto.randomUUID()`. The two synchronous hashes (a history part's canonical JSON for the
   Gemini signature overlay, ADR-029; inline media and tool schemas in a payload, ADR-038) use
   `sha256Hex` / `Sha256` in core, a dependency-free SHA-256 tested against `node:crypto` at every
   padding boundary and on large inputs. `sha256Hex` is exported next to `canonicalJson`. WebCrypto was
   rejected because it is asynchronous and one-shot, and the signature hash sits in synchronous code.
   `claude-cli` and `codex-cli` spawn processes and `testing` imports `node:os` and `node:module`, so
   those three are Node only.
4. **The claim is tested, and bounded.** `pnpm test:runtime` loads the built ESM entry of each
   runtime-agnostic package under a module-resolution hook that fails any built-in import, then removes
   `Buffer` and `process` and runs a full `generate()` with a payload and an inline media part. It is in
   `pnpm quality` and in the Node matrix. Amendment A extends it. By hand under Deno 2.4.1 every check
   passed except the first, which asserts that `node:crypto` is blocked and only holds under the Node hook
   (Deno has its own `node:` built-ins and `Buffer`/`process` globals). No
   Bun, Cloudflare Workers, Vercel Edge or browser runtime was available, so those are documented as not
   tested, not as supported; the wrapped SDKs (`@google/genai`, `openai`) set their own runtime support.
   `@edge-runtime/vm` is not installed, so the hook test stands in for it.
5. **Docs compile.** `pnpm check:docs` extracts every `ts` fence in the READMEs, `CONTRIBUTING.md` and
   the live docs and typechecks it against the built packages (the workspace packages symlinked as
   `node_modules`, so the real `exports` maps resolve). A fence that is deliberately a fragment says
   `ts no-check`. ADRs, plans and audits are history and are not checked. `examples/**` is part of
   `pnpm typecheck`. The script has its own test (extraction, and a bad fence fails with `file:line`).
6. **`VERSION` is deleted.** `export const VERSION = '0.0.0'` read `0.0.0` while core was at 0.15 and was
   re-exported by the facade; a version constant that nothing keeps current is removed, not sourced.

**Consequences:** hosts that imported `VERSION` read their own `package.json`. A host on a runtime other
than Node and Deno must run its own smoke test, and must not rely on this repository for it.
`pnpm quality` needs a Node with `node --import` (22.12 has it) and the built packages.

---

## ADR-043: Model lifecycle: `shutdownDate`

**Status:** Accepted (2026-10-03).

**Context:**
Google's deprecations page (https://ai.google.dev/gemini-api/docs/deprecations, "Page last updated"
2026-10-01, read 2026-10-03) lists a May 7, 2027 shutdown for `gemini-3.1-flash-lite`, with
`gemini-3.5-flash-lite` as the replacement. The descriptor carried no lifecycle data, so a host found out
when the provider began to answer 404, and the only record was a prose note. Separately, both Gemma 4
descriptors declared `grounding: true` with no capture behind it.

**Decision:**

1. **`ModelDescriptor.shutdownDate?: string` (`YYYY-MM-DD`, UTC).** `createModelRegistry` rejects anything
   that is not a real calendar date (`2027-02-30`, `2027-5-7`, a prose date) with `bad_request`.
2. **A warning, never a refusal.** A successful call whose clock reads within 90 days of the date
   (`SHUTDOWN_WARNING_DAYS`), on the day or after it, carries one `warnings` entry naming the model, the
   date and the days left or gone by. The engine uses its injected clock, so a test advances a `FakeClock`.
   The provider decides what it still serves, and a model that is gone fails with the provider's own error;
   the library does not guess. An error path carries no advisory: the call did not succeed.
3. **`gemini-3.1-flash-lite` is the only descriptor with a date.** Gemini 2.5 access is limited to existing
   users on the same page with no date, and Gemma 4 is not listed, so none is set. Removing the model
   after the date is a dated BACKLOG item (delete it, no alias to the replacement).
4. **Gemma `grounding: true` stays, on a capture.** Live, 2026-10-03: three Search prompts on each Gemma 4
   model returned `groundingMetadata` on 5 of 6 calls; the one miss was `MAX_TOKENS` with an empty answer
   (thinking used the 800-token cap). Pinned as `gemma-grounding-2026-10-03.json` with a test that ties it
   to the descriptors (ADR-013).

**Consequences:** a host that alerts on warnings sees the advisory 90 days ahead of the shutdown. Host
descriptors may carry a date too. Nothing about a model without `shutdownDate` changes.
