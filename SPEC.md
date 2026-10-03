# any-llm — v1 Build Spec (the thing we implement)

> `DESIGN.md` is the explored north-star (multi-provider, streaming, tools, OSS contracts).
> **THIS** file is the lean, buildable contract for v1. When they disagree, SPEC wins for v1.
> Principle: **design the seams, build the slice.** We implement only the four goals below;
> the seams exist so future features drop in without a rewrite.

## v1 goals (the entire scope)

1. Call **provider-hosted models** through self-contained provider packages composed via
   `composeProviders` (ADR-023): `@gullabs/google` over `@google/genai` (Gemini with Flex where
   supported; Gemma without Gemini-only Flex assumptions), `@gullabs/xai` over the `openai`
   SDK's Responses API (grok-4.5, grok-4.6, grok-4.7), plus the dev-only CLI providers (`@gullabs/claude-cli`,
   `@gullabs/codex-cli`). The core engine ships zero provider knowledge.
2. **Record token usage** (input / output / cached / **thinking**).
3. Capture **thinking** — thinking _token usage_ always; the provider-returned _thought-summary
   text_ when `reasoning.includeThoughts` is set — plus **postmortems** (per-call diagnostics on
   success and failure).
4. **Track cost** (provider-scoped pricing snapshots → micro-USD, frozen per record; each
   provider package ships its own `PricingSource`).

Everything else from DESIGN.md is OUT of scope for now (no streaming, no agent loop).
The function-calling **seam** shipped (ADR-029): `LlmRequest.tools` / `toolChoice` in,
`tool-call` / `tool-result` parts and `LlmResult.toolCalls` out — no tool execution. Every result
carries the ordered assistant `message` and `continuation` (`'history'` | `'state'`), so the host's own
loop follows the provider's rule; Gemini 3.x thought signatures travel as an overlay in
`transientProviderState` (ADR-029 addendum).
Seams are present; machinery is intentionally small.

## Non-negotiable invariants

- **Neither engine nor adapters validate output.** The engine forwards `output.jsonSchema` to the
  provider as a generation hint, JSON.parses the response, and surfaces `output: unknown` +
  `outputParsed: boolean`. The caller owns all validation, retry, and acceptance policy.
- **Continuation state is provider-scoped and model-bound.** `transientProviderState` is keyed by
  provider (`google`, `xai`), bound to the exact `model` string the host sent (an alias is never
  rewritten), and each adapter rejects another provider's state, stale history and another model's
  state with `bad_request` before dispatch. An overlay is a view of the host's history, never a copy.
- **`AdapterResult.message` is required.** The engine never rebuilds the ordered assistant message
  from `text` and `toolCalls`; a result with nothing representable has `message.parts === []`, and an
  assistant message with no parts is `bad_request` on the next request.
- **GROSS token convention:** `cachedInputTokens` is a SUBSET of `inputTokens`;
  `thinkingTokens` is a SUBSET of `outputTokens`. Cost math must not double-count.
- **Cost is frozen at write time:** integer micro-USD + `pricingVersion` on every record.
- **Side effects fail-open; the call fails-closed.** A broken sink/telemetry/cost never fails
  the LLM call; a broken call throws a typed `LlmError`.
- **No real network in tests.** Provider SDKs are mocked via structural fakes
  (`makeFakeGemini`, `makeFakeXai`); we stress the surface, not the providers.

---

## Packages (pnpm workspace monorepo — the seam for optional deps)

```
packages/
  core/       @gullabs/core       # types, ports, engine, callsite, computeCost, errors, record  (no provider deps)
  google/     @gullabs/google     # googleProvider: geminiAdapter over @google/genai + model configs + pricing  (peerDep @google/genai)
  xai/        @gullabs/xai        # xaiProvider: grok-4.5 / grok-4.6 / grok-4.7 over the openai SDK's Responses API  (peerDep openai)
  claude-cli/ @gullabs/claude-cli # dev-only: claude-fable-5-1, claude-opus-5-5, claude-sonnet-5, claude-haiku-4-5-20251001
  codex-cli/  @gullabs/codex-cli  # dev-only: gpt-6-astra, gpt-6-sol, gpt-6-luna
  any-llm/    @gullabs/any-llm    # batteries-included facade: re-exports core + google
  drizzle/    @gullabs/drizzle    # reference llm_calls schema + drizzleUsageSink  (peerDep drizzle-orm)
  quota/      @gullabs/quota      # provider quota middleware
  testing/    @gullabs/testing    # FakeClock, FakeIds, RecordingSink, makeFakeGemini, makeFakeXai, assertRegistryInvariants
```

