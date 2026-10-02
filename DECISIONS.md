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

**Status:** Accepted; resolution keying and routing fallbacks superseded by ADR-022

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

**Status:** Accepted

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
- The middleware contract is simple enough that hosts can implement circuit-breakers, request
  tracing, or provider-fallback as middleware without forking the library.
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
the Gemini adapter forwards it as `responseSchema` and JSON-parses the returned text when
structured output was requested. The engine returns `output: unknown` and `outputParsed`, and never
validates shape.

**Consequences:**

- The no-Zod-runtime claim applies to structured output validation only. The library still does not
  validate `result.output` against Zod or any other schema library at runtime.
- Model config is a different boundary: built-in descriptors use runtime Zod schemas for config,
  and callers should not confuse `output.jsonSchema` with `descriptor.configJsonSchema`.
- Callers own validation, retry, and acceptance policy for `output`.
- Malformed or empty structured output is a successful provider call with `outputParsed:false`.

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
and fallback logic belongs in the middleware chain where it is explicit and auditable.

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
   (idempotency key), `attemptNumber` (1-based ordinal), `latencyMs`, token counts, `costMicroUsd`,
   `errorKind`, and verbatim `metadata`. Records are written via `UsageSink` (fail-open). Secret
   redaction (`redactSecrets`) is applied before persistence to `errorMessage`,
   `generationConfig.providerOptions`, and `generationConfig.httpOptions.headers`. Standard
   generation knobs and host-supplied `metadata` are not scanned.

The following are **explicitly deferred as consumer concerns**:

- First-party OTel package (the `Telemetry` port is the seam; publish an integration example).
- W3C `traceparent` propagation (hosts inject headers today via `providerOptions`).
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
- Hosts that need `traceparent` propagation pass it today via
  `providerOptions.google.httpOptions.headers` — no library change required.
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
  the pair. Longest-prefix matching is scoped within one provider. The same bare `model` under
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
   of the actual generation call it is meant to estimate.

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
dispatch. A live incident (a host application, 2026-07-09/10, `docs/input-validation-middleware-proposal.md`)
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
implementing them (`docs/input-contracts-plan.md`, codex-approved):

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
  `attemptNumber: 0`. `attemptId` follows the EXISTING first-attempt idempotency rule
  verbatim — `request.idempotencyKey` when supplied, a freshly minted id otherwise — so a
  caller-retried refused call with the same `idempotencyKey` upserts the same row instead of
  accumulating duplicates. `record.ts`'s `attemptNumber`/`attemptId` doc contracts are rewritten:
  `attemptNumber` is documented as "0 = refused before any attempt ran; real attempts are 1-based";
  `attemptId` on `attemptNumber: 0` is documented as derived by the attempt-1 rule and remaining the
  idempotency key. **Deliberate telemetry divergence:** `CallErrorEvent.attemptId` stays absent when
  no attempt ran (its existing documented semantics, unchanged) — the synthetic record's minted
  `attemptId` has no telemetry counterpart, and this divergence is intentional, not an oversight.
  **Quota-refusal observability consequence:** this is the same code path that covers
  `@gullabs/quota` refusals with zero quota-package changes — refusals that previously left no
  ledger row now appear as `error_kind: 'rate_limited'`, `attemptNumber: 0`, zero-usage rows.

**Row-less prologue boundary** (§3 of `docs/input-contracts-plan.md`):

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
9. **`countTokens`:** `TokenCountRequest.tools` is forwarded by Google
   (`accuracy: 'exact'`). xAI `bad_request`s `tools` (tokenize-text cannot
   represent declarations).
10. **`parallelToolCalls`** is xAI-only (`providerOptions.xai`).

**Consequences:**

- Callers own dispatch and the next `generate` turn.
- DESIGN.md un-reserves `tool-call` / `tool-result`.
- P0 no-legacy: `FinishReason` widens without an alias.

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
   function tools, and together with the request-level `toolChoice`. xAI
   defines `required` as "at least one tool"; with a function tool declared
   the option could not promise a search. Live: `required` ran 3 / 2 / 2
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
   exact cost, no tool fee. Before this, every `none` call and every `auto`
   call that skipped the search was recorded as unpriced. When the field is
   absent, or non-zero without counters, the call stays unpriced.
4. **Strict-schema dialect is rejected, never rewritten.** With
   `text.format.strict`, xAI accepts and ignores the OpenAPI `nullable`
   keyword, so the model cannot return `null` and writes `""`, `0` or the
   string `"null"`. Uppercase type names fail at xAI with HTTP 400. The
   adapter rejects both before dispatch, at JSON Schema keyword positions
   only, naming the path. A nullable field lists `'null'` in `type`.
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
