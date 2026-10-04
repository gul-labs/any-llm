/**
 * Port interfaces for @gullabs/core.
 *
 * These are the seams — every pluggable dependency the engine accepts is
 * expressed as an interface here.  Host applications implement whichever
 * ports they need; adapters implement {@link ProviderAdapter}.
 *
 * Deferred ports (not in v1 scope): `Redactor`, `BlobStore`,
 * `ConfigSource`, `FileStore`, streaming `stream()`.
 *
 * @module
 */

import type {
  JsonValue,
  Usage,
  FinishReason,
  Warning,
  Message,
  GenConfig,
  LlmResult,
  CallCost,
  CallMetadata,
  Cost,
  Citation,
  ToolDefinition,
  ToolChoice,
} from './types.js'
import type { LlmCallRecord } from './record.js'
import type { LlmError, LlmErrorKind, LlmErrorReason } from './errors.js'
import type { ModelDescriptor } from './registry.js'
import type { UsageSinkContext } from './payload.js'

// ---------------------------------------------------------------------------
// Adapter seam
// ---------------------------------------------------------------------------

/**
 * The request handed to an adapter after the engine has resolved defaults,
 * rendered prompts, and merged config.
 */
export interface ResolvedRequest {
  /**
   * Provider identifier — authoritative for routing.  Adapters MAY assert
   * `req.provider === adapter.id` defensively; the engine already guarantees
   * this post-route.
   */
  provider: string
  /**
   * The model string the host sent (a declared alias is forwarded unchanged,
   * never rewritten to the canonical id). Forwarded verbatim to the SDK/CLI.
   */
  model: string
  /** Rendered system instruction, if any. */
  system?: string
  /** Conversation history with rendered content. */
  messages: Message[]
  /**
   * JSON Schema forwarded to the provider as a structured-output generation
   * hint. The engine does not validate output shape.
   */
  outputJsonSchema?: JsonValue
  /**
   * Merged generation config.
   * `serviceTier` remains optional; when omitted, adapters must preserve the
   * provider's default behavior instead of inferring a tier.
   */
  config: GenConfig
  /** Opaque continuation state, forwarded from the caller without ledger persistence. */
  transientProviderState?: JsonValue
  /** Propagated abort signal (timeout + caller cancel merged). */
  signal?: AbortSignal
  /**
   * Registry descriptor for the resolved model, if available.
   * Adapters use this to drive model-specific behaviour (e.g. which
   * thinkingConfig API variant to use) without hard-coding model-string
   * heuristics.
   */
  modelDescriptor?: ModelDescriptor
  /**
   * Internal-use field set by the engine (the type is exported, but consumers should not set
   * it; the engine overwrites it for every attempt and never persists it). Carries the time the
   * logical-call deadline has left for this attempt, so an adapter can size its own transport
   * timer, while `config.timeoutMs` stays equal to the caller's original value in the audit
   * record. Absent when no `timeoutMs` is set.
   */
  attemptTimeoutMs?: number
  /**
   * Internal-use field set by the retry middleware (the type is exported, but consumers should
   * not set this; it is overwritten per attempt and never persisted). Carries the 1-based
   * ordinal of the current attempt so the engine can record and log which attempt produced
   * the result or failure.
   */
  attemptNumber?: number
  /** Function-calling tools, copied from {@link LlmRequest.tools}. */
  tools?: ToolDefinition[]
  /** Tool selection policy, copied from {@link LlmRequest.toolChoice}. */
  toolChoice?: ToolChoice
}

/**
 * Context supplied to the adapter alongside the request.
 */
export interface AdapterCtx {
  /** Resolved credentials for the target provider. */
  auth: AuthMaterial
  /** Merged abort signal (same reference as `ResolvedRequest.signal`). */
  signal?: AbortSignal
  /** Structured logger for adapter-internal diagnostics. */
  logger: Logger
  /**
   * Registry descriptor for the resolved model, set by the engine for
   * `countTokens` (where the adapter has no {@link ResolvedRequest}). `run`
   * reads it from {@link ResolvedRequest.modelDescriptor}.
   */
  modelDescriptor?: ModelDescriptor
  /**
   * The client's {@link Scheduler}, for adapters that wait (a polling loop, a
   * scripted delay). Set by the engine on every call, so an adapter's waits
   * follow the same fake or real timers as the engine's own. Absent only when
   * an adapter is invoked directly, outside the engine, in which case real
   * timers apply.
   */
  scheduler?: Scheduler
}