Each provider package is a self-contained plugin (ADR-023): adapter + model descriptors +
strict per-model Zod config schemas + pricing source + typed provider options, wired via
`composeProviders([...])` with zero `@gullabs/core` edits.

Tooling: TypeScript (strict, `exactOptionalPropertyTypes`), **vitest**, **tsup** (ESM+CJS+d.ts),
Node ≥20. Provider SDKs are **peerDependencies** (a host that only uses Gemini never pulls others).

> Naming note (decide before publish): "any-llm" collides with mozilla-ai/any-llm on npm; the
> `@gullabs/*` scope is a working placeholder. Not a blocker for local build.

---

## Core types (`@gullabs/core`)

```ts
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue }

// ---- request ----
export interface LlmRequest {
  provider: string // explicit routing key; must match a configured adapter id
  model: string // bare provider-native string; identity is the (provider, model) pair
  system?: string
  messages: Message[] // multimodal parts; adapters reject media kinds/constraints they can't honor
  output?: { jsonSchema: JsonValue } // standard JSON Schema (ADR-034); adapter checks and forwards it, engine never validates the result
  config?: GenConfig
  metadata?: CallMetadata // host anchors: tenantId, runId, callSiteId, traceId…
}
export type Message = { role: 'user' | 'assistant'; parts: Part[] }
export type Part = TextPart | InlineMediaPart | FileUriPart // reject-don't-map per adapter
export type TextPart = { kind: 'text'; text: string }
export type InlineMediaPart = {
  kind: 'inline-media'
  mimeType: string
  data: string /* base64 */
}
export type FileUriPart = { kind: 'file-uri'; mimeType: string; uri: string } // provider-hosted or public URL

// ---- config (typed common knobs + quarantined raw passthrough) ----
export interface GenConfig {
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  reasoning?: ReasoningIntent // best-effort intent; adapter maps + may warn (not a guarantee)
  serviceTier?: string // opaque provider-defined tier vocabulary; per-model strict schemas constrain admitted values (Gemini: 'flex' | 'standard'); omitted stays omitted
  timeoutMs?: number
  providerOptions?: ProviderOptionsMap // open interface; each provider package augments it via declaration merging and enforces its own strict per-model allowlist (not a raw SDK passthrough)
}
export interface ReasoningIntent {
  effort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' // gemini-2.5 → thinkingBudget; gemini-3 → thinkingLevel; xAI 4.6 admits xhigh
  budgetTokens?: number
  includeThoughts?: boolean
}

// ---- result ----
export interface LlmResult {
  output?: unknown // present iff request had output.jsonSchema and JSON.parse succeeded; ALWAYS unknown, never validated
  outputParsed?: boolean // present iff output.jsonSchema was requested; true iff JSON.parse succeeded (NOT validated)
  message: Message // assistant output in provider order (thought parts omitted); indices are over message.parts
  continuation: 'history' | 'state' // how the next tool-loop turn is sent (descriptor capabilities.continuation)
  text?: string
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: JsonValue }> // derived from message
  transientProviderState?: JsonValue // provider-scoped, bound to the requested model string; never persisted
  reasoningText?: string // provider thought-summary, present iff includeThoughts requested
  usage: Usage
  cost?: Cost // null model-unpriced; tokens still captured
  model: string // the id the provider returned; do not route on it
  modelVersion?: string
  finishReason?: FinishReason
  responseId?: string
  servedServiceTier?: string // service tier actually served by the provider
  latencyMs: number
  queueDelayMs?: number // time spent waiting in RateLimiter.acquire before provider dispatch
  warnings: Warning[] // never silently drop a setting
  citations?: Citation[] // normalised sources, absent when the provider produced none
  providerMetadata?: JsonValue // raw provider metadata (grounding/safety/etc.)
}
export type FinishReason = 'stop' | 'length' | 'content_filter' | 'other'
export type Warning = { type: 'other'; message: string }

// ---- usage: typed core + open map + raw (forward-compat without migration) ----
export interface Usage {
  inputTokens: number // GROSS (includes cached)
  outputTokens: number // GROSS (includes thinking)
  cachedInputTokens?: number // SUBSET of inputTokens
  thinkingTokens?: number // SUBSET of outputTokens
  totalTokens?: number
  details: Record<string, number> // open token-type map; new types land here, costable
  raw: JsonValue // provider's entire usage object, verbatim
}
// Normalised search facts in `details`, same names on every provider (ADR-035):
//   web_search_requested  1 when the request enabled web search, else absent
//   web_search_calls      observed number of searches; absent when the response does not say
// `normalizeUsage` also warns, and the engine reports the cost as 'estimated', when totalTokens
// is larger than inputTokens + outputTokens (the provider counted tokens the fields omit).

// ---- citations ----
export interface Citation {
  url: string
  title?: string
  sourceName?: string
  cited?: boolean // the answer text cites this source (a span points at it); absent when the provider does not say
  textRange?: { start: number; end: number } // first span of LlmResult.text tied to this source, UTF-16 offsets
}

// ---- cost: frozen, micro-USD, per-type breakdown ----
export interface Cost {
  microUsd: number | null
  pricingVersion: string
  confidence: 'exact' | 'estimated' // 'estimated' if any priced field had to be inferred, a known charge is not priced, a grounding fee was charged in full (a call that ran Search), or totalTokens exceeds inputTokens + outputTokens (ADR-035)
  details: { input: number; cached: number; output: number; tools: number }
  // MUST sum to microUsd: input + cached + output + tools.
  // NOTE: thinking tokens are inside outputTokens and billed at the output rate — NO separate
  // 'thinking' cost lane. thinkingTokens is usage-only. tools is 0 when the call had no priced tools.
}
```

