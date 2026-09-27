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
  CallMetadata,
  Cost,
  Citation,
  ToolDefinition,
  ToolChoice,
} from './types.js'
import type { LlmCallRecord } from './record.js'
import type { LlmError, LlmErrorKind } from './errors.js'
import type { ModelDescriptor } from './registry.js'

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
  /** Final model identifier (after any alias resolution). Forwarded verbatim to the SDK/CLI. */
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
   * Internal-use field set by the retry middleware (the type is exported, but consumers should
   * not set this; it is overwritten per attempt and never persisted). Carries the shrinking
   * per-attempt budget so the engine can arm the AbortSignal correctly while leaving
   * `config.timeoutMs` equal to the caller's original value in the audit record.
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
   */
  accuracy: 'exact' | 'lower-bound'
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
export type Release = () => void

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
 * engine guarantees this.  A broken (throwing) Release is swallowed by the
 * engine so it does not mask the real result or error.
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
   *                 If it fires while waiting, reject immediately.
   * @returns A {@link Release} that MUST be called exactly once after the
   *          acquire resolves, on every exit path.
   */
  acquire(key: string, signal?: AbortSignal): Promise<Release>
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
   * Record a completed call.
   * Implementations should be idempotent on `attemptId` (e.g. `onConflictDoNothing`).
   */
  record(r: LlmCallRecord): Promise<void>
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
  /** True when `model` resolves to a priced entry via the same exact/prefix rules as `price()`. */
  hasModel(model: string): boolean
  /** All model keys this source can price (exact-match keys only, not derived prefixes). */
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
 */
export interface Clock {
  /** Returns the current time as milliseconds since the Unix epoch. */
  now(this: void): number
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
  /** Whether the error was considered retryable. */
  retryable: boolean
}

/**
 * Optional observability hook for Sentry / PostHog / OpenTelemetry integration.
 *
 * All methods are optional so hosts can implement only what they need.
 * Telemetry failures are swallowed by the engine (fail-open).
 *
 * @remarks
 * Events fire once per logical call (not per retry attempt). The `metadata`
 * field on each event carries caller domain anchors as high-cardinality
 * attributes — suitable for log fields and OTel span tags, but implementers
 * MUST NOT promote arbitrary metadata keys to metric labels (cardinality risk).
 */
export interface Telemetry {
  /**
   * Called immediately before the middleware chain runs (once per logical call).
   * May return an opaque span handle that is forwarded to `onSuccess` / `onError`.
   */
  onStart?(e: CallStartEvent): unknown
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
 * The `signal` here is the raw caller abort signal — NOT the per-attempt
 * combined (caller + timeout) signal.  The engine adds the timeout signal
 * inside `runAttempt` for each attempt independently.
 */
export interface EngineCtx {
  /** Unique ID for this logical call (stable across retries). */
  callId: string
  /** Time source injected from the client config. */
  clock: Clock
  /** Structured logger injected from the client config. */
  logger: Logger
  /** Caller-supplied abort signal (does NOT include per-attempt timeouts). */
  signal?: AbortSignal
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
 */
export interface Middleware {
  /**
   * Stable, unique identifier for this middleware.
   * Validated for uniqueness at `createClient` construction time.
   */
  id: string
  /**
   * Intercept a request.  Call `next(req, ctx)` to proceed to the next layer.
   *
   * @param req - The resolved request (may be forwarded or modified).
   * @param ctx - Stable call-level context (callId, clock, logger, signal).
   * @param next - The next handler in the chain; the innermost is `runAttempt`.
   */
  intercept(req: ResolvedRequest, ctx: EngineCtx, next: Handler): Promise<LlmResult>
}

// ---------------------------------------------------------------------------
// Re-export LlmError so consumers of ports.ts don't need a separate import
// ---------------------------------------------------------------------------
export type { LlmError }