/**
 * The raw result returned by an adapter.
 *
 * **Adapters never validate, cost, or persist.**
 * Those responsibilities belong to the engine.
 */
export interface AdapterResult {
  /**
   * Raw structured output from the provider.
   * Already JSON-parsed by the adapter when structured output was requested.
   * `unknown` so the adapter is not coupled to any schema library.
   */
  rawStructured?: unknown
  /** Service tier actually served by the provider. */
  servedServiceTier?: string
  /**
   * The assistant's output as an ordered message, in provider order (see
   * {@link LlmResult.message}). Required: the engine does not rebuild it from
   * {@link text} and {@link toolCalls}, because only the adapter knows the
   * provider's interleaving. Its `parts` is empty when the provider returned
   * nothing representable (a thought-only response).
   *
   * The engine hands the host a copy of {@link toolCalls}, so adapters may let
   * its argument objects and this message's tool-call parts be the same objects.
   */
  message: Message
  /** Raw text content from the model. */
  text?: string
  /**
   * Provider-returned thought summary.
   * Present only when `config.reasoning.includeThoughts` was `true` and the
   * provider returned thought text.
   */
  reasoningText?: string
  /** Token usage for this call. */
  usage: Usage
  /** Model identifier as returned by the provider. */
  model: string
  /** Provider-specific version string. */
  modelVersion?: string
  /** Why the model stopped generating. */
  finishReason?: FinishReason
  /** Provider-assigned response ID. */
  responseId?: string
  /** Warnings about lossy setting mappings, unsupported options, etc. */
  warnings: Warning[]
  /**
   * Normalized citations. Adapters own shaping; the engine passes through
   * verbatim. Omit when unused; do not emit an empty array.
   */
  citations?: Citation[]
  /**
   * Projection of assistant tool-call parts. Omit when unused.
   */
  toolCalls?: Array<{
    toolCallId: string
    toolName: string
    args: JsonValue
  }>
  /** Raw provider metadata (grounding, safety ratings, etc.). */
  providerMetadata?: JsonValue
  /** Opaque continuation state returned to the caller, never written to the ledger. */
  transientProviderState?: JsonValue
}

/**
 * A request to count tokens for a prospective call without generating.
 *
 * Deliberately narrower than {@link ResolvedRequest}: no `config`, no
 * `outputJsonSchema`, no `modelDescriptor` — token counting only needs the
 * text-bearing payload (`system` + `messages`) plus model identity.
 */
export interface TokenCountRequest {
  /** Provider identifier — routes to the adapter exactly like `generate`. */
  provider: string
  /** Provider-native model string, forwarded verbatim to the adapter/SDK. */
  model: string
  /** Optional system instruction included in the token count. */
  system?: string
  /** Conversation history included in the token count. */
  messages: Message[]
  /**
   * Tool declarations included in the token count (token-bearing request
   * context). `toolChoice` is excluded — it selects behavior.
   */
  tools?: ToolDefinition[]
}

/**
 * The result of a token-count query.
 */
export interface TokenCount {
  /** Total tokens the provider would count for the request. */
  totalTokens: number
  /**
   * How representative this count is of the generation call.
   *
   * - `'exact'` — the provider counted the real request (e.g. Gemini).
   * - `'lower-bound'` — the provider counted a text-only projection that
   *   omits inference-added framing (e.g. xAI `/v1/tokenize-text`).
   * - `'estimated'` — the provider counted the history, but the real call
   *   sends parts the count cannot include, so the true count is higher by an
   *   amount the count does not report (Gemini 3 thought signatures on replayed
   *   function calls, roughly 110 prompt tokens each).
   */
  accuracy: 'exact' | 'lower-bound' | 'estimated'
  /**
   * Open per-category breakdown (e.g. `{ cached: 128 }`).
   * Present only when the provider reports a breakdown.
   */
  details?: Record<string, number>
  /** The provider's raw token-count response, stored verbatim. */
  raw: JsonValue
}

/**
 * A provider adapter — the only interface that must be implemented to add a
 * new LLM provider to the engine.
 *
 * Adapters are pure request→response mappers.  They must never:
 * - Validate the structured output.
 * - Compute or record cost.
 * - Persist anything.
 * - Retry on error.
 */