### Errors (`errors.ts`)

```ts
export type LlmErrorKind =
  | 'invalid_auth'
  | 'rate_limited'
  | 'server'
  | 'timeout'
  | 'aborted'
  | 'bad_request'
  | 'content_filter'
  | 'unknown'
// Closed on purpose: adapters cannot invent reasons; a new member is a core release (ADR-036).
export type LlmErrorReason =
  | 'transport_timeout'
  | 'quota_window'
  | 'daily_quota'
  | 'credits_exhausted'
  | 'spend_ceiling'
  | 'grounding_missing'
  | 'search_budget_exceeded'
  | 'cache_not_found'
export class LlmError extends Error {
  kind: LlmErrorKind
  retryable: boolean
  reason?: LlmErrorReason // why, within `kind`; kind + retryable stay authoritative
  httpStatus?: number
  retryAfterMs?: number
  provider?: string
  cause?: unknown
}
// adapters classify raw SDK errors → LlmError; engine surfaces it.
```

---

## Ports (`@gullabs/core` — host/companion implements)

```ts
export interface ProviderAdapter {
  id: string // 'google'
  // returns RAW result; engine JSON.parses it, computes cost, persists. Nobody validates it —
  // the caller owns validation.
  run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult>
}
export interface ResolvedRequest {
  // engine-built: defaults merged, prompts rendered
  provider: string
  model: string
  system?: string
  messages: Message[]
  outputJsonSchema?: JsonValue // standard JSON Schema; adapter asserts its profile, then sends it verbatim (responseJsonSchema / text.format)
  config: GenConfig // serviceTier optional; when omitted, adapters preserve provider-default behavior
  signal?: AbortSignal
}
export interface AdapterCtx {
  auth: AuthMaterial
  signal?: AbortSignal
  logger: Logger
}
export interface AdapterResult {
  rawStructured?: unknown // engine JSON.parses this into LlmResult.output (unknown); never validated
  servedServiceTier?: string // service tier actually served by the provider
  message?: Message // ordered assistant output; omitted → engine builds [text, ...toolCalls]
  text?: string
  reasoningText?: string // thought summary if includeThoughts requested
  usage: Usage
  model: string
  modelVersion?: string
  finishReason?: FinishReason
  responseId?: string
  warnings: Warning[]
  providerMetadata?: JsonValue
}

export interface UsageSink {
  record(r: LlmCallRecord): Promise<void>
} // host writes to its own DB
export interface PricingSource {
  version: string
  price(model: string, usage: Usage, tier?: string): Cost
  hasModel(model: string): boolean
  listModels(): readonly string[]
}
export type AuthMaterial = { apiKey: string }
export interface Clock {
  now(): number
}
export interface IdGenerator {
  callId(): string
  attemptId(): string
}
export interface Logger {
  info(o: object, m: string): void
  warn(o: object, m: string): void
  error(o: object, m: string): void
}
export interface Telemetry {
  // optional; host wires Sentry/PostHog/OTel
  onStart?(e: object): unknown
  onSuccess?(e: object, span?: unknown): void
  onError?(e: object, span?: unknown): void
}
```

Seams deferred (designed, NOT in v1): `Redactor`, `BlobStore`, `ConfigSource`, `FileStore`,
streaming `stream()`. They can be added without changing the above.

---

## Engine pipeline (`engine.ts`) — written once

```
runStructured(callSite, vars?, opts?)  /  generate(request)
  1. resolve config   (lib defaults → call-site defaults → per-call opts; deep-merge; omitted serviceTier stays omitted)
  2. render prompts   (non-recursive interpolation; var values are NOT re-interpolated — anti-injection)
  3. ids              callId; every attempt mints its own attemptId (ADR-031)
  4. telemetry.onStart + log 'llm.call.start'
  5. resolve adapter  (direct req.provider → adapter map; no derivation; unknown → LlmError 'bad_request')
  6. require per-call auth material ({ apiKey })
  7. rateLimiter.acquire("${provider}:${model}")  [once per attempt; queueDelayMs measured separately]
  8. adapter.run(resolved, ctx)   with timeout + AbortSignal
  9. normalize usage  (GROSS convention enforced; details map + raw populated by adapter)
 10. parse structured output  (JSON.parse result → output + outputParsed; caller validates)
 11. pricing.price()  → Cost (micro-USD, frozen)   [fail-open → cost absent on pricing error]
 12. build LlmCallRecord  + sink.record()           [fail-open: swallow+log sink errors]
 13. telemetry.onSuccess + log 'llm.call.success'
 14. return LlmResult
  (any throw → classify → telemetry.onError + log 'llm.call.error' + record status + rethrow LlmError)
```

Canonical log events (identical across hosts): `llm.call.start` / `.success` / `.error`.

Invariants of the middleware chain (ADR-037) and model resolution (ADR-033):

- Model ids resolve exactly: a descriptor's canonical `model` or one of its declared `aliases`.
  There is no prefix matching.