export interface ProviderAdapter {
  /**
   * Stable provider identifier used for routing and auth credential lookup.
   * Examples: `'google'`, `'openai'`, `'anthropic'`.
   */
  id: string
  /**
   * Execute a single LLM call and return the raw result.
   *
   * @param req - Engine-resolved request with merged config.
   * @param ctx - Auth material, abort signal, and logger.
   * @throws {@link LlmError} — adapters must classify SDK errors before throwing.
   */
  run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult>
  /**
   * OPTIONAL: count tokens for a prospective request without generating.
   * A metadata query only — never calls the generation endpoint, never
   * produces output, never persists. Adapters that implement this must
   * classify SDK errors into {@link LlmError} exactly as {@link run} does.
   */
  countTokens?(req: TokenCountRequest, ctx: AdapterCtx): Promise<TokenCount>
}

// ---------------------------------------------------------------------------
// Rate-limiter port
// ---------------------------------------------------------------------------

/**
 * A function that MUST be called exactly once to signal the end of the
 * rate-limited window for a single acquired slot.
 *
 * The engine passes the attempt's normalized {@link Usage} when the provider
 * reported one (a success, or a billed failure that carries `usage`), and
 * nothing when the attempt produced none (a timeout, an abort, a transport
 * failure). A token-aware limiter reconciles its estimate against it.
 *
 * The engine guarantees `Release` is called on every exit path (success and
 * error) after a successful {@link RateLimiter.acquire}.  Implementations that
 * track concurrency use it to free the slot; implementations based on a
 * pre-send wait (e.g. Upstash token bucket) may treat it as a no-op.
 * Note: if a timeout or caller-abort fires while the adapter is still running
 * (because the adapter ignores `ctx.signal`), the engine calls `Release` as
 * soon as the cancellation race rejects — which may be BEFORE the underlying
 * provider request actually stops.  Concurrency-slot accuracy therefore depends
 * on adapters honoring the abort signal cooperatively.
 */
export type Release = (usage?: Usage) => void

/**
 * What the engine knows about a call before it is dispatched, handed to
 * {@link RateLimiter.acquire} so a token-aware limiter can pace on it.
 */
export interface RateLimitHint {
  /**
   * A cheap estimate of the attempt's input tokens, from the text the request
   * carries (system, message text, tool calls and results, tool declarations;
   * see `estimateInputTokens`). Media and file parts are not counted, so it is
   * a floor for a request that carries them. It is an estimate, never the
   * provider's count: the limiter reconciles it with the real usage given to
   * {@link Release}.
   */
  estimatedInputTokens?: number
  /**
   * The engine clock's reading (`Clock.now()`, epoch milliseconds) when the attempt
   * reached the limiter. A limiter that names time windows uses it instead of the
   * system clock, so a client built with a `FakeClock` and a limiter agree on what
   * time it is. The engine always sets it.
   */
  nowMs?: number
}

/**
 * Pre-send pacing / backpressure seam.
 *
 * The engine calls {@link acquire} **before** invoking the provider adapter,
 * so the limiter can delay or block the call until the provider's rate limit
 * allows it.  This is PRE-SEND backpressure, not a post-hoc check — callers
 * may wait arbitrarily long inside `acquire`.
 *
 * ## Key format
 * The engine builds keys as `"${provider}:${model}"` (e.g. `"google:gemini-2.5-pro"`),
 * with `provider` sourced directly from `req.provider` (never derived).
 * Rate limits are per-provider+model because providers enforce quotas per model,
 * and a single instance may call multiple models concurrently.
 *
 * ## Signal
 * If the caller (or the engine timeout) fires the `signal` while a call is
 * waiting inside `acquire`, the implementation MUST reject with an appropriate
 * error.  The engine's `classifyError` will map an `AbortError` to
 * `kind: 'aborted'` and a timeout error to `kind: 'timeout'`, so no special
 * classification is required in the limiter itself.
 *
 * ## Release contract
 * `acquire` resolves to a {@link Release} function that MUST be called exactly
 * once on every exit path (success or error) after a successful acquire.  The
 * engine guarantees this.  A broken Release (one that throws, or returns a
 * promise that rejects) is swallowed by the engine so it does not mask the
 * real result or error.
 *
 * ## Honour the signal
 * `acquire` receives the call's combined abort signal and must reject when it
 * fires. The engine also releases a late-resolved `acquire` whose call already
 * ended, but it cannot stop the limiter from doing work for a dead call.
 *
 * ## Not fail-open
 * Unlike sinks and telemetry, a rejection from `acquire` **propagates** — the
 * whole point of this port is to be able to refuse or delay calls.  Do not
 * catch errors from `acquire`.
 *
 * ## Canonical implementations
 *
 * **Upstash-Redis token bucket** (distributed, multi-machine):
 * The wait and quota logic live inside `acquire`; `Release` is a no-op because
 * the bucket is decremented atomically before the call proceeds.  A single
 * `@gullabs/rate-limiter-upstash` package would wrap the Upstash REST API
 * and implement this interface.  No Upstash/Redis dependency belongs in core.
 *
 * **Temporal host**:
 * Temporal task-queue rate limiting (via `maxConcurrentActivityTaskExecutors`
 * and workflow `RateLimitInterceptor`) gates execution upstream, so the engine
 * running inside a Temporal activity typically uses the no-op
 * `NOOP_RATE_LIMITER` — the seam is satisfied trivially. See `@gullabs/quota`'s
 * README for the quota-specific discussion of this conscious fail-open default.
 *
 * **In-process concurrency cap** (tests / single-node):
 * Use `inMemoryRateLimiter` from `@gullabs/core` to enforce a per-key
 * concurrency limit without any network dependency.
 */
export interface RateLimiter {
  /**
   * Block until the caller is cleared to send a request, then resolve a
   * {@link Release} function.
   *
   * @param key    - Per-provider+model key: `"${provider}:${model}"`.
   * @param signal - Combined abort signal from the engine (caller + timeout).
   *                 `acquire` MUST honour it: if it fires while waiting,
   *                 reject immediately. When a timeout or abort wins while
   *                 `acquire` is still pending, the engine calls the `Release`
   *                 it resolves with later, so a slot is not leaked; a limiter
   *                 that ignores the signal still holds its slot until then.
   * @param hint   - What the engine knows about the attempt before dispatch
   *                 (see {@link RateLimitHint}). A limiter that does not pace
   *                 on tokens ignores it.
   * @returns A {@link Release} that MUST be called exactly once after the
   *          acquire resolves, on every exit path.
   */
  acquire(key: string, signal?: AbortSignal, hint?: RateLimitHint): Promise<Release>
}

// ---------------------------------------------------------------------------
// Side-effect ports (host implements; fail-open in the engine)
// ---------------------------------------------------------------------------

/**
 * Persists a completed call record to the host's own data store.
 *
 * Failures are logged and swallowed by the engine — a broken sink must never
 * fail the LLM call.
 */
export interface UsageSink {
  /**
   * `true` when this sink stores `ctx.payload` (ADR-038). `ClientConfig.payloads`
   * only builds and passes payloads to a sink that sets it; with `payloads`
   * configured and the flag absent, `createClient` logs one warning and no
   * payload is built. Set it only if `record` reads its second argument.
   */
  readonly acceptsPayloads?: boolean
  /**
   * Record a completed call.
   * Implementations should be idempotent on `attemptId` (e.g. `onConflictDoNothing`).
   *
   * `ctx.payload` is present only when the client opted into payload storage
   * (`ClientConfig.payloads`, ADR-038), storage applies to this attempt and the
   * sink declares `acceptsPayloads: true`. It is already redacted and capped.
   */
  record(r: LlmCallRecord, ctx?: UsageSinkContext): Promise<void>
}

/**
 * Looks up cost for a given model and usage.
 *
 * A `PricingSource` is **provider-scoped**: its `price`/`hasModel`/`listModels`
 * methods operate on bare provider-native model keys for exactly one
 * provider. Cross-provider composition happens at the client config level via
 * `ClientConfig.pricingSources` (keyed by provider), not inside this port.
 *
 * Core ships no built-in pricing table — each provider package (e.g.
 * `@gullabs/google`) supplies its own `PricingSource` factory; hosts can
 * supply a custom source per provider to override or extend it.
 */
export interface PricingSource {
  /** Identifies the pricing snapshot (e.g. `"gemini-2026-06-27"`). */
  version: string
  /**
   * Compute cost for a call.
   *
   * @param model - Model identifier.
   * @param usage - Token usage for the call (GROSS convention).
   * @param tier - Service tier (`'flex'` | `'standard'`), if relevant to pricing.
   */
  price(model: string, usage: Usage, tier?: string): Cost
  /** True when `model` is a priced key of this source (an exact match, as in `price()`). */
  hasModel(model: string): boolean
  /** All model keys this source can price. */
  listModels(): readonly string[]
}

// ---------------------------------------------------------------------------
// Auth port
// ---------------------------------------------------------------------------