- A call's `{ provider, requestedModel, descriptor }` is fixed at call start. A middleware whose
  `next` receives a request with a different `provider` or `model` is refused with `bad_request`
  (and a zero-usage refusal row: `attemptNumber: 0` when no attempt had run, otherwise the refused
  attempt's number); `runAttempt` never reads them from the request. The identity is captured
  synchronously at the top of `generate()` / `runStructured()`, before any `await`.
  Hosts route and fall back by making a new call.
- A quota middleware (`role: 'quota'`) must be inside a retry middleware (`role: 'retry'`);
  `createClient` rejects the other order.

### Config resolution & call sites (`callsite.ts`)

```ts
defineCallSite({ id, provider, model, schema, system, userTemplate, config }) // (provider, model) — one-line swap
// resolution: libDefaults → callSite.config → opts.config  (deep-merge; per-call wins)
// v1 keeps this runtime-validated (no compile-time ConfigFor<M> — that machinery was cut).
```

---

## Cost model (`cost.ts`) — Gemini, correct by construction

```
billableInput  = inputTokens - (cachedInputTokens ?? 0)      // GROSS→net
output+thinking = outputTokens                                // thinking already inside outputTokens
microUsd = round( billableInput   * inputRate(model, inputTokens)     // inputRate honors >200k tier
                + (cachedInputTokens ?? 0) * cachedRate(model)
                + outputTokens     * outputRate(model) )
details = { input, cached, output }   // thinking billed at output rate (folded into output)
```

- Pricing table is a frozen snapshot with a `pricingVersion` string (e.g. `gemini-2026-06-27`).
- Long-context tier: Gemini Pro charges a premium above 200k input tokens — `inputRate` selects by
  total `inputTokens`. (Flash-lite is flat; encode per-model.)
- Unknown model → `cost = { microUsd: null, … }`; tokens + raw still recorded for later backfill.
- Pricing is **token-count based** across modalities — media parts bill through the provider's
  token accounting, so no per-modality input pricing lanes are needed (the DESIGN regression is
  avoided).

---

## Persisted record (`record.ts`) + reference schema (`@gullabs/drizzle`)

```ts
export interface LlmCallRecord {
  recordSchemaVersion: 1
  callId: string
  attemptId: string // always minted by the engine, one per attempt (ADR-031)
  attemptNumber: number // 1-based ordinal within the logical call (1 = first attempt, 2 = first retry, …)
  callSiteId?: string
  externalId?: string // caller-owned correlation id; give every host retry of one operation the same value
  provider: string
  model: string
  modelVersion?: string
  responseId?: string
  serviceTier?: string
  servedServiceTier?: string // service tier actually served by the provider
  // status is a coarse outcome category: 'timeout' | 'aborted' | 'content_filter' map
  // 1:1 from LlmErrorKind, but 'invalid_auth' | 'rate_limited' | 'server' | 'bad_request'
  // | 'unknown' all collapse to 'api_error' here — the exact failure kind is preserved
  // separately in `errorKind` below, so postmortems don't lose it:
  status: 'ok' | 'api_error' | 'timeout' | 'aborted' | 'content_filter'
  finishReason?: FinishReason
  outputParsed?: boolean // whether JSON.parse succeeded for a structured-output request
  latencyMs: number
  queueDelayMs?: number
  // usage (typed hot fields)
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  thinkingTokens?: number
  totalTokens?: number
  // cost (frozen)
  costMicroUsd?: number | null
  pricingVersion?: string
  // forward-compat lanes (jsonb)
  tokenDetails: JsonValue
  rawUsage: JsonValue
  providerMetadata?: JsonValue
  warnings?: JsonValue
  generationConfig: JsonValue // what we actually sent (transport keys stripped)
  // thinking capture (goal 3): summary text when includeThoughts was requested
  reasoningText?: string // truncated to a cap; null when not requested/returned
  // postmortem
  errorKind?: LlmErrorKind
  errorReason?: LlmErrorReason // LlmError.reason; absent on success and when the error has none
  errorMessage?: string // truncated; diagnostics on failure
  metadata: JsonValue // host anchors
  createdAt: string // Clock-stamped
}
```

`@gullabs/drizzle` ships the matching `pgTable('llm_calls', …)` (typed columns + jsonb lanes),
`drizzleUsageSink(db, table)`, and the SQL for it: `sql/install.sql` (fresh install) and
`sql/upgrades/*.sql`. `error_reason` is plain text with no CHECK constraint (ADR-036). Insert is `onConflictDoNothing` on `attemptId`, which only absorbs an
at-least-once sink re-delivering the same record; every attempt has its own minted `attemptId`.
Core imports no ORM; a host with a different store implements `UsageSink` directly.

---

## Google adapter (`@gullabs/google`)

- `geminiAdapter(): ProviderAdapter` over `@google/genai` (peerDep), API-key auth only (`{ apiKey }`
  passed per call; no Vertex support in v1 — see DESIGN.md).
- Maps: `serviceTier:'flex'` → Gemini Flex only when the model descriptor supports it; `reasoning`
  → `thinkingConfig` (budget for 2.5, level for 3.x); throws `LlmError('bad_request')` when the mapping cannot be applied;
  `output.jsonSchema` → `responseJsonSchema` (`responseMimeType:'application/json'`) only when native
  structured output is enabled, and a tool's `inputJsonSchema` → `parametersJsonSchema`, both
  verbatim and in the host's key order, never the OpenAPI `responseSchema` / `parameters`
  (ADR-034). A keyword Google does not enforce (`const`, `oneOf`, `allOf`, `exclusiveMinimum`,
  `multipleOf`, `uniqueItems`, …), a malformed schema, and (on Gemma models) `format`, `minLength`
  and `maxLength` are `bad_request` with the path before dispatch; `providerOptions.google.*` is a strict per-model allowlist mapped
  field-by-field onto the SDK call, not forwarded verbatim.
- Routes Gemini 2.5 (`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`),
  Gemini 3.x (`gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`,
  `gemini-3.6-flash`, `gemini-3.7-flash`, `gemini-3.8-flash`), and two API-verified Gemma 4
  models (`gemma-4-31b-it`, `gemma-4-26b-a4b-it`). `gemini-3-flash-preview` and
  `gemini-3.5-flash` do not resolve. Both Gemma 4 descriptors support multimodal parts, native structured
  output, grounding, and thinking (thinkingLevel). They do not support Gemini Flex or pricing.
- Usage: read `usageMetadata` → `promptTokenCount`→inputTokens, `candidatesTokenCount`→outputTokens,
  `cachedContentTokenCount`→cachedInputTokens, `thoughtsTokenCount`→thinkingTokens; copy whole object
  to `usage.raw`; populate `details`. Enforce GROSS convention. `toolUsePromptTokenCount` is recorded
  as `details.tool_use_prompt` and not priced.
- Grounding (ADR-013, ADR-035): `providerOptions.google.tools: [{ googleSearch: {} }]` sets
  `details.web_search_requested`; `details.web_search_calls` is the number of `webSearchQueries`
  occurrences. The pricing source adds the fee to `Cost.details.tools` (Gemini 3: per query; Gemini 2.5:
  per grounded prompt) and a call that ran Search is `estimated`. `requireGrounding: true` throws a
  retryable `server` error with reason `grounding_missing` (usage attached) unless metadata with at least
  one query is present. `allowSchemaWithSearch: true` admits `googleSearch` with `output.jsonSchema` on a
  model that does not admit them by default, and turns `requireGrounding` on unless set to `false`.
  `Citation.cited` / `textRange` come from `groundingSupports`; `providerMetadata.google.searchEntryPoint`
  carries Google's required Search Suggestions widget.
- Errors: classify 401→invalid_auth; 403→invalid_auth unless a provider overlay reclassifies;
  429→rate_limited(+retryAfter), 5xx→server, timeout→timeout, 400→bad_request;
  safety (HTTP or 200-path)→content_filter.
- **Never executes tools, never loops, never persists.** Pure request⇄response mapping.

---

## xAI adapter (`@gullabs/xai`)

- `xaiAdapter(): ProviderAdapter` over the `openai` SDK's Responses API pointed at
  `https://api.x.ai/v1` (peerDep `openai@^7`), API-key auth only. Ships `grok-4.5`,
  `grok-4.6`, and `grok-4.7` (level reasoning; all three admit `serviceTier: 'priority'`,
  while 4.6 and 4.7 also admit `xhigh`; native structured output via `text.format`, vision, automatic
  caching + `providerOptions.xai.promptCacheKey`, pricing incl. the ≥200k
  long-context tier). Same contract as the Google adapter: strict per-model schema,
  reject-don't-map, GROSS usage, never persists/loops. Full details in
  `packages/xai/README.md`.
- **Timeouts and transport (ADR-032).** Each call passes the SDK a `timeout` of
  `timeoutMs + 5 000`, or one hour when `timeoutMs` is unset. That does not lift Node's 300 s
  header and body timers; a call that can run longer needs `xaiAdapter({ transport })` with an
  undici `fetch` and `Agent({ headersTimeout, bodyTimeout })`. A header, body or SDK-deadline
  timeout is `kind: 'timeout'`, `retryable: false`, `reason: 'transport_timeout'`.
- `providerOptions.xai` is an allowlist; unknown keys are `bad_request`:

  | key                 | wire                  | rule                                                                                                                                                                  |
  | ------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `promptCacheKey`    | `prompt_cache_key`    | non-empty string                                                                                                                                                      |
  | `tools`             | `tools`               | `web_search` / `x_search`, at most one of each; needs `capabilities.grounding`                                                                                        |
  | `parallelToolCalls` | `parallel_tool_calls` | boolean                                                                                                                                                               |
  | `toolChoice`        | `tool_choice`         | `'auto' \| 'required' \| 'none'` for the search tools only; needs non-empty `tools`; rejected with function tools, file attachments or the request-level `toolChoice` |
  | `maxTurns`          | `max_turns`           | integer ≥ 1; needs non-empty `tools`; caps agentic turns, not searches; xAI did not enforce it as of 2026-10-02                                                       |

- xAI structured output and tool parameters take standard JSON Schema (ADR-034). A nullable
  field lists `'null'` in `type` (`type: ['string', 'null']`). The OpenAPI `nullable` keyword,
  uppercase type names (`STRING`, `OBJECT`) and any keyword xAI does not enforce (`oneOf`,
  `allOf`, `multipleOf`, `uniqueItems`, recursive `$ref`, an unlisted `format`, a limit above
  xAI's, a malformed schema, …) are `bad_request` before dispatch, naming the path; the adapter
  never rewrites a schema. (`claude-cli` forwards `output.jsonSchema` to the CLI untouched and
  `codex-cli` runs its own OpenAI-strict preflight; the checks are Google's and xAI's.)
- Search tools plus `output.jsonSchema` is admitted on all three models
  (`structuredOutputWithTools`). A response reporting `num_server_side_tools_used: 0` and no
  `server_side_tool_usage_details` prices exactly with no tool fee. See ADR-030.

---

## Testing strategy (`@gullabs/testing` + per-package suites) — NO real provider calls

- **Fakes:** `FakeClock`, `FakeIds`, `RecordingSink` (captures records), `makeFakeGemini` (a stub
  `@google/genai` client returning scripted responses incl. usageMetadata with thoughtsTokenCount),
  `makeFakeXai` (a structural `XaiClientLike` stub replaying Responses API payloads).
- **Unit:** cost math (GROSS/net, >200k tier, cached discount, unknown-model→null); error
  classification; config resolution/merge; usage normalization; record building; JSON parse→outputParsed.
- **The highest-risk test (codex-mandated, no network):** drive the engine with a fake adapter
  result of `inputTokens=250_000, cachedInputTokens=100_000, outputTokens=5_000, thinkingTokens=2_000`
  and assert in ONE test: gross/subset invariant preserved; `>200k` tier chosen on gross input;
  only 150_000 input billed at input rate; 100_000 at cached rate; 5_000 output billed once;
  thinkingTokens persisted but adds ZERO cost; `sum(cost.details)===cost.microUsd`; and the persisted
  record's cost === returned `LlmResult.cost` exactly.
- **Adapter contract tests:** drive `geminiAdapter` against `makeFakeGemini` scripted scenarios
  (flex tier set, thinking captured, structured output, each error kind, warnings emitted) and
  `xaiAdapter` against `makeFakeXai` replaying sanitized live-captured Responses API fixtures.
- **Engine integration (fakes):** end-to-end `generate()` → one record in `RecordingSink` with correct
  usage+cost+postmortem; success and every failure path.
- **Surface stress (no network):** property/fuzz the public surface — malformed usageMetadata, missing
  fields, huge token counts, cached>input (must clamp/warn not crash), timeouts/abort, schema mismatch,
  providerOptions passthrough, fail-open sink errors. Assert invariants hold and nothing throws except
  typed `LlmError`.
- Gate: typecheck + lint + vitest must pass; coverage on core ≥ the agreed bar.

---

## Build milestones (deliverables) — order validated by codex sign-off (testing pulled forward)

M0 scaffold · **M1** core types+errors+record · **M2** testing fakes (FakeClock/Ids/RecordingSink/
fakeGemini) · **M3** cost+pricing · **M4** engine+callsite · **M5** google adapter · **M6** drizzle
sink + surface-stress/fuzz · **M7** docs+example. Each code milestone: code + tests +
`/codex:adversarial-review` sign-off before the next.

### Codex sign-off (gpt-5.4, 2026-06-27) — addressed

Blocking issues fixed in this spec: (1) thinking _capture_ now explicit — usage always + thought
text when `includeThoughts` (`reasoningText` on result/adapter/record); (2) `Cost.details` is
`{input,cached,output}` and MUST sum to `microUsd` (thinking billed inside output, no separate lane);
(3) record `status` aligned to failure modes (+`content_filter`,`aborted`); (4) `responseId` persisted.
Pricing math verified against Google's live Gemini pricing page. Highest-risk bug to test:
double-counting cached/thinking tokens (see the explicit 250k/100k/5k/2k assertion in §Testing).