/**
 * API-key credential material. Used by production API providers (e.g.
 * Google). The caller supplies `{ apiKey }` on every `generate` /
 * `runStructured` call; the library never reads credentials from the
 * environment or any ambient source (see ADR-019).
 */
export type ApiKeyAuth = {
  apiKey: string
  /**
   * Opaque caller-chosen label identifying which key was used (e.g.
   * `'gemini-paid'`, `'grok-team-A'`), for per-key attribution in
   * observability records (see ADR-026).
   *
   * Persisted verbatim to `LlmCallRecord.authKeyId` / `llm_calls.auth_key_id`
   * — it is NOT redacted. It MUST NOT contain the secret itself (`keyId`
   * equal to `apiKey` is rejected). Beyond non-empty and not-the-secret, the
   * library imposes no length cap or charset rule; the label's meaning is
   * entirely caller-owned.
   */
  keyId?: string
}

/**
 * Explicit opt-in to a locally-authenticated CLI session (dev-only providers,
 * e.g. `@gullabs/claude-cli`, `@gullabs/codex-cli`). The adapter shells out to
 * a CLI binary that owns its own login/session state (OAuth, subscription
 * auth, etc.) — the library never reads or forwards any credential material
 * for this variant. Passing `{ cliSession: true }` is a deliberate, explicit
 * caller choice; it is never inferred or defaulted.
 *
 * Deliberately has no `keyId` (see ADR-026): CLI-session providers have no
 * key identity to attribute — the CLI binary owns its own local auth, and
 * there is no caller-supplied secret to label.
 */
export type CliSessionAuth = { cliSession: true }

/**
 * Credential material passed to the adapter per call.
 *
 * A discriminated-by-shape union: API-key providers narrow to
 * {@link ApiKeyAuth}; dev-only CLI providers narrow to {@link CliSessionAuth}.
 * The library never reads credentials from the environment or any ambient
 * source (see ADR-019) — this includes the CLI variant, where the CLI binary
 * (not this library) owns its own local auth.
 *
 * **Adding a future credential kind** (e.g. explicit Vertex service-account
 * material, or an OAuth/STS bearer token): extend the union with a new
 * member and update exactly these sites:
 * - `requireAuth()` in `packages/core/src/engine.ts`
 * - `buildGoogleClient` in `packages/google/src/adapter.ts`
 * - `buildCachesClient` in `packages/google/src/cache-store.ts`
 * - `buildFilesClient` in `packages/google/src/file-store.ts`
 * - `packages/claude-cli/src/adapter.ts`
 * - `packages/codex-cli/src/adapter.ts`
 *
 * TypeScript exhaustiveness will flag every narrowing site automatically.
 */
export type AuthMaterial = ApiKeyAuth | CliSessionAuth

// ---------------------------------------------------------------------------
// Infrastructure ports
// ---------------------------------------------------------------------------

/**
 * Monotonic or wall-clock time source.
 * Injected so tests can use a `FakeClock` for deterministic latency assertions.
 * It may return fractional milliseconds (`performance.now()`): the ledger record
 * rounds `latencyMs` and `queueDelayMs` to whole milliseconds.
 */
export interface Clock {
  /** Returns the current time as milliseconds since the Unix epoch. */
  now(this: void): number
}

/**
 * Handle returned by {@link Scheduler.setTimeout}; opaque, passed back to
 * {@link Scheduler.clearTimeout}.
 */
export type TimerHandle = object | number

/**
 * The timer source the engine, the retry middleware and the fakes use for every
 * wait. The default is the platform's `setTimeout` and `clearTimeout`.
 * Inject `FakeClock` from `@gullabs/testing` (it implements both this and
 * {@link Clock}) to make timeouts, deadlines and back-off deterministic.
 */
export interface Scheduler {
  /** Runs `callback` once after `ms` milliseconds; returns a handle for `clearTimeout`. */
  setTimeout(this: void, callback: () => void, ms: number): TimerHandle
  /** Cancels a pending timer; a settled or unknown handle is ignored. */
  clearTimeout(this: void, handle: TimerHandle): void
}

/**
 * Generates unique identifiers for calls and attempts.
 * Injected so tests can use `FakeIds` for deterministic record assertions.
 */
export interface IdGenerator {
  /** Generate a new call-scoped ID. */
  callId(this: void): string
  /** Generate a new attempt-scoped ID (unique within a call). */
  attemptId(this: void): string
}

/**
 * Structured logger interface.
 *
 * Canonical event names: `llm.call.start`, `llm.call.success`, `llm.call.error`.
 * The engine emits these; adapters use `warn` / `error` for internal diagnostics.
 */
export interface Logger {
  /** Informational event (call start / success). */
  info(o: object, m: string): void
  /** Non-fatal advisory (unsupported setting, unknown token type, etc.). */
  warn(o: object, m: string): void
  /** Error event (call failed, sink error, etc.). */
  error(o: object, m: string): void
  /** Low-level diagnostic event (telemetry breadcrumbs, sink success, etc.). */
  debug(o: object, m: string): void
}

/**
 * Event emitted when a logical LLM call begins (before any attempt).
 *
 * @remarks
 * `metadata` carries the caller's domain anchors as high-cardinality attributes.
 * Suitable for log fields and OTel span tags; do NOT promote arbitrary keys to
 * metric labels (cardinality risk).
 */
export interface CallStartEvent {
  /** Stable call identifier (matches persisted record). */
  callId: string
  /** Provider identifier, sourced from `req.provider`. */
  provider: string
  /** Model string as supplied by the caller. */
  model: string
  /** Call-site identifier, if the call was made via `runStructured`. */
  callSiteId?: string
  /** Caller-supplied domain metadata (opaque; never branch on contents). */
  metadata: CallMetadata
}

/**
 * Event emitted once per provider attempt, after the attempt's ledger row was
 * handed to the sink (success or failure).
 *
 * A refusal that never reached an attempt (a middleware refusal, an exhausted
 * retry budget, an input-contract violation) is not an attempt and emits no
 * `AttemptEvent`; the call's `onError` reports it.
 *
 * @remarks
 * `metadata` carries the caller's domain anchors as high-cardinality attributes;
 * do NOT promote arbitrary keys to metric labels.
 */
export interface AttemptEvent {
  /** Stable call identifier (shared by every attempt of the call). */
  callId: string
  /** This attempt's identifier (matches the persisted row). */
  attemptId: string
  /** 1-based ordinal of the attempt within the call. */
  attemptNumber: number
  /** Provider identifier, sourced from `req.provider`. */
  provider: string
  /** Model string as supplied by the caller. */
  model: string
  /** Call-site identifier, if the call was made via `runStructured`. */
  callSiteId?: string
  /** Caller-supplied domain metadata (opaque; never branch on contents). */
  metadata: CallMetadata
  /** Wall-clock provider-dispatch latency of this attempt, in milliseconds. */
  latencyMs: number
  /** Token usage of this attempt (zeros when the attempt carried none). */
  usage: Usage
  /** This attempt's cost, when it was priced or known to be unpriced. */
  cost?: Cost
  /** The error kind when the attempt failed; absent when it succeeded. */
  errorKind?: LlmErrorKind
  /** Typed reason within `errorKind`, when the error carries one. */
  reason?: LlmErrorReason
  /** Whether the failing error was considered retryable (failed attempts only). */
  retryable?: boolean
}

/**
 * Event emitted after a successful LLM call (post-sink, post-retry if any).
 *
 * @remarks
 * `metadata` carries the caller's domain anchors as high-cardinality attributes.
 * Suitable for log fields and OTel span tags; do NOT promote arbitrary keys to
 * metric labels (cardinality risk).
 */
export interface CallSuccessEvent {
  /** Stable call identifier (matches persisted record). */
  callId: string
  /** Attempt identifier of the successful attempt. */
  attemptId: string
  /** Provider identifier, sourced from `req.provider`. */
  provider: string
  /** Model string as supplied by the caller. */
  model: string
  /** Call-site identifier, if the call was made via `runStructured`. */
  callSiteId?: string
  /** Caller-supplied domain metadata (opaque; never branch on contents). */
  metadata: CallMetadata
  /** Wall-clock time from call start to success, in milliseconds. */
  latencyMs: number
  /** Token usage for this call. */
  usage: Usage
  /** Cost in micro-USD (absent when model is not in the pricing table). */
  cost?: Cost
  /**
   * What every attempt of the call cost, as far as the library could price it
   * (see {@link CallCost}): `cost` is the successful attempt alone. Absent only
   * when no attempt ran. `unpricedAttempts > 0` makes `microUsd` a lower bound.
   */
  callCost?: CallCost
}

/**
 * Event emitted when a logical LLM call fails (after all retries exhausted).
 *
 * @remarks
 * `metadata` carries the caller's domain anchors as high-cardinality attributes.
 * Suitable for log fields and OTel span tags; do NOT promote arbitrary keys to
 * metric labels (cardinality risk).
 */
export interface CallErrorEvent {
  /** Stable call identifier (matches persisted record). */
  callId: string
  /**
   * Attempt identifier of the last failing attempt.
   * Absent when a middleware threw before any attempt ran (no attempt executed,
   * so there is nothing to reference). When set, identifies the attempt that
   * ran; the sink is fail-open so the persisted row may be absent if the
   * write failed.
   */
  attemptId?: string
  /** Provider identifier, sourced from `req.provider`. */
  provider: string
  /** Model string as supplied by the caller. */
  model: string
  /** Call-site identifier, if the call was made via `runStructured`. */
  callSiteId?: string
  /** Caller-supplied domain metadata (opaque; never branch on contents). */
  metadata: CallMetadata
  /** Wall-clock time from call start to final failure, in milliseconds. */
  latencyMs: number
  /** The error kind that caused the failure. */
  errorKind: LlmErrorKind
  /** Typed reason within `errorKind`, when the error carries one. */
  reason?: LlmErrorReason
  /** Whether the error was considered retryable. */
  retryable: boolean
  /**
   * Token usage of the last failing attempt, when the provider reported one (a
   * billed failure such as an HTTP 200 with no usable output). Absent when the
   * failure carried no usage.
   */
  usage?: Usage
  /** Cost of that attempt's usage, when `usage` is present and a pricing source exists. */
  cost?: Cost
  /**
   * What every attempt of the call cost, as far as the library could price it
   * (see {@link CallCost}). Absent when no attempt ran. `unpricedAttempts > 0`
   * makes `microUsd` a lower bound.
   */
  callCost?: CallCost
}

/**
 * Optional observability hook for Sentry / PostHog / OpenTelemetry integration.
 *
 * All methods are optional so hosts can implement only what they need.
 * Telemetry failures are swallowed by the engine (fail-open): a hook that
 * throws, and a hook that returns a promise that rejects (an `async` hook),
 * are both absorbed and logged once at `debug` as `llm.hook.failed`. The engine
 * never awaits a hook, so a slow one does not slow a call.
 *
 * @remarks
 * `onStart`, `onSuccess` and `onError` fire once per logical call; `onAttempt`
 * fires once per provider attempt. The `metadata` field on each event carries
 * caller domain anchors as high-cardinality attributes — suitable for log fields and OTel span tags, but implementers
 * MUST NOT promote arbitrary metadata keys to metric labels (cardinality risk).
 */
export interface Telemetry {
  /**
   * Called immediately before the middleware chain runs (once per logical call).
   * May return an opaque span handle that is forwarded to `onSuccess` / `onError`.
   */
  onStart?(e: CallStartEvent): unknown
  /**
   * Called once per provider attempt, after its ledger row was handed to the sink
   * (success or failure), before the call settles. Retries, billed failures and
   * the final attempt each get one event.
   * @param e - Attempt event with usage, cost and, on failure, the error kind.
   * @param span - The opaque span returned by `onStart`, if any.
   */
  onAttempt?(e: AttemptEvent, span?: unknown): void
  /**
   * Called after a successful call (adapter returned, record persisted).
   * @param e - Success event with usage, cost, and latency.
   * @param span - The opaque span returned by `onStart`, if any.
   */
  onSuccess?(e: CallSuccessEvent, span?: unknown): void
  /**
   * Called when the call throws an `LlmError` (after all retries exhausted).
   * @param e - Error event including `kind` and `retryable`.
   * @param span - The opaque span returned by `onStart`, if any.
   */
  onError?(e: CallErrorEvent, span?: unknown): void
}

// ---------------------------------------------------------------------------
// Middleware seam
// ---------------------------------------------------------------------------

/**
 * Engine execution context passed through the middleware chain.
 *
 * Contains only the stable, call-level fields every middleware needs.
 * The `signal` here is the caller's abort signal merged with the logical-call
 * deadline (`config.timeoutMs`, which starts when the call starts), so
 * middleware that waits or does I/O should honour it. It is NOT the
 * per-attempt signal: the engine adds each attempt's own timeout inside
 * `runAttempt`. The deadline aborts it as soon as no attempt is in flight:
 * at the deadline when none is, otherwise when the attempt in flight ends
 * without a result.
 */
export interface EngineCtx {
  /** Unique ID for this logical call (stable across retries). */
  callId: string
  /** Time source injected from the client config. */
  clock: Clock
  /** Timer source injected from the client config; waits go through it. */
  scheduler: Scheduler
  /** Structured logger injected from the client config. */
  logger: Logger
  /**
   * Caller-supplied abort signal merged with the logical-call deadline (does
   * NOT include per-attempt timeouts).
   */
  signal?: AbortSignal
  /**
   * When the logical-call deadline ends, on {@link EngineCtx.clock}'s scale
   * (`clock.now() + config.timeoutMs` at the moment the call started). Absent
   * when no `timeoutMs` is set. Middleware that sleeps or retries measures its
   * budget against this, never against the time it was entered, so time spent
   * in middleware before it counts.
   */
  deadlineAt?: number
}

/**
 * The innermost handler in the middleware chain.
 *
 * The engine's `runAttempt` function satisfies this type.  Each invocation
 * generates a fresh `attemptId` and sinks exactly one record.
 */
export type Handler = (req: ResolvedRequest, ctx: EngineCtx) => Promise<LlmResult>

/**
 * A unit of logic that wraps the call chain.
 *
 * Middleware is composed outermost-first: the first element in the array is
 * the first to receive the request and the last to see the response.
 *
 * Calling `next(req, ctx)` zero times short-circuits the chain.
 * Calling it once is the normal passthrough.
 * Calling it multiple times (with or without delay) implements retry patterns.
 *
 * **Contract (ADR-037).**
 *
 * - **Middleware cannot reroute.** The `next` a middleware receives refuses a
 *   request whose `provider` or `model` differs from the call's: the call fails
 *   with `LlmError('bad_request')`, as the offender calls `next`, before any
 *   inner middleware or the provider runs, and a zero-usage refusal row is
 *   written (`attemptNumber: 0` when no attempt had run yet, otherwise the
 *   refused attempt's number). The engine routes, validates config,
 *   prices and authenticates with the identity it recorded at call start and
 *   never reads `provider`, `model` or `modelDescriptor` from the request a
 *   middleware passes on. To use another provider or model, catch the error in
 *   the host and make a new call.
 * - **Treat the request as immutable once passed to `next`.** To change data
 *   (config, messages, metadata), pass a new object to `next`. The engine does
 *   not copy or freeze requests, so mutating nested data in place after
 *   calling `next` is a host bug the engine cannot detect.
 * - **`callId` is the engine's.** The engine writes rows, results and events
 *   with the id it minted for the call, whatever `ctx.callId` a middleware
 *   passes down.
 * - **A result a middleware discards is still the call's result at the
 *   deadline.** If a middleware drops what `next` returned and keeps running
 *   past `timeoutMs` while no attempt is in flight, the deadline hands the
 *   call the last result an attempt produced; a middleware that wants to
 *   replace a result must return its replacement before then. The stock
 *   middleware never does this.
 * - **Order decides what a middleware counts.** Outermost runs first. A
 *   middleware outside `retryMiddleware` runs once per logical call; one inside
 *   it runs once per attempt. A quota unit taken by a middleware outside a
 *   rejected offender is not refunded.
 */
export interface Middleware {
  /**
   * Stable, unique identifier for this middleware.
   * Validated for uniqueness at `createClient` construction time.
   */
  id: string
  /**
   * Built-in role marker, set only by the first-party factories
   * (`retryMiddleware` sets `'retry'`, `providerQuotaMiddleware` sets
   * `'quota'`). `createClient` reads it, never the `id`, to reject a client
   * that places a quota middleware outside (before) a retry middleware: quota
   * accounts one unit per provider dispatch, which needs it inside retry.
   * Host middleware leaves it unset; a wrapper or composed middleware that
   * does not carry the inner one's role is not detected by that check.
   */
  readonly role?: 'retry' | 'quota'
  /**
   * Intercept a request.  Call `next(req, ctx)` to proceed to the next layer.
   *
   * @param req - The resolved request. Forward it, or pass a new object with
   *   changed data to `next`; never change `provider` or `model` (see the
   *   contract above).
   * @param ctx - Stable call-level context (callId, clock, logger, signal).
   * @param next - The next handler in the chain; the innermost is `runAttempt`.
   */
  intercept(req: ResolvedRequest, ctx: EngineCtx, next: Handler): Promise<LlmResult>
}

// ---------------------------------------------------------------------------
// Re-export LlmError so consumers of ports.ts don't need a separate import
// ---------------------------------------------------------------------------
export type { LlmError }
