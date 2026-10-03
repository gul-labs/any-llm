/**
 * Engine for @gullabs/core — the heart of the library.
 *
 * {@link createClient} wires together all port implementations and returns a
 * `{ generate, runStructured }` client.  Every LLM call goes through the same
 * 12-step pipeline (config resolution → adapter → normalize → validate → cost
 * → record → result), ensuring consistent observability and fail-open side
 * effects regardless of call path.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import {
  LlmError,
  classifyError,
  normalizeSchemaIssues,
  toErrorIssues,
} from './errors.js'
import type { LlmErrorIssue, NormalizedSchemaIssue } from './errors.js'
import { buildRecord, normalizeUsage } from './record.js'
import { providerCostDriftWarning } from './cost.js'
import { assertMessagesShape, assertPartsShape } from './input-shapes.js'
import { assertTimerMs } from './timer.js'
import { estimateInputTokens } from './estimate.js'
import { redactSecrets } from './redact.js'
import {
  buildPayload,
  describePayloadError,
  isThenable,
  PayloadDropped,
  resolvePayloadsConfig,
  snapshotPayloadSource,
} from './payload.js'
import type { BuildControl, LlmCallPayload, PayloadsConfig } from './payload.js'
import { boundedModelText, unknownModelMessage } from './registry.js'
import type { ModelDescriptor, ModelRegistry } from './registry.js'
import type {
  ProviderAdapter,
  AdapterResult,
  AuthMaterial,
  PricingSource,
  UsageSink,
  Clock,
  Scheduler,
  TimerHandle,
  IdGenerator,
  Logger,
  Telemetry,
  RateLimiter,
  RateLimitHint,
  Release,
  ResolvedRequest,
  AdapterCtx,
  Middleware,
  EngineCtx,
  Handler,
  CallStartEvent,
  CallSuccessEvent,
  AttemptEvent,
  CallErrorEvent,
  TokenCountRequest,
  TokenCount,
} from './ports.js'
import type {
  LlmRequest,
  LlmResult,
  CallCost,
  GenConfig,
  CallMetadata,
  JsonValue,
  Message,
  Part,
  Usage,
  Warning,
  Cost,
} from './types.js'
import { isToolCallPart, isToolResultPart } from './types.js'
import type { CallSite } from './callsite.js'
import type { StandardSchemaV1 } from './standard-schema.js'

// ---------------------------------------------------------------------------
// Public config types
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link createClient}.
 */
export interface ClientConfig {
  /**
   * One or more provider adapters.  Routing is always by `request.provider` →
   * `adapterMap.get(provider)` (via the default router or a custom `route`);
   * there is no single-adapter bypass.
   */
  adapters: ProviderAdapter[]
  /**
   * Per-provider pricing sources, keyed by provider id (e.g. `{ google: geminiPricingSource() }`).
   * The engine selects the source via `request.provider`; a provider with no
   * configured source yields absent cost + an "unpriced" warning (fail-open),
   * never a crash.
   */
  pricingSources?: Record<string, PricingSource>
  /**
   * Opt-in construction-time pricing integrity check.
   *
   * When true, `createClient()` walks the configured model registry and throws
   * if any registered model has no entry in its provider's configured pricing
   * source. Runtime pricing remains fail-open; this guard is deliberately only
   * at construction time.
   */
  strictPricing?: boolean
  /**
   * Where completed call records are persisted.
   * Failures are logged and swallowed (fail-open) — a broken sink must never
   * fail the LLM call.
   */
  sink?: UsageSink
  /**
   * Longest the engine waits for one `sink.record` call, in milliseconds.
   * Must be a finite number greater than 0 and at most 2147483647 (a longer
   * timer would fire after 1 ms), else `bad_request`.
   *
   * A sink that has not settled by then is abandoned: the engine logs
   * `llm.call.sink.timeout` at `error` (with `callId`, `attemptId`,
   * `attemptNumber`, `provider`, `model`, `timeoutMs`) and goes on. The call's
   * result or error is returned or thrown unchanged, and the row may or may
   * not be written later. A stalled database must not stall an LLM call that
   * has already been billed.
   *
   * The wait also ends 100 ms after the caller aborts or the call deadline
   * (`timeoutMs`) passes, whichever of those comes first, logged at `error` as
   * `llm.call.sink.interrupted` with the same fields (plus `graceMs`): a hung
   * sink does not hold an abort or a deadline for the whole `sinkTimeoutMs`,
   * and a healthy sink still has 100 ms to land its row.
   * @default 5000
   */
  sinkTimeoutMs?: number
  /**
   * Opt-in storage of each attempt's prompt and response text (ADR-038).
   * Absent: nothing is captured. Present: every attempt that reached dispatch,
   * success or failure, gets a payload (the request the adapter received, the
   * raw model text or the error message) passed to the sink as
   * `sink.record(record, { payload })`, unless `include` returns anything but
   * `true` or the call opts out with `storePayload: false` (an option of both
   * `generate` and `runStructured`). Requires {@link ClientConfig.sink}, else
   * `createClient` throws `bad_request`.
   *
   * Payloads can contain customer data. Every string is bounded and run
   * through core's secret patterns, then `payloads.redact`, before the size
   * caps; retention and deletion are the host's duty. The request is
   * snapshotted at dispatch and the payload is built after the attempt's
   * outcome is known, inside the `sinkTimeoutMs` budget. A payload that cannot
   * be built (a throwing redactor, an over-long build) is dropped with an
   * `llm.call.payload.dropped` warning and never fails the call. The sink must
   * set `acceptsPayloads: true`; otherwise `createClient` warns once and no
   * payload is built.
   *
   * These options govern the payload only. The `llm_calls` record separately
   * carries the model's tool-call arguments, reasoning text, error message and
   * your `metadata`, redacted by core's patterns (see the README table).
   */
  payloads?: PayloadsConfig
  /**
   * Time source.  Defaults to `{ now: () => Date.now() }`.
   * Inject {@link FakeClock} in tests for deterministic latency assertions.
   *
   * It stamps records and measures latencies, and the call deadline
   * (`config.timeoutMs`) is measured on it too, so a clock that does not
   * advance in real time (a frozen one) leaves middleware time uncounted.
   * The timers that enforce the deadline come from {@link ClientConfig.scheduler}
   * (real, monotonic timers by default).
   */
  clock?: Clock
  /**
   * Timer source for every wait the engine owns: the attempt timeout, the
   * logical-call deadline, the sink waits. It is also given to the middleware
   * (`EngineCtx.scheduler`, which `retryMiddleware` sleeps on) and to adapters
   * (`AdapterCtx.scheduler`). Defaults to the platform's `setTimeout` and
   * `clearTimeout`. `FakeClock` from `@gullabs/testing` implements it, so a test
   * drives timeouts, deadlines and back-off by advancing one clock.
   *
   * It must run the callback after at least `ms` milliseconds on the scale of
   * {@link ClientConfig.clock}: the deadline is read off the clock and enforced
   * by these timers, so a scheduler that runs on a different scale than the
   * clock makes `expired()` and the timer disagree.
   */
  scheduler?: Scheduler
  /**
   * Unique ID generator.  Defaults to `crypto.randomUUID()`.
   * Inject {@link FakeIds} in tests for deterministic record assertions.
   */
  ids?: IdGenerator
  /**
   * Structured logger.  Defaults to a no-op implementation.
   * Canonical event names: `llm.call.start`, `llm.call.success`, `llm.call.error`.
   */
  logger?: Logger
  /**
   * Optional observability hook (Sentry / PostHog / OTel).
   * All callbacks are optional; failures are swallowed (fail-open).
   */
  telemetry?: Telemetry
  /**
   * Pre-send pacing / backpressure implementation.
   *
   * Called with key `"${provider}:${model}"` before the adapter is invoked.
   * A rejection from `acquire` propagates (NOT fail-open) — the call fails.
   *
   * `acquire` must honour the `signal` it is given and reject when it fires.
   * If a timeout or an abort wins while `acquire` is still pending, the engine
   * calls the `Release` that `acquire` resolves with later, so a slot is not
   * leaked, but a limiter that ignores the signal still holds its slot until
   * then.
   *
   * Defaults to a no-op limiter ({@link NOOP_RATE_LIMITER}) that resolves
   * immediately with a no-op Release.
   */
  rateLimiter?: RateLimiter
  /**
   * Library-level generation defaults.
   * Merged under call-site config and per-call config (lowest priority).
   */
  defaults?: GenConfig
  /**
   * Custom adapter router.
   * Receives the request's `provider`, `model`, and the full adapter list;
   * returns the adapter to use.  Defaults to matching `provider` against the
   * configured adapters' `id`s; no match → throws `LlmError('bad_request')`.
   *
   * **Post-route invariant:** regardless of whether the default or a custom
   * router is used, the engine asserts `adapter.id === request.provider`
   * after routing and throws `LlmError('bad_request')` on mismatch — a
   * custom router can pick among same-provider adapters but can never cross
   * providers.
   */
  route?(
    this: void,
    provider: string,
    model: string,
    adapters: ProviderAdapter[],
  ): ProviderAdapter
  /**
   * Model registry used to resolve per-model config schemas and pricing keys.
   *
   * **Required.** Core ships with no default registry — it has zero
   * provider/model knowledge. Supply one via a provider package's plugin,
   * e.g. `createClient({ ...composeProviders([googleProvider()]), ... })`
   * (`composeProviders` from `@gullabs/core`, `googleProvider` from
   * `@gullabs/google`), or build a custom `ModelRegistry` with
   * `createModelRegistry` for bespoke/multi-provider setups.
   *
   * **Construction-time invariant:** every descriptor's `provider` must match
   * a configured adapter's `id`, else `createClient` throws.
   */
  modelRegistry: ModelRegistry
  /**
   * Ordered middleware stack applied to every call, outermost-first.
   *
   * The first element is the outermost (first to receive the request, last to
   * see the response).  The engine's `runAttempt` function is the innermost
   * handler.
   *
   * Each middleware's `id` must be unique across the array; `createClient`
   * throws `LlmError('bad_request')` on duplicates.
   *
   * @example
   * ```ts
   * middleware: [retryMiddleware({ maxAttempts: 3 })]
   * ```
   */
  middleware?: Middleware[]
  /**
   * Opt-in fleet-wide strict mode (D4): when `true`, every call is required
   * to carry an input contract.
   *
   * - `generate()` refuses any request whose `inputContract` (D3) is absent.
   *   The existing prologue checks (provider presence, model registration,
   *   `validateResolvedConfig`) run first and win — a request that is both
   *   missing its contract and misconfigured fails with the existing
   *   prologue error, row-less, exactly as today. The missing-contract
   *   refusal itself happens inside `runPipeline`, immediately after
   *   `callId` allocation — post-`callId`, so it writes a ledger row (D5).
   * - `runStructured` refuses any call whose `callSite.inputSchema` (D2) is
   *   absent. This is the FIRST check in the `runStructured` prologue —
   *   before D2 validation, D1 interpolation, and request building.
   *   Row-less (pre-`callId`).
   *
   * Both refusals throw `LlmError('bad_request')`, not retryable, naming
   * the option and the missing contract.
   *
   * Default: absent (off). `countTokens` is unaffected — it dispatches no
   * generation and spends no tokens producing output.
   */
  requireInputContract?: boolean
}

/**
 * Options accepted by {@link Client.generate}.
 */
export interface GenerateOptions {
  /** API key credentials for this call. Required on every call. */
  auth: AuthMaterial
  /** Caller-supplied abort signal. Classifies as `'aborted'` when fired. */
  signal?: AbortSignal
  /**
   * `false` opts this call out of payload storage (`ClientConfig.payloads`).
   * `true` or absent follows the client config; `true` never turns storage on
   * for a client that did not enable it. Any other value is `bad_request`.
   */
  storePayload?: boolean
}

/**
 * Options accepted by {@link Client.countTokens}.
 */
export interface CountTokensOptions extends Omit<GenerateOptions, 'storePayload'> {
  /**
   * Ceiling for the whole count, in milliseconds (a finite number greater
   * than 0 and at most 2147483647, else `bad_request`). When it passes, the call rejects with `LlmError('timeout')` even
   * if the adapter ignores the abort signal. There is no default: without it
   * the count runs until the adapter settles or the caller aborts.
   */
  timeoutMs?: number
}

/**
 * Options accepted by {@link Client.runStructured}.
 */
export interface RunStructuredOptions {
  /** API key credentials for this call. Required on every call. */
  auth: AuthMaterial
  /**
   * Per-call generation config override.
   * Wins over call-site defaults; loses to nothing.
   */
  config?: GenConfig
  /** Caller-supplied abort signal. Classifies as `'aborted'` when fired. */
  signal?: AbortSignal
  /** Per-call metadata anchors merged into the persisted record. */
  metadata?: CallMetadata
  /**
   * Caller-owned correlation id persisted on every attempt row of the call, as
   * {@link LlmRequest.externalId} does for `generate`. Give every host-level
   * retry of one operation the same value.
   */
  externalId?: string
  /**
   * Parts appended to the rendered user message, after its text: a file, an
   * image, audio. The rendered text part is omitted when the template renders
   * to the empty string or whitespace only, so the message may be attachments
   * only. An empty array is the same as none. Each element must be a part
   * object of a known `kind` (else `bad_request` naming `attachments[i]`).
   * `tool-call` and `tool-result` parts are `bad_request`: a call site declares
   * no tools. Media types are checked against the model by the adapter before
   * dispatch.
   */
  attachments?: Part[]
  /**
   * Earlier conversation turns, prepended before the rendered user message and
   * sent unchanged, so a follow-up call can continue a text or media
   * conversation from a call site. Each element must be a `{ role, parts }`
   * message of known part kinds (else `bad_request` naming `history[i]`), with
   * the same checks as `LlmRequest.messages` (no empty assistant message).
   * `tool-call` and `tool-result` parts are `bad_request`: a call site declares
   * no tools, so a tool loop belongs to `generate`. History is not rewritten:
   * a history that ends in a user message is followed by the rendered user
   * message as a second consecutive user turn; turns are never merged.
   */
  history?: Message[]
  /**
   * Opaque continuation state from the previous result, passed back exactly as
   * for {@link LlmRequest.transientProviderState}: only models that declare
   * `capabilities.providerState` admit it (any other model is `bad_request`),
   * and it is never persisted. It lets a follow-up structured call reuse what
   * the provider returned with the earlier result (for example reasoning state)
   * alongside `history`; it does not make a call site a tool loop.
   */
  transientProviderState?: JsonValue
  /**
   * `false` opts this call out of payload storage, as
   * {@link GenerateOptions.storePayload} does for `generate`.
   */
  storePayload?: boolean
}

/**
 * The client returned by {@link createClient}.
 */
export interface Client {
  /**
   * Execute a single LLM call described by an {@link LlmRequest}.
   *
   * Config resolution: `clientDefaults → request.config`.
   * `opts.auth` is required on every call — the library never reads credentials
   * from the environment.
   *
   * @returns An {@link LlmResult} on success. Rejects only with {@link LlmError}:
   * anything else thrown on the way (a host registry, a middleware, a bug) is
   * classified, with the original kept as `cause`.
   */
  generate(request: LlmRequest, opts: GenerateOptions): Promise<LlmResult>

  /**
   * Execute an LLM call described by a {@link CallSite} with per-call overrides.
   *
   * Config resolution: `clientDefaults → callSite.config → opts.config`.
   * `opts.auth` is required on every call.
   *
   * @returns An {@link LlmResult}; callers validate `output` when present.
   */
  runStructured(callSite: CallSite, opts: RunStructuredOptions): Promise<LlmResult>

  /**
   * Execute an LLM call described by a {@link CallSite} with template variables
   * and per-call overrides.
   *
   * Config resolution: `clientDefaults → callSite.config → opts.config`.
   * Template interpolation: `{{var}}` in `system` and `userTemplate` is
   * replaced with the corresponding value from `vars`.  Var values are NOT
   * themselves interpolated (anti-injection).  Strict: every `{{var}}`
   * placeholder referenced by either template must have a string-typed value
   * present in `vars`, or the call is refused before any request is built
   * (`LlmError('bad_request')`, not retryable, one `issues` entry per
   * violating placeholder).  Extra `vars` entries unused by any template are
   * allowed.  If `callSite.inputSchema` is set, `vars` is validated against
   * it first — a missing/invalid field surfaces as the schema's own error,
   * not a downstream unresolved-placeholder violation.
   * `opts.auth` is required on every call.
   *
   * @returns An {@link LlmResult}; callers validate `output` when present.
   */
  runStructured(
    callSite: CallSite,
    vars: Record<string, string>,
    opts: RunStructuredOptions,
  ): Promise<LlmResult>

  /**
   * Count tokens for a prospective request without generating.
   * Same auth/signal semantics as {@link generate}, plus an optional
   * `timeoutMs` (a finite number greater than 0 and at most 2147483647, else
   * `bad_request`). Caller abort and the timeout end the call even when the
   * adapter ignores its signal; a signal that is already aborted rejects
   * without calling the adapter. Throws `LlmError('bad_request')` when the
   * (provider, model) pair is not registered, or when the resolved adapter
   * does not implement `countTokens`.
   */
  countTokens(request: TokenCountRequest, opts: CountTokensOptions): Promise<TokenCount>
}

// ---------------------------------------------------------------------------
// Internal constants / defaults
// ---------------------------------------------------------------------------

/** Longest the engine waits for one `sink.record`, unless `sinkTimeoutMs` says otherwise. */
const DEFAULT_SINK_TIMEOUT_MS = 5000

/**
 * How much longer a `sink.record` is awaited once the caller aborted or the
 * call deadline passed. A healthy sink finishes inside it, so an aborted call
 * still lands its row; a hung sink no longer holds the abort or the deadline
 * for the whole `sinkTimeoutMs`.
 */
const SINK_INTERRUPT_GRACE_MS = 100

const NOOP_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
}

/** The same cost, reported as `'estimated'`. */
function markEstimated(cost: Cost): Cost {
  return cost.confidence === 'estimated' ? cost : { ...cost, confidence: 'estimated' }
}

/**
 * Wraps a {@link Logger} so that any thrown error from a log method is silently
 * swallowed.  A host logger that throws must NEVER break or mask an LLM call.
 */
function makeSafeLogger(logger: Logger): Logger {
  return {
    info(o: object, m: string): void {
      try {
        logger.info(o, m)
      } catch {}
    },
    warn(o: object, m: string): void {
      try {
        logger.warn(o, m)
      } catch {}
    },
    error(o: object, m: string): void {
      try {
        logger.error(o, m)
      } catch {}
    },
    debug(o: object, m: string): void {
      try {
        logger.debug(o, m)
      } catch {}
    },
  }
}

const NOOP_TELEMETRY: Telemetry = {}

/**
 * A no-op {@link RateLimiter} that resolves immediately with a no-op Release.
 * Used when no `rateLimiter` is configured in {@link ClientConfig}.
 */
const NOOP_RATE_LIMITER: RateLimiter = {
  acquire(_key: string, _signal?: AbortSignal): Promise<Release> {
    return Promise.resolve(() => {})
  },
}

const DEFAULT_IDS: IdGenerator = {
  callId: () => randomUUID(),
  attemptId: () => randomUUID(),
}

const DEFAULT_CLOCK: Clock = {
  now: () => Date.now(),
}

const DEFAULT_SCHEDULER: Scheduler = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  },
}

/** Sentinel empty usage for error-path records when the adapter never returned. */
const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  details: {},
  raw: null,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Whether a failed attempt that reported no usage is known to have cost nothing.
 *
 * True when nothing was dispatched (the attempt ended while it still waited for
 * the rate limiter), when the failure is one providers do not bill (`bad_request`,
 * `invalid_auth`, `rate_limited`), or when the provider answered with an HTTP
 * error status that is not a timeout or abort. False for a timeout or abort after
 * dispatch, and for a failure that carried no status (a connection reset, an
 * unknown failure): the provider may have run, and billed, the request.
 */
function failedAttemptCostsNothing(err: LlmError, dispatched: boolean): boolean {
  if (!dispatched) return true
  switch (err.kind) {
    case 'bad_request':
    case 'invalid_auth':
    case 'rate_limited':
      return true
    case 'timeout':
    case 'aborted':
      return false
    default:
      return err.httpStatus !== undefined
  }
}

/**
 * {@link classifyError}, except that a value that is the abort signal's own
 * reason is an abort. A cooperative adapter or middleware that rejects with
 * `signal.reason` (a host cancellation error, any custom `Error`) is reporting
 * the abort it was handed, and `classifyError` alone would call that `unknown`.
 * The reason is kept as `cause`. An `LlmError` reason (the deadline's
 * `timeout`) already passes through `classifyError` unchanged.
 */
function classifyThrown(rawErr: unknown, signal: AbortSignal | undefined): LlmError {
  if (
    !(rawErr instanceof LlmError) &&
    rawErr !== undefined &&
    signal?.aborted === true &&
    rawErr === signal.reason
  ) {
    return new LlmError('Request aborted by caller', {
      kind: 'aborted',
      retryable: false,
      cause: rawErr,
    })
  }
  return classifyError(rawErr)
}

/**
 * The error for a signal that is already aborted: its reason when that is an
 * `LlmError` (the deadline's `timeout`), else an `aborted` error carrying the
 * reason as `cause`.
 */
function abortedError(signal: AbortSignal): LlmError {
  const reason: unknown = signal.reason
  if (reason instanceof LlmError) return reason
  return new LlmError('Request aborted by caller', {
    kind: 'aborted',
    retryable: false,
    ...(reason !== undefined ? { cause: reason } : {}),
  })
}

/** Matches every `{{name}}` placeholder recognised by {@link interpolate}. */
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g

/**
 * Non-recursive `{{var}}` template interpolation.
 *
 * Replacement values are substituted verbatim — they are NOT re-scanned for
 * further `{{...}}` patterns, preventing template-injection attacks where a
 * user-supplied value could expand to another placeholder.
 *
 * Total over its inputs: callers MUST run {@link assertTemplateVarsResolved}
 * first so every placeholder this regex recognises is guaranteed present in
 * `vars` with a string value. There is no leave-placeholder fallback — an
 * unresolved placeholder is a caller-fault error caught upstream, not a
 * silently-degraded render.
 */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_match, key: string) => vars[key] as string)
}

/**
 * Collects every distinct `{{name}}` placeholder referenced by `text` into
 * `out`.
 */
function collectPlaceholders(text: string, out: Set<string>): void {
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const key = match[1]
    if (key !== undefined) out.add(key)
  }
}

/**
 * D1 — strict template-interpolation guard.
 *
 * Collects every `{{\w+}}` placeholder referenced across `templates`
 * (typically a call site's `userTemplate` and `system`). Each placeholder's
 * key must be present in `vars` AND `typeof vars[key] === 'string'` — `null`,
 * `undefined`, and any non-string value (numbers, objects — off the
 * `Record<string, string>` type but reachable from untyped callers) are
 * violations, never coerced (reject, don't map).
 *
 * `vars` entries unused by any template are allowed: a shared context bag
 * across call sites whose templates use different subsets is a legitimate
 * pattern, and an unused variable cannot corrupt the rendered prompt.
 *
 * On violation, throws `LlmError('bad_request')`, not retryable, naming the
 * call site id and every violating placeholder, with one `issues` entry per
 * placeholder (`path` = the placeholder name). A call site with no templates
 * (or templates with no `{{...}}` placeholders) is a no-op.
 */
function assertTemplateVarsResolved(
  callSiteId: string,
  templates: ReadonlyArray<string | undefined>,
  vars: Record<string, string>,
): void {
  const placeholders = new Set<string>()
  for (const template of templates) {
    if (template !== undefined) collectPlaceholders(template, placeholders)
  }
  if (placeholders.size === 0) return

  const violations: string[] = []
  for (const key of placeholders) {
    const hasKey = Object.prototype.hasOwnProperty.call(vars, key)
    const value = hasKey ? (vars as Record<string, unknown>)[key] : undefined
    if (!hasKey || typeof value !== 'string') {
      violations.push(key)
    }
  }
  if (violations.length === 0) return

  const issues: LlmErrorIssue[] = violations.map((name) => ({
    path: name,
    message: `Placeholder "{{${name}}}" has no string value in vars.`,
  }))
  throw new LlmError(
    `Call site "${callSiteId}" has unresolved template placeholder(s): ${violations
      .map((name) => `{{${name}}}`)
      .join(', ')}. Every "{{var}}" placeholder requires a string value in vars.`,
    { kind: 'bad_request', retryable: false, issues },
  )
}

/**
 * Returns `true` when `v` is a plain object (`{}` literal or `Object.create(null)`),
 * excluding Arrays, Dates, and other built-in object types.
 *
 * Used to decide whether two values should be recursively merged or whether
 * the right-hand side should win outright (last-write-wins for scalars and arrays).
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Recursively merges two plain objects, left-to-right.
 *
 * - Nested plain objects: merged recursively.
 * - Arrays and scalar values: last-write-wins (the `override` value replaces `base`).
 */
function deepMergePlain(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    const bv = base[key]
    const ov = override[key]
    if (isPlainObject(bv) && isPlainObject(ov)) {
      result[key] = deepMergePlain(bv, ov)
    } else {
      result[key] = ov
    }
  }
  return result
}

/**
 * Deep-merges {@link GenConfig} objects left-to-right (later entries win).
 *
 * Scalar fields (`temperature`, `topP`, etc.) use last-write-wins.
 * Object fields (`reasoning`, `providerOptions`) are recursively merged so a
 * per-call override can set individual sub-keys without replacing the entire
 * object (and without dropping sibling keys inside nested provider blocks).
 * Arrays and non-object values within those objects are last-write-wins.
 */
function deepMergeConfig(...configs: Array<GenConfig | undefined>): GenConfig {
  const acc: Record<string, unknown> = {}
  for (const cfg of configs) {
    if (cfg === undefined) continue
    const keys = Object.keys(cfg) as Array<keyof GenConfig>
    for (const key of keys) {
      const val = cfg[key]
      if (val === undefined) continue
      if (key === 'reasoning' && isPlainObject(val)) {
        const current = acc[key]
        acc[key] = deepMergePlain(isPlainObject(current) ? current : {}, val)
      } else if (key === 'providerOptions' && isPlainObject(val)) {
        const current = acc[key]
        acc[key] = deepMergePlain(isPlainObject(current) ? current : {}, val)
      } else {
        acc[key] = val
      }
    }
  }
  return acc
}

/**
 * Merges multiple AbortSignals into a single signal that fires when any input
 * fires.  Immediately resolved if any input is already aborted.
 * Returns both the merged signal and a cleanup function that removes all
 * registered event listeners to prevent leaks.
 */
function mergeSignals(signals: AbortSignal[]): {
  signal: AbortSignal
  cleanup(this: void): void
} {
  const controller = new AbortController()
  const cleanups: Array<() => void> = []
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort(sig.reason)
      return { signal: controller.signal, cleanup() {} }
    }
    const handler = () => {
      controller.abort(sig.reason)
    }
    sig.addEventListener('abort', handler, { once: true })
    cleanups.push(() => {
      sig.removeEventListener('abort', handler)
    })
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const fn of cleanups) fn()
    },
  }
}

/**
 * Default router: matches `provider` directly against the prebuilt adapter
 * map.  No derivation, no single-adapter bypass — routing is always by
 * `request.provider`.
 *
 * @throws {@link LlmError} `'bad_request'` when no matching adapter is found.
 */
function defaultRoute(
  provider: string,
  model: string,
  adapters: ProviderAdapter[],
  adapterMap: Map<string, ProviderAdapter>,
): ProviderAdapter {
  if (adapters.length === 0) {
    throw new LlmError('No adapters configured', {
      kind: 'bad_request',
      retryable: false,
    })
  }
  const found = adapterMap.get(provider)
  if (found === undefined) {
    throw new LlmError(`No adapter found for provider "${provider}" (model "${model}")`, {
      kind: 'bad_request',
      retryable: false,
    })
  }
  return found
}

// ---------------------------------------------------------------------------
// Pipeline helper: cancellation race
// ---------------------------------------------------------------------------

/**
 * Builds the cancellation scaffolding for a single pipeline invocation.
 *
 * Returns:
 *  - `raceParts`      — rejection promises to include in every `Promise.race`.
 *  - `combinedSignal` — merged abort signal forwarded to the adapter.
 *  - `cleanup()`      — idempotent; clears the timer and removes the
 *                       caller-abort listener.  Safe to call on both the
 *                       success path and the catch block.
 *
 * Invariant A (timeout-beats-abort microtask ordering):
 *   The timeout `setTimeout` callback rejects the timeout promise BEFORE
 *   calling `timeoutController.abort()`.  This guarantees `kind:'timeout'`
 *   wins `Promise.race` even against a synchronously-aborting adapter.
 *   Do not reorder the two operations inside the timer callback.
 */
function buildCancellationRace(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  scheduler: Scheduler,
): {
  raceParts: Array<Promise<never>>
  combinedSignal: AbortSignal | undefined
  cleanup(this: void): void
} {
  const raceParts: Array<Promise<never>> = []

  let timer: TimerHandle | undefined
  let callerAbortCleanup: (() => void) | undefined

  // ── (a) Caller-abort race promise ────────────────────────────────────────
  // adapter.run() is raced against a rejection promise that fires when
  // callerSignal fires, ensuring caller cancellation always terminates the
  // call even if the adapter ignores ctx.signal.  Already-aborted signals
  // are handled synchronously via a pre-rejected promise.
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      // Already aborted — pre-rejected promise settles the race immediately.
      raceParts.push(
        Promise.reject(
          new LlmError('Request aborted by caller', {
            kind: 'aborted',
            retryable: false,
            ...(callerSignal.reason !== undefined
              ? { cause: callerSignal.reason as unknown }
              : {}),
          }),
        ),
      )
    } else {
      // Not yet aborted — create a promise that rejects when the signal fires.
      let abortRejectFn!: (err: LlmError) => void
      const abortPromise = new Promise<never>((_, reject) => {
        abortRejectFn = reject
      })
      const abortHandler = () => {
        abortRejectFn(
          new LlmError('Request aborted by caller', {
            kind: 'aborted',
            retryable: false,
            ...(callerSignal.reason !== undefined
              ? { cause: callerSignal.reason as unknown }
              : {}),
          }),
        )
      }
      callerSignal.addEventListener('abort', abortHandler, { once: true })
      callerAbortCleanup = () => {
        callerSignal.removeEventListener('abort', abortHandler)
      }
      raceParts.push(abortPromise)
    }
  }

  // ── (b) Timeout race promise ──────────────────────────────────────────────
  // Determinism guarantee (Finding 2 / Invariant A):
  //   The timeout promise rejects BEFORE its AbortController is fired.
  //   This means even a signal-aware adapter that throws AbortError
  //   synchronously on the abort signal cannot win the race with kind:'aborted'
  //   when the real cause was a timeout.
  let timeoutController: AbortController | undefined
  if (timeoutMs !== undefined) {
    const controller = new AbortController()
    timeoutController = controller
    const ms = timeoutMs
    let timeoutRejectFn!: (err: LlmError) => void
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutRejectFn = reject
    })
    timer = scheduler.setTimeout(() => {
      // REJECT FIRST — schedules the 'timeout' LlmError into the microtask
      // queue before the abort signal fires.  This guarantees 'timeout' wins
      // Promise.race even when the adapter rejects synchronously on abort.
      timeoutRejectFn(
        new LlmError(`Request timed out after ${ms}ms`, {
          kind: 'timeout',
          retryable: true,
        }),
      )
      // Abort AFTER scheduling the rejection — cooperative adapters stop early.
      controller.abort()
    }, ms)
    raceParts.push(timeoutPromise)
  }

  // Build combined signal for cooperative adapters (caller + timeout merged).
  const signalParts: AbortSignal[] = []
  if (callerSignal !== undefined) signalParts.push(callerSignal)
  if (timeoutController !== undefined) signalParts.push(timeoutController.signal)

  let mergedSignalCleanup: (() => void) | undefined
  const combinedSignal: AbortSignal | undefined =
    signalParts.length === 0
      ? undefined
      : signalParts.length === 1
        ? signalParts[0]
        : (() => {
            const merged = mergeSignals(signalParts)
            mergedSignalCleanup = merged.cleanup
            return merged.signal
          })()

  // Idempotent cleanup — safe to call on both success and error paths.
  function cleanup(): void {
    if (timer !== undefined) {
      scheduler.clearTimeout(timer)
      timer = undefined
    }
    callerAbortCleanup?.()
    callerAbortCleanup = undefined
    mergedSignalCleanup?.()
    mergedSignalCleanup = undefined
  }

  return { raceParts, combinedSignal, cleanup }
}

// ---------------------------------------------------------------------------
// Pipeline helper: logical-call deadline
// ---------------------------------------------------------------------------

/** What {@link buildCallDeadline} hands the pipeline. */
interface CallDeadline {
  /** When the call must end, on the injected clock's scale. */
  deadlineAt: number | undefined
  /** The caller signal merged with the deadline; `EngineCtx.signal`. */
  signal: AbortSignal | undefined
  /**
   * Aborts when the deadline timer fires, whether or not an attempt is in
   * flight. Waits that are not attempts (a sink write) stop on it.
   */
  elapsed: AbortSignal | undefined
  /**
   * Settles the call at the deadline when no attempt is in flight: rejects with
   * the deadline error, or resolves with the result an attempt already
   * produced, so a slow or hung middleware after `next()` neither converts a
   * billed success into a timeout nor holds the call.
   */
  gate: Promise<LlmResult> | undefined
  /** True once the deadline has passed. */
  expired(this: void): boolean
  /** The error for a call that ran out of time (see {@link CallDeadline.gate}). */
  error(this: void): LlmError
  /** An attempt began; it enforces the deadline itself until it ends. */
  attemptStarted(this: void): void
  /** An attempt ended, with its result or `undefined` when it failed. */
  attemptEnded(this: void, result: LlmResult | undefined): void
  /** Idempotent; clears the timer and listeners. */
  cleanup(this: void): void
}

/**
 * Arms `timeoutMs` for the whole logical call, not only for each attempt, so
 * time spent in middleware (a quota deferral, a store round-trip) counts
 * against it. The deadline is measured on the injected clock, like every
 * ledger latency; the timer that enforces it is the scheduler's (a monotonic `setTimeout` by default), so a
 * wall-clock jump can only make `expired()` early or late, never leave the
 * call without its timer.
 *
 * While an attempt is in flight the deadline is that attempt's to enforce:
 * `runAttempt` arms its own timer for exactly the time that remains, records
 * the failure as its own ledger row, and lets that error travel up the chain.
 * Firing the gate then would replace the attempt's error with a second,
 * attempt-less one. So when the timer fires with an attempt in flight, the
 * gate waits, and fires one macrotask after the attempt ends (`attemptEnded`)
 * if the call is still pending: with the attempt's result when it produced one,
 * otherwise with the deadline error and an abort of `ctx.signal`. The pause
 * lets the attempt's own error (or result) reach the caller when the chain
 * passes it straight up; the gate bounds whatever runs after the attempt (an
 * outer middleware's `catch`, an error-reporting fetch, a hung `next()`
 * continuation). The gate rejects before the signal aborts, as in
 * {@link buildCancellationRace}, so `timeout` wins over any abort error a
 * cooperative middleware throws in reaction.
 *
 * `lastAttemptError` supplies the failure of the most recent attempt: the
 * deadline error carries it as `cause`, and when it is itself a `timeout` or is
 * retryable with a `retryAfterMs` it is the error surfaced, so neither a
 * provider delay nor the attempt's own row is lost to a synthetic timeout.
 */
function buildCallDeadline(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  clock: Clock,
  scheduler: Scheduler,
  lastAttemptError: () => LlmError | undefined,
): CallDeadline {
  if (timeoutMs === undefined) {
    return {
      deadlineAt: undefined,
      signal: callerSignal,
      elapsed: undefined,
      gate: undefined,
      expired: () => false,
      error: () =>
        new LlmError('Request timed out', { kind: 'timeout', retryable: true }),
      attemptStarted() {},
      attemptEnded() {},
      cleanup() {},
    }
  }
  const deadlineAt = clock.now() + timeoutMs
  const controller = new AbortController()
  const elapsedController = new AbortController()
  let settleGate!: { resolve(r: LlmResult): void; reject(e: LlmError): void }
  const gate = new Promise<LlmResult>((resolve, reject) => {
    settleGate = { resolve, reject }
  })
  // The gate can fire before `runPipeline` starts racing it; this keeps that
  // from being an unhandled rejection. The race still receives the error.
  gate.catch(() => {})

  const deadlineError = (): LlmError => {
    const last = lastAttemptError()
    // The attempt's own error already says what happened, has its ledger row,
    // and keeps its provider delay: surface it when it is a timeout (the
    // deadline hit inside the attempt) or carries a delay a host can act on.
    if (
      last !== undefined &&
      (last.kind === 'timeout' || (last.retryable && last.retryAfterMs !== undefined))
    ) {
      return last
    }
    return new LlmError(`Request timed out after ${timeoutMs}ms`, {
      kind: 'timeout',
      retryable: true,
      ...(last !== undefined ? { cause: last } : {}),
    })
  }

  let inFlight = 0
  let timerFired = false
  let fired = false
  let finished = false
  let produced: LlmResult | undefined
  let settleTimer: TimerHandle | undefined
  const fire = (): void => {
    if (fired || finished) return
    fired = true
    if (produced !== undefined) {
      // The provider answered and the row is written: the result stands.
      settleGate.resolve(produced)
      controller.abort(
        new LlmError(`Request timed out after ${timeoutMs}ms`, {
          kind: 'timeout',
          retryable: true,
        }),
      )
      return
    }
    const err = deadlineError()
    // REJECT FIRST, abort second (see buildCancellationRace, Invariant A).
    settleGate.reject(err)
    controller.abort(err)
  }
  const timer = scheduler.setTimeout(() => {
    timerFired = true
    elapsedController.abort()
    if (inFlight === 0) fire()
  }, timeoutMs)
  const merged =
    callerSignal === undefined
      ? undefined
      : mergeSignals([callerSignal, controller.signal])
  return {
    deadlineAt,
    signal: merged?.signal ?? controller.signal,
    elapsed: elapsedController.signal,
    gate,
    expired: () => fired || clock.now() >= deadlineAt,
    error: deadlineError,
    attemptStarted() {
      inFlight++
    },
    attemptEnded(result) {
      inFlight--
      if (result !== undefined) produced = result
      if (timerFired && inFlight === 0 && settleTimer === undefined) {
        // The attempt's own error (or result) is already on its way up the
        // chain, and it is the better answer: let the microtasks that carry it
        // run first. The gate fires only if the chain is still pending after
        // that, which is a middleware doing more work or hanging.
        settleTimer = scheduler.setTimeout(() => {
          settleTimer = undefined
          if (inFlight === 0) fire()
        }, 0)
      }
    },
    cleanup() {
      finished = true
      scheduler.clearTimeout(timer)
      if (settleTimer !== undefined) scheduler.clearTimeout(settleTimer)
      merged?.cleanup()
    },
  }
}

// ---------------------------------------------------------------------------
// Pipeline helper: record builders
// ---------------------------------------------------------------------------

/** Resolved config type used throughout the pipeline. */
type ResolvedConfig = GenConfig

/** (provider, model) exactly as the host named them, captured at call start. */
interface CallIdentity {
  readonly provider: string
  readonly model: string
}

/**
 * Renders the `config`-rooted path for a config-validation message from a
 * normalized issue's STRUCTURED segments: string keys as `.key`, numeric
 * array indices as `[0]` bracket notation (the format this message has
 * always used). Root-level issues render as bare `config`.
 */
function formatConfigIssuePath(segments: readonly (string | number)[]): string {
  let rendered = 'config'
  for (const segment of segments) {
    rendered += typeof segment === 'number' ? `[${segment}]` : `.${segment}`
  }
  return rendered
}

/**
 * Renders a config-validation error message from already-normalized
 * {@link NormalizedSchemaIssue}s.  Deriving the message from the same
 * normalized array whose `{ path, message }` projection is attached as
 * `issues` (rather than re-walking the raw StandardSchema issues separately)
 * is what guarantees the two representations cannot drift apart — see
 * {@link normalizeSchemaIssues}.
 */
function buildConfigValidationMessage(
  model: string,
  issues: ReadonlyArray<NormalizedSchemaIssue>,
): string {
  return issues
    .map(
      (issue) =>
        `Model "${model}" ${formatConfigIssuePath(issue.segments)}: ${issue.message}`,
    )
    .join('; ')
}

async function validateResolvedConfig(
  model: string,
  descriptor: ModelDescriptor | undefined,
  config: GenConfig,
): Promise<ResolvedConfig> {
  if (descriptor?.validateConfig === undefined) {
    return config
  }

  const syncOrAsync = descriptor.validateConfig['~standard'].validate(config)
  const validationResult =
    syncOrAsync instanceof Promise ? await syncOrAsync : syncOrAsync

  if (validationResult.issues !== undefined) {
    const normalized = normalizeSchemaIssues(validationResult.issues)
    throw new LlmError(buildConfigValidationMessage(model, normalized), {
      kind: 'bad_request',
      retryable: false,
      issues: toErrorIssues(normalized),
    })
  }

  return validationResult.value as ResolvedConfig
}

/**
 * D2 — opt-in call-site input contract.
 *
 * Validates `vars` against `callSite.inputSchema` via the `~standard.validate`
 * seam — the same machinery {@link validateResolvedConfig} uses. Runs BEFORE
 * strict template interpolation (D1): a missing/invalid business field then
 * surfaces as the schema's own error, in the caller's own vocabulary, rather
 * than a downstream unresolved-placeholder violation. Async validators are
 * supported (StandardSchema permits `Promise` results); `runStructured` is
 * already async.
 *
 * The validated/transformed output is intentionally discarded: `vars` keeps
 * flowing into D1/`interpolate` unchanged. `inputSchema` is a contract check,
 * not a transform step — there is exactly one shape of `vars` used for
 * rendering.
 */
async function validateCallSiteInput(
  callSiteId: string,
  schema: StandardSchemaV1,
  vars: Record<string, string>,
): Promise<void> {
  const syncOrAsync = schema['~standard'].validate(vars)
  const validationResult =
    syncOrAsync instanceof Promise ? await syncOrAsync : syncOrAsync

  if (validationResult.issues !== undefined) {
    const normalized = normalizeSchemaIssues(validationResult.issues)
    const message = normalized
      .map(
        (issue) =>
          `Call site "${callSiteId}" vars${issue.path ? `.${issue.path}` : ''}: ${issue.message}`,
      )
      .join('; ')
    throw new LlmError(message, {
      kind: 'bad_request',
      retryable: false,
      issues: toErrorIssues(normalized),
    })
  }
}

/**
 * D3 — opt-in request input contract (the `generate()` path).
 *
 * Validates `contract.value` against `contract.schema` via the
 * `~standard.validate` seam — the same machinery {@link validateCallSiteInput}
 * and {@link validateResolvedConfig} use. Called by `runPipeline` immediately
 * after `callId` allocation and before the middleware chain is entered: never
 * consumes `@gullabs/quota` budget on a violation, and validated exactly once
 * per logical call (before the retry middleware, never per attempt).
 *
 * On violation, throws `LlmError('bad_request')`, not retryable, with one
 * `issues` entry per failing path (D6). Async validators are supported.
 */
async function validateInputContract(contract: {
  schema: StandardSchemaV1
  value: unknown
}): Promise<void> {
  const syncOrAsync = contract.schema['~standard'].validate(contract.value)
  const validationResult =
    syncOrAsync instanceof Promise ? await syncOrAsync : syncOrAsync

  if (validationResult.issues !== undefined) {
    const normalized = normalizeSchemaIssues(validationResult.issues)
    const message = normalized
      .map(
        (issue) => `inputContract${issue.path ? `.${issue.path}` : ''}: ${issue.message}`,
      )
      .join('; ')
    throw new LlmError(`Request input contract violated: ${message}`, {
      kind: 'bad_request',
      retryable: false,
      issues: toErrorIssues(normalized),
    })
  }
}

/**
 * Assembles the {@link LlmCallRecord} for the success path (Step 10).
 */
function buildSuccessRecord(
  callId: string,
  attemptId: string,
  callSiteId: string | undefined,
  provider: string,
  model: string,
  metadata: CallMetadata | undefined,
  resolvedConfig: ResolvedConfig,
  adapterResult: AdapterResult,
  normalizedUsage: Usage,
  cost: Cost | undefined,
  allWarnings: Warning[],
  latencyMs: number,
  queueDelayMs: number | undefined,
  startMs: number,
  attemptNumber: number,
  externalId: string | undefined,
  outputParsed: boolean | undefined,
  authKeyId: string | undefined,
  toolNames: string[] | undefined,
): ReturnType<typeof buildRecord> {
  return buildRecord({
    callId,
    attemptId,
    attemptNumber,
    ...(callSiteId !== undefined ? { callSiteId } : {}),
    ...(externalId !== undefined ? { externalId } : {}),
    ...(authKeyId !== undefined ? { authKeyId } : {}),
    provider,
    model,
    ...(adapterResult.modelVersion !== undefined
      ? { modelVersion: adapterResult.modelVersion }
      : {}),
    ...(adapterResult.responseId !== undefined
      ? { responseId: adapterResult.responseId }
      : {}),
    ...(resolvedConfig.serviceTier !== undefined
      ? { serviceTier: resolvedConfig.serviceTier }
      : {}),
    ...(adapterResult.servedServiceTier !== undefined
      ? { servedServiceTier: adapterResult.servedServiceTier }
      : {}),
    usage: normalizedUsage,
    ...(cost !== undefined ? { cost } : {}),
    latencyMs,
    status: 'ok',
    ...(adapterResult.finishReason !== undefined
      ? { finishReason: adapterResult.finishReason }
      : {}),
    ...(outputParsed !== undefined ? { outputParsed } : {}),
    warnings: allWarnings,
    ...(queueDelayMs !== undefined ? { queueDelayMs } : {}),
    generationConfig: resolvedConfig,
    metadata: metadata ?? {},
    createdAt: new Date(startMs).toISOString(),
    ...(adapterResult.reasoningText !== undefined
      ? { reasoningText: adapterResult.reasoningText }
      : {}),
    ...(adapterResult.citations !== undefined && adapterResult.citations.length > 0
      ? { citations: adapterResult.citations }
      : {}),
    ...(adapterResult.toolCalls !== undefined && adapterResult.toolCalls.length > 0
      ? { toolCalls: adapterResult.toolCalls }
      : {}),
    ...(toolNames !== undefined && toolNames.length > 0 ? { toolNames } : {}),
    ...(adapterResult.providerMetadata !== undefined
      ? { providerMetadata: adapterResult.providerMetadata }
      : {}),
  })
}

/**
 * Assembles the {@link LlmCallRecord} for the error path (catch block postmortem).
 */
function buildErrorRecord(
  callId: string,
  attemptId: string,
  callSiteId: string | undefined,
  provider: string,
  model: string,
  metadata: CallMetadata | undefined,
  resolvedConfig: ResolvedConfig,
  usage: Usage,
  latencyMs: number,
  queueDelayMs: number | undefined,
  startMs: number,
  err: LlmError,
  attemptNumber: number,
  externalId: string | undefined,
  authKeyId: string | undefined,
  toolNames: string[] | undefined,
  cost?: Cost,
): ReturnType<typeof buildRecord> {
  return buildRecord({
    callId,
    attemptId,
    attemptNumber,
    ...(callSiteId !== undefined ? { callSiteId } : {}),
    ...(externalId !== undefined ? { externalId } : {}),
    ...(authKeyId !== undefined ? { authKeyId } : {}),
    provider,
    model,
    usage,
    ...(cost !== undefined ? { cost } : {}),
    latencyMs,
    ...(queueDelayMs !== undefined ? { queueDelayMs } : {}),
    // buildRecord overrides status from error.kind via errorKindToStatus.
    status: 'api_error',
    ...(err.servedServiceTier !== undefined
      ? { servedServiceTier: err.servedServiceTier }
      : {}),
    ...(err.warnings !== undefined && err.warnings.length > 0
      ? { warnings: [...err.warnings] }
      : {}),
    generationConfig: resolvedConfig,
    metadata: metadata ?? {},
    createdAt: new Date(startMs).toISOString(),
    error: err,
    ...(toolNames !== undefined && toolNames.length > 0 ? { toolNames } : {}),
  })
}

// ---------------------------------------------------------------------------
// Pipeline helper: fail-open sink write
// ---------------------------------------------------------------------------

/**
 * Builds one attempt's payload inside the bounded sink write. Resolves to the
 * payload, or `undefined` when it was dropped (already logged). Never rejects.
 */
type PayloadJob = (
  control: Pick<BuildControl, 'cancelled'>,
) => Promise<LlmCallPayload | undefined>

/**
 * Writes `record` to `sink` if a sink is configured, waiting at most
 * `timeoutMs`, and at most {@link SINK_INTERRUPT_GRACE_MS} after any of
 * `interrupts` (the caller's abort, the call deadline) fires.
 * Failures are logged at `error` as `llm.call.sink.failed` and swallowed
 * (fail-open) — a broken sink must never fail the LLM call. A sink still
 * pending at `timeoutMs` is abandoned and logged at `error` as
 * `llm.call.sink.timeout`; one still pending after an interrupt plus the grace
 * is abandoned and logged at `error` as `llm.call.sink.interrupted`. The
 * late result of an abandoned write, success or failure, is ignored. The write
 * itself is always started.
 */
async function recordToSink(
  sink: UsageSink | undefined,
  record: ReturnType<typeof buildRecord>,
  logger: Logger,
  callId: string,
  timeoutMs: number,
  interrupts: readonly (AbortSignal | undefined)[],
  scheduler: Scheduler,
  buildPayloadFor?: PayloadJob,
): Promise<void> {
  if (sink === undefined) return
  const fields = {
    callId,
    attemptId: record.attemptId,
    attemptNumber: record.attemptNumber,
    provider: record.provider,
    model: record.model,
  }
  let timer: TimerHandle | undefined
  let graceTimer: TimerHandle | undefined
  const detach: Array<() => void> = []
  try {
    const abandoned = new Promise<'timeout' | 'interrupted'>((resolve) => {
      timer = scheduler.setTimeout(() => {
        resolve('timeout')
      }, timeoutMs)
      const interrupted = (): void => {
        graceTimer ??= scheduler.setTimeout(() => {
          resolve('interrupted')
        }, SINK_INTERRUPT_GRACE_MS)
      }
      for (const signal of interrupts) {
        if (signal === undefined) continue
        if (signal.aborted) {
          interrupted()
        } else {
          signal.addEventListener('abort', interrupted, { once: true })
          detach.push(() => {
            signal.removeEventListener('abort', interrupted)
          })
        }
      }
    })
    // Started inside the try so a synchronous throw from `record` is a failure
    // like any other. `Promise.race` keeps handling the write, so a rejection
    // that arrives after the timeout is not an unhandled rejection.
    //
    // The payload is built first, inside the same budget: the timeout and an
    // abort end the wait for it (a payload still unbuilt then is dropped, with
    // a warning) and the ledger row is written without it. The write itself is
    // always started.
    let cancelled = false
    const write = (async () => {
      let payload: LlmCallPayload | undefined
      if (buildPayloadFor !== undefined) {
        const built = buildPayloadFor({ cancelled: () => cancelled })
        const first = await Promise.race([built, abandoned])
        if (first === 'timeout' || first === 'interrupted') {
          cancelled = true
          payload = undefined
          logger.warn(
            {
              callId,
              attemptId: record.attemptId,
              stage: 'timeout',
              reason: 'the sink wait ended while the payload was being built',
            },
            'llm.call.payload.dropped',
          )
        } else {
          payload = first
        }
      }
      await (payload === undefined
        ? sink.record(record)
        : sink.record(record, { payload, logger }))
      return 'done' as const
    })()
    const outcome = await Promise.race([write, abandoned])
    if (outcome === 'timeout') {
      // A row that may be lost. The event name and fields are stable: alert on
      // `llm.call.sink.timeout`, and use `attemptId` to find the row.
      logger.error({ ...fields, timeoutMs }, 'llm.call.sink.timeout')
    } else if (outcome === 'interrupted') {
      // Same, after an abort or the call deadline: `llm.call.sink.interrupted`.
      logger.error(
        { ...fields, graceMs: SINK_INTERRUPT_GRACE_MS },
        'llm.call.sink.interrupted',
      )
    } else {
      logger.debug({ callId }, 'llm.call.sink.success')
    }
  } catch (sinkErr) {
    // A dropped ledger row. The event name and fields are stable: alert on
    // `llm.call.sink.failed`, and use `attemptId` to find the lost row.
    logger.error(
      { ...fields, error: redactSecrets(String(sinkErr)) },
      'llm.call.sink.failed',
    )
  } finally {
    if (timer !== undefined) scheduler.clearTimeout(timer)
    if (graceTimer !== undefined) scheduler.clearTimeout(graceTimer)
    for (const off of detach) off()
  }
}

// ---------------------------------------------------------------------------
// Internal helper: attach call context to errors (idempotent)
// ---------------------------------------------------------------------------

/**
 * Attaches `callId` and `attemptId` to an `LlmError` if not already set.
 *
 * `LlmError` fields are `readonly` at the TypeScript level (compile-time only).
 * We use `Object.defineProperty` to set them at runtime when they were not
 * supplied to the constructor — which is the case for errors thrown by adapters
 * before the engine had a chance to enrich them.
 *
 * This helper is idempotent: if either field is already set, it is left as-is.
 */
function attachCallContext(
  err: LlmError,
  ctx: { callId: string; attemptId?: string },
): void {
  if (err.callId === undefined) {
    Object.defineProperty(err, 'callId', {
      value: ctx.callId,
      enumerable: true,
      configurable: true,
    })
  }
  if (ctx.attemptId !== undefined && err.attemptId === undefined) {
    Object.defineProperty(err, 'attemptId', {
      value: ctx.attemptId,
      enumerable: true,
      configurable: true,
    })
  }
}

// ---------------------------------------------------------------------------
// createClient
// ---------------------------------------------------------------------------

/**
 * Wire together port implementations and return a ready-to-use {@link Client}.
 *
 * The client is stateless and thread-safe; share it across requests.
 *
 * @example
 * ```ts
 * import { createClient, composeProviders } from '@gullabs/core'
 * import { googleProvider } from '@gullabs/google'
 *
 * const client = createClient({
 *   ...composeProviders([googleProvider()]),
 *   sink: drizzleUsageSink({ db }),
 * })
 *
 * const result = await client.generate(
 *   {
 *     provider: 'google',
 *     model: 'gemini-2.5-pro',
 *     messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello!' }] }],
 *   },
 *   { auth: { apiKey: process.env['GEMINI_API_KEY']! } },
 * )
 * ```
 */
/**
 * Validates per-call auth material and returns the concrete {@link AuthMaterial}
 * that is threaded through {@link AdapterCtx} for the rest of the call.
 *
 * This is the **canonical auth-resolution point** — auth is resolved once per
 * logical call, before the middleware chain runs, and the concrete result is
 * forwarded unchanged through every retry attempt via `AdapterCtx`.
 *
 * **Future: refreshable credentials** (short-lived OAuth/STS tokens).
 * When that need arises, widen the `opts.auth` type on {@link GenerateOptions}
 * and {@link RunStructuredOptions} to
 * `AuthMaterial | ((ctx: RefreshCtx) => Promise<AuthMaterial>)`,
 * resolve the resolver HERE (once per logical call, not per attempt), and
 * continue threading the concrete `AuthMaterial` through `AdapterCtx` unchanged.
 *
 * Open policy questions to settle at that time:
 * - Resolve once per logical call vs. once per retry attempt (current proposal:
 *   once per call — simpler, keeps retry semantics predictable).
 * - How to handle a mid-attempt credential expiry (current: not in scope; the
 *   resolver is called at call start, not between retries).
 * - Resolver failures: classify as `invalid_auth` (non-retryable) and skip
 *   the adapter entirely, or allow retry? (Current proposal: `invalid_auth`,
 *   non-retryable — same as a missing key.)
 *
 * Throws `LlmError('invalid_auth')` when auth is missing, or when it is
 * neither a well-formed {@link ApiKeyAuth} (non-empty `apiKey` string) nor a
 * {@link CliSessionAuth} (`cliSession: true`).
 *
 * This function only validates that *some* recognised auth shape was
 * supplied — it does not know which provider will consume it. Adapters own
 * the further narrowing (e.g. the Google adapter rejects `CliSessionAuth`,
 * the CLI adapters reject `ApiKeyAuth`).
 */
function requireAuth(auth: AuthMaterial | undefined): AuthMaterial {
  if (auth === undefined) {
    throw new LlmError(
      'Missing or invalid auth; pass { auth: { apiKey } } or { auth: { cliSession: true } } per call',
      { kind: 'invalid_auth', retryable: false },
    )
  }

  const isValidApiKeyAuth =
    'apiKey' in auth && typeof auth.apiKey === 'string' && auth.apiKey.trim() !== ''
  const isValidCliSessionAuth = 'cliSession' in auth && auth.cliSession

  if (!isValidApiKeyAuth && !isValidCliSessionAuth) {
    throw new LlmError(
      'Missing or invalid auth; pass { auth: { apiKey } } or { auth: { cliSession: true } } per call',
      { kind: 'invalid_auth', retryable: false },
    )
  }

  // keyId (ADR-026): opaque caller-supplied attribution label, ApiKeyAuth-only.
  // "Reject, don't map" — validate strictly, never silently drop or coerce.
  if (isValidApiKeyAuth && 'keyId' in auth) {
    if (typeof auth.keyId !== 'string' || auth.keyId.trim() === '') {
      throw new LlmError('auth.keyId must be a non-empty string when provided', {
        kind: 'bad_request',
        retryable: false,
      })
    }
    if (auth.keyId === auth.apiKey) {
      throw new LlmError(
        'auth.keyId must not equal auth.apiKey — keyId is an opaque label, never the secret',
        { kind: 'bad_request', retryable: false },
      )
    }
  }

  return auth
}

/**
 * Extracts the attribution label from the resolved {@link AuthMaterial} that
 * was ACTUALLY used for a dispatch attempt (see ADR-026).
 *
 * Only `ApiKeyAuth` carries `keyId`; `CliSessionAuth` has no key identity and
 * always yields `undefined`. Called at the same place the engine resolves
 * the concrete auth material per attempt, so attribution stays correct if a
 * future credential-refresh path ever swaps material between attempts.
 */
function authKeyIdOf(auth: AuthMaterial): string | undefined {
  return 'apiKey' in auth ? auth.keyId : undefined
}

/** `storePayload` is a boolean option; any other value is refused, not guessed at. */
function resolveStorePayload(value: unknown): boolean {
  if (value === undefined || typeof value === 'boolean') return value !== false
  throw new LlmError('storePayload must be a boolean.', {
    kind: 'bad_request',
    retryable: false,
    issues: [{ path: 'storePayload', message: 'must be a boolean.' }],
  })
}

export function createClient(config: ClientConfig): Client {
  const { adapters } = config
  const pricingSources: Record<string, PricingSource> = config.pricingSources ?? {}
  const sink = config.sink
  const sinkTimeoutMs = config.sinkTimeoutMs ?? DEFAULT_SINK_TIMEOUT_MS
  assertTimerMs(sinkTimeoutMs, 'createClient: sinkTimeoutMs', 'sinkTimeoutMs')
  const payloads: Readonly<PayloadsConfig> | undefined =
    config.payloads !== undefined ? resolvePayloadsConfig(config.payloads) : undefined
  if (payloads !== undefined && sink === undefined) {
    throw new LlmError(
      'createClient: payloads requires a sink; the payload is handed to sink.record(record, { payload }).',
      {
        kind: 'bad_request',
        retryable: false,
        issues: [{ path: 'payloads', message: 'requires ClientConfig.sink.' }],
      },
    )
  }
  // A sink that does not say it takes payloads is not handed one: capture would
  // cost CPU for text nothing stores.
  const capturePayloads =
    payloads !== undefined && sink !== undefined && sink.acceptsPayloads === true
  const clock: Clock = config.clock ?? DEFAULT_CLOCK
  const scheduler: Scheduler = config.scheduler ?? DEFAULT_SCHEDULER
  const ids: IdGenerator = config.ids ?? DEFAULT_IDS
  const logger: Logger = config.logger ?? NOOP_LOGGER
  const safeLogger: Logger = makeSafeLogger(logger)
  if (payloads !== undefined && !capturePayloads) {
    // Once, at construction: the host asked for payloads and the sink would drop them.
    safeLogger.warn(
      {
        reason:
          'ClientConfig.payloads is set but the sink does not declare acceptsPayloads: true, so no payload is built',
      },
      'llm.config.payloads.sink_ignores_payloads',
    )
  }
  const telemetry: Telemetry = config.telemetry ?? NOOP_TELEMETRY
  const rateLimiter: RateLimiter = config.rateLimiter ?? NOOP_RATE_LIMITER
  const libDefaults: GenConfig = config.defaults ?? {}
  const registry: ModelRegistry = config.modelRegistry
  for (const method of ['resolve', 'findByModel', 'listDescriptors'] as const) {
    if (
      typeof (registry as Partial<ModelRegistry> | undefined)?.[method] !== 'function'
    ) {
      throw new LlmError(
        `ClientConfig.modelRegistry must implement ${method}(); build it with createModelRegistry.`,
        { kind: 'bad_request', retryable: false },
      )
    }
  }

  // Build O(1) adapter map at construction time — also detects duplicate ids.
  const adapterMap = new Map<string, ProviderAdapter>()
  for (const a of adapters) {
    if (adapterMap.has(a.id)) {
      throw new LlmError(`Duplicate adapter id "${a.id}"`, {
        kind: 'bad_request',
        retryable: false,
      })
    }
    adapterMap.set(a.id, a)
  }

  // The middleware list is copied and frozen here: the checks below validate
  // exactly the list every call runs, so reordering or pushing onto the host's
  // array after construction cannot bypass them.
  const middleware: readonly Middleware[] = Object.freeze([...(config.middleware ?? [])])

  // Validate middleware IDs are unique.
  if (middleware.length > 0) {
    const seenIds = new Set<string>()
    for (const mw of middleware) {
      if (seenIds.has(mw.id)) {
        throw new LlmError(`Duplicate middleware id "${mw.id}"`, {
          kind: 'bad_request',
          retryable: false,
        })
      }
      seenIds.add(mw.id)
    }

    // Quota accounts one unit per provider dispatch, which needs it INSIDE
    // retry. Identification reads `role`, never the (configurable) `id`; a
    // wrapper or composed middleware that does not carry the inner one's role
    // is not detected.
    const firstQuota = middleware.findIndex((mw) => mw.role === 'quota')
    let lastRetry = -1
    middleware.forEach((mw, i) => {
      if (mw.role === 'retry') lastRetry = i
    })
    const quotaMw = middleware[firstQuota]
    const retryMw = middleware[lastRetry]
    if (quotaMw !== undefined && retryMw !== undefined && firstQuota < lastRetry) {
      throw new LlmError(
        `Quota middleware "${quotaMw.id}" is placed outside (before) retry middleware "${retryMw.id}"; ` +
          'place quota inside retry, e.g. [retryMiddleware(...), providerQuotaMiddleware(...)], so every provider dispatch consumes exactly one quota unit.',
        {
          kind: 'bad_request',
          retryable: false,
          issues: [
            {
              path: `middleware.${firstQuota}`,
              message: `quota middleware must come after retry middleware (retry is at index ${lastRetry}).`,
            },
          ],
        },
      )
    }
  }

  // Unconditional construction-time invariant: every registry descriptor's
  // provider must match a configured adapter's id.
  {
    for (const d of registry.listDescriptors()) {
      if (!adapterMap.has(d.provider)) {
        throw new LlmError(
          `Model registry descriptor for provider "${d.provider}" model "${d.model}" ` +
            `has no matching configured adapter (configured adapter ids: ${Array.from(
              adapterMap.keys(),
            )
              .map((id) => `"${id}"`)
              .join(', ')}).`,
          { kind: 'bad_request', retryable: false },
        )
      }
    }
  }

  if (config.strictPricing === true) {
    for (const d of registry.listDescriptors()) {
      const pricingKey = d.pricingFamily ?? d.model
      const source = pricingSources[d.provider]
      if (source === undefined || !source.hasModel(pricingKey)) {
        throw new LlmError(
          `strictPricing: model "${d.model}" (provider "${d.provider}", pricing key "${pricingKey}") ` +
            `has no entry in pricingSources["${d.provider}"].`,
          { kind: 'bad_request', retryable: false },
        )
      }
    }
  }

  const routeFn =
    config.route ??
    ((provider: string, model: string, adpts: ProviderAdapter[]) =>
      defaultRoute(provider, model, adpts, adapterMap))

  // -------------------------------------------------------------------------
  // Core pipeline (shared by generate + runStructured)
  // -------------------------------------------------------------------------
  //
  // Receives a fully-rendered request plus a pre-merged resolved config so the
  // caller (generate / runStructured) owns config-resolution semantics.
  //
  // Error path guarantee (postmortems on failure — SPEC goal 3):
  //   Any throw → classify → build record (with whatever usage is known) →
  //   sink.record (fail-open) → telemetry.onError (fail-open) → rethrow.
  //   The record is ALWAYS attempted, even when the adapter was never reached.
  // -------------------------------------------------------------------------

  async function runPipeline(
    request: LlmRequest,
    // Identity captured synchronously at the top of generate()/runStructured(),
    // before the first await. `request` is the host's live object and may be
    // mutated while the call is still validating, so nothing below reads
    // `request.provider` / `request.model`.
    identity: CallIdentity,
    resolvedConfig: ResolvedConfig,
    descriptor: ModelDescriptor,
    callSiteId: string | undefined,
    callerSignal: AbortSignal | undefined,
    callAuth: AuthMaterial,
    // D4: only `generate()` enforces `requireInputContract` here.
    // `runStructured()` enforces its own callsite-level check (missing
    // `callSite.inputSchema`) in its own prologue, pre-callId, before this
    // function is ever called — re-checking `request.inputContract` here
    // would wrongly refuse every `runStructured()` call, since D3 says
    // `runStructured` never sets `inputContract` (that's D2's job).
    enforceInputContract: boolean,
    // `false` when the call opted out of payload storage (`storePayload: false`).
    storePayload: boolean,
  ): Promise<LlmResult> {
    const { provider: callProvider, model: requestedModel } = identity
    if (resolvedConfig.timeoutMs !== undefined) {
      assertTimerMs(resolvedConfig.timeoutMs, 'config.timeoutMs', 'config.timeoutMs')
    }

    // ── (a) Call-level prologue ────────────────────────────────────────────
    // ONE callId per logical call.  ONE onStart.  ONE log-start entry.
    // These fire before the middleware chain runs (including any retry logic).
    const callStartMs = clock.now()
    const callId = ids.callId()

    // lastAttemptId / lastAttemptNumber are assigned ONLY when runAttempt actually begins.
    // They stay undefined if a middleware throws before next() is called.
    let lastAttemptId: string | undefined
    let lastAttemptNumber: number | undefined
    // Per-attempt cost ledger for `LlmResult.callCost` / `CallErrorEvent.callCost`.
    // `microUsd` sums only the attempts that were priced. An attempt that was
    // dispatched and has no priced usage (a timeout, an abort or a connection
    // failure that reported no usage, or usage the pricing source could not price)
    // is unpriced: the provider may have billed it, so the sum is a lower bound.
    // `noted` counts attempts whose outcome was recorded; one still in flight when
    // the call settles (a deadline ended the call) is unpriced too.
    const attemptCosts = { attempts: 0, noted: 0, microUsd: 0, unpriced: 0 }
    let lastFailure: { usage: Usage; cost?: Cost } | undefined
    const noteAttemptCost = (cost: Cost | undefined, knownFree = false): void => {
      attemptCosts.noted += 1
      if (cost !== undefined && cost.microUsd !== null) {
        attemptCosts.microUsd += cost.microUsd
      } else if (!knownFree) {
        attemptCosts.unpriced += 1
      }
    }
    const callCostOf = (): CallCost | undefined =>
      attemptCosts.attempts === 0
        ? undefined
        : {
            microUsd: attemptCosts.microUsd,
            attempts: attemptCosts.attempts,
            unpricedAttempts:
              attemptCosts.unpriced + (attemptCosts.attempts - attemptCosts.noted),
          }
    const emitAttempt = (event: AttemptEvent): void => {
      try {
        telemetry.onAttempt?.(event, span)
      } catch (hookErr) {
        safeLogger.debug(
          {
            callId,
            phase: 'onAttempt',
            error: redactSecrets(String(hookErr)),
          },
          'llm.telemetry.hook.failed',
        )
      }
    }

    let span: unknown
    try {
      const startEvent: CallStartEvent = {
        callId,
        provider: callProvider,
        model: requestedModel,
        metadata: request.metadata ?? {},
        ...(callSiteId !== undefined ? { callSiteId } : {}),
      }
      span = telemetry.onStart?.(startEvent)
    } catch (err) {
      safeLogger.debug(
        { callId, phase: 'onStart', error: redactSecrets(String(err)) },
        'llm.telemetry.hook.failed',
      )
    }

    safeLogger.info(
      {
        callId,
        model: requestedModel,
        callSiteId,
        metadata: request.metadata ?? {},
      },
      'llm.call.start',
    )

    // Call identity (ADR-037). Captured synchronously at the top of
    // `generate()` / `runStructured()`, before any await. `runAttempt`
    // dispatches, validates, prices and authenticates with these three values
    // and never reads `provider`, `model` or `modelDescriptor` from the request
    // a middleware hands it, so nothing a middleware does to those fields can
    // change routing. `requestedModel` is the exact string the host sent (a
    // declared alias stays an alias, ADR-033); `callDescriptor` is the
    // descriptor object resolved for it.
    const callDescriptor = descriptor

    // Build the pre-resolved request for the middleware chain.
    // The per-attempt signal is NOT included here — each attempt builds its
    // own combined (caller + timeout) signal inside runAttempt.
    const preResolvedReq: ResolvedRequest = {
      provider: callProvider,
      model: requestedModel,
      messages: request.messages,
      config: resolvedConfig,
      ...(request.transientProviderState !== undefined
        ? { transientProviderState: request.transientProviderState }
        : {}),
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.output?.jsonSchema !== undefined
        ? { outputJsonSchema: request.output.jsonSchema }
        : {}),
      modelDescriptor: descriptor,
      ...(request.tools !== undefined ? { tools: request.tools } : {}),
      ...(request.toolChoice !== undefined ? { toolChoice: request.toolChoice } : {}),
    }

    // The logical-call deadline (`timeoutMs`) starts here, so middleware time
    // counts against it (R4.1). It is merged into the signal middleware see.
    let lastAttemptError: LlmError | undefined
    const deadline = buildCallDeadline(
      callerSignal,
      resolvedConfig.timeoutMs,
      clock,
      scheduler,
      () => lastAttemptError,
    )
    // A sink write stops waiting on the caller's abort and on the deadline
    // timer, which fires even while an attempt (its sink write) is in flight.
    const sinkInterrupts = [callerSignal, deadline.elapsed]

    // EngineCtx carries stable call-level state.  ctx.signal is the caller
    // signal merged with the logical-call deadline; each attempt adds its own
    // timeout on top of it inside runAttempt.
    const engineCtx: EngineCtx = {
      callId,
      clock,
      scheduler,
      logger: safeLogger,
      ...(deadline.signal !== undefined ? { signal: deadline.signal } : {}),
      ...(deadline.deadlineAt !== undefined ? { deadlineAt: deadline.deadlineAt } : {}),
    }

    // Payload plan for one attempt (ADR-038), made at dispatch: whether storage
    // applies (client on, sink takes payloads, the call did not opt out, `include`
    // says yes) and, if so, a snapshot of the request the adapter is about to
    // receive. Returns a job that builds the payload for the attempt's outcome
    // inside the bounded sink write, or undefined. Never throws and the job never
    // rejects: a payload problem is a warning, not a failed call.
    function planPayload(
      sent: ResolvedRequest,
      attemptId: string,
      ctx: EngineCtx,
    ): ((response: LlmCallPayload['response']) => PayloadJob) | undefined {
      if (payloads === undefined || !capturePayloads || !storePayload) return undefined
      const dropped = (error: unknown): void => {
        const { stage, errorName, reason } = describePayloadError(error)
        ctx.logger.warn(
          { callId: ctx.callId, attemptId, stage, errorName, error: reason },
          'llm.call.payload.dropped',
        )
      }
      let snapshot
      try {
        if (payloads.include !== undefined) {
          const included: unknown = payloads.include(request)
          if (isThenable(included)) {
            void Promise.resolve(included).catch(() => {})
            throw new PayloadDropped(
              'include',
              'the include function must be synchronous',
            )
          }
          if (included !== true) return undefined
        }
        snapshot = snapshotPayloadSource({
          ...(sent.system !== undefined ? { system: sent.system } : {}),
          messages: sent.messages,
          ...(sent.tools !== undefined ? { tools: sent.tools } : {}),
        })
      } catch (planErr) {
        dropped(
          planErr instanceof PayloadDropped
            ? planErr
            : new PayloadDropped('include', 'the include function threw', planErr),
        )
        return undefined
      }
      return (response) => async (control) => {
        try {
          return await buildPayload(snapshot, response, payloads, {
            yieldNow: () =>
              new Promise<void>((resolve) => {
                scheduler.setTimeout(resolve, 0)
              }),
            cancelled: control.cancelled,
          })
        } catch (payloadErr) {
          dropped(payloadErr)
          return undefined
        }
      }
    }

    // ── (b) runAttempt — the innermost Handler ─────────────────────────────
    //
    // Generates a FRESH attemptId on every invocation.
    // Does: route → auth → acquire → adapter.run → normalize → validate →
    //        cost → buildRecord → sink → return.
    // The cancellation race and rate-limiter acquire/release live here so
    // each retry gets its own independent timeout window.
    //
    // Errors: classify → build error record → sink (fail-open) → rethrow.
    // The call-level telemetry.onError and logger.error are fired by the
    // epilogue after the chain settles, NOT here.
    async function runAttemptBody(
      incoming: ResolvedRequest,
      ctx: EngineCtx,
    ): Promise<LlmResult> {
      // Pin the call identity over whatever the middleware chain handed us.
      const req: ResolvedRequest = {
        ...incoming,
        provider: callProvider,
        model: requestedModel,
        modelDescriptor: callDescriptor,
      }
      // Resolve 1-based attempt ordinal (set by retry middleware; defaults to 1
      // for direct calls that bypass the retry middleware).
      const attemptNumber = req.attemptNumber ?? 1
      const attemptStartMs = ctx.clock.now()
      // Every attempt is its own billed ledger row, so every attempt gets a
      // freshly minted id. Host retries correlate through `externalId`.
      const attemptId = ids.attemptId()
      lastAttemptId = attemptId
      lastAttemptNumber = attemptNumber
      attemptCosts.attempts += 1

      // A2: Attempt-start debug log so operators can trace individual attempts.
      ctx.logger.debug(
        { callId: ctx.callId, attemptNumber, model: req.model },
        'llm.call.attempt.start',
      )

      // Track progressive state for the error-path record builder.
      // The call's provider is authoritative from the start; routing/post-route
      // checks below never change it (they may only reject the call).
      const provider = callProvider
      let normalizedResult:
        { usage: Usage; warnings: Warning[]; estimated: boolean } | undefined
      let cost: Cost | undefined
      // Release function returned by rateLimiter.acquire — called on every exit path.
      let release: Release | undefined
      let queueDelayMs: number | undefined
      let dispatchStartMs: number | undefined
      let payloadPlan: ReturnType<typeof planPayload>
      // Cancellation cleanup — idempotent; safe to call on both paths.
      let cleanup: () => void = () => {}
      let effectiveReq: ResolvedRequest = req

      try {
        const validatedConfig = await validateResolvedConfig(
          req.model,
          req.modelDescriptor,
          req.config,
        )
        effectiveReq =
          validatedConfig === req.config ? req : { ...req, config: validatedConfig }

        // Step 5: Resolve adapter (may throw LlmError 'bad_request')
        const adapter = routeFn(effectiveReq.provider, effectiveReq.model, adapters)

        // Post-route invariant — applies to the default router AND any custom
        // `route()` option: the returned adapter must serve the requested
        // provider. Closes both the default-route miss case and custom
        // routers that might cross providers.
        if (adapter.id !== effectiveReq.provider) {
          throw new LlmError(
            `Adapter routing invariant violated: router returned adapter "${adapter.id}" ` +
              `for request provider "${effectiveReq.provider}".`,
            { kind: 'bad_request', retryable: false },
          )
        }

        // ── Per-attempt cancellation setup ──────────────────────────────────
        // adapter.run() is raced against two independent rejection promises:
        //
        //   (a) Caller-abort  — rejects LlmError('aborted') when ctx.signal fires.
        //   (b) Timeout       — rejects LlmError('timeout') when the timer fires.
        //
        // Each attempt gets its own timeout window (independent of how long
        // prior attempts / retry backoffs took).
        //
        // Invariant A (timeout-beats-abort microtask ordering): the timeout
        // promise rejects BEFORE its AbortController is fired — guaranteed by
        // buildCancellationRace.  Do not reorder.
        //
        // The attempt's window is what the logical deadline has left, never
        // more, so an attempt that starts late (after a quota deferral) cannot
        // run past `timeoutMs`.
        const attemptBudgetMs =
          deadline.deadlineAt === undefined
            ? undefined
            : deadline.deadlineAt - ctx.clock.now()
        const cancellation = buildCancellationRace(ctx.signal, attemptBudgetMs, scheduler)
        cleanup = cancellation.cleanup
        const { raceParts, combinedSignal } = cancellation

        // Step 6b: Rate-limiter acquire — PRE-SEND backpressure. Measure
        // queueDelayMs separately from provider-dispatch latencyMs below.
        const acquireStartMs = ctx.clock.now()
        // The key uses the canonical id so a model and its aliases share one
        // limiter bucket.
        const rateLimitHint: RateLimitHint = {
          estimatedInputTokens: estimateInputTokens(effectiveReq),
        }
        const acquirePromise = rateLimiter.acquire(
          `${provider}:${callDescriptor.model}`,
          combinedSignal,
          rateLimitHint,
        )
        try {
          release =
            raceParts.length > 0
              ? await Promise.race([acquirePromise, ...raceParts])
              : await acquirePromise
        } catch (acquireErr) {
          queueDelayMs = ctx.clock.now() - acquireStartMs
          // A timeout or abort can win while `acquire` is still pending. If it
          // then resolves, nobody holds the Release; call it so the slot is
          // not leaked. A rejection (the usual way a signal-aware limiter ends
          // the wait) is already handled.
          void Promise.resolve(acquirePromise).then(
            (lateRelease) => {
              try {
                lateRelease()
              } catch {
                /* intentionally swallowed */
              }
            },
            () => {},
          )
          throw acquireErr
        }
        queueDelayMs = ctx.clock.now() - acquireStartMs

        // An abort that arrived before dispatch (a signal already aborted, or
        // one that fired between attempts) must not reach the provider: a
        // limiter that resolves at once would otherwise win the race above.
        if (ctx.signal?.aborted === true) throw abortedError(ctx.signal)

        ctx.logger.debug(
          { callId: ctx.callId, attemptNumber, queueDelayMs },
          'llm.call.attempt.dispatch',
        )

        // Step 6c: Build adapter-specific request (with the combined signal)
        // and the AdapterCtx.
        const adapterReq: ResolvedRequest = {
          ...effectiveReq,
          ...(combinedSignal !== undefined ? { signal: combinedSignal } : {}),
          ...(attemptBudgetMs !== undefined ? { attemptTimeoutMs: attemptBudgetMs } : {}),
        }

        const adapterCtx: AdapterCtx = {
          auth: callAuth,
          logger: ctx.logger,
          scheduler,
          ...(combinedSignal !== undefined ? { signal: combinedSignal } : {}),
        }

        // The payload plan (ADR-038) snapshots the request as it is dispatched.
        payloadPlan = planPayload(effectiveReq, attemptId, ctx)

        // Step 7: Run adapter — raced against all cancellation promises.
        dispatchStartMs = ctx.clock.now()
        const runPromise = adapter.run(adapterReq, adapterCtx)
        const adapterResult =
          raceParts.length > 0
            ? await Promise.race([runPromise, ...raceParts])
            : await runPromise

        // Cleanup on success path (idempotent).
        cleanup()

        // Step 7b: Normalize usage ONCE.
        normalizedResult = normalizeUsage(adapterResult.usage)

        // Release the rate-limiter slot with the call's usage — swallow errors
        // so a broken Release cannot mask the successful result.
        try {
          release(normalizedResult.usage)
        } catch {
          /* intentionally swallowed */
        }
        release = undefined

        // Step 8: JSON.parse structured output — caller owns validation.
        let output: unknown
        let outputParsed: boolean | undefined
        if (req.outputJsonSchema !== undefined) {
          if (adapterResult.rawStructured !== undefined) {
            output = adapterResult.rawStructured
            outputParsed = true
          } else {
            outputParsed = false
          }
        }

        // Step 9: Cost — fail-open (never fail the call for costing).
        const costWarnings: Warning[] = []
        try {
          // Priced under the canonical descriptor, never the requested string.
          const pricingKey = callDescriptor.pricingFamily ?? callDescriptor.model
          const source = pricingSources[provider]
          if (source === undefined) {
            // No pricing source for this provider — cost stays absent
            // (fail-open); the warning below is the only trace.
            costWarnings.push({
              type: 'other',
              message: `Provider "${provider}" has no configured pricing source; usage was recorded but not costed.`,
            })
          } else {
            cost = source.price(
              pricingKey,
              normalizedResult.usage,
              adapterResult.servedServiceTier ?? effectiveReq.config.serviceTier,
            )
            // The provider billed tokens its usage fields do not carry: the
            // amount can undercount, so it is never reported as exact.
            if (normalizedResult.estimated) cost = markEstimated(cost)
            const drift = providerCostDriftWarning(cost, normalizedResult.usage)
            if (drift !== undefined) costWarnings.push(drift)
            if (cost.microUsd === null) {
              const reason =
                cost.unpricedReason !== undefined ? ` Reason: ${cost.unpricedReason}` : ''
              costWarnings.push({
                type: 'other',
                message: `Model "${req.model}" is unpriced (cost.microUsd is null); usage was recorded but not costed.${reason}`,
              })
            }
          }
        } catch (costErr) {
          costWarnings.push({
            type: 'other',
            message: `Cost computation failed: ${String(costErr)}`,
          })
          ctx.logger.warn(
            { callId: ctx.callId, error: String(costErr) },
            'llm.call.cost.failed',
          )
        }

        // Reasoning that eats the whole output cap leaves no answer; say so
        // instead of returning an empty success with no explanation.
        const reasoningCapWarnings: Warning[] = []
        const thinkingTokens = normalizedResult.usage.thinkingTokens ?? 0
        if (
          adapterResult.finishReason === 'length' &&
          (adapterResult.text === undefined || adapterResult.text.trim().length === 0) &&
          adapterResult.rawStructured === undefined &&
          (adapterResult.toolCalls === undefined ||
            adapterResult.toolCalls.length === 0) &&
          thinkingTokens > 0
        ) {
          const cap = effectiveReq.config.maxOutputTokens
          reasoningCapWarnings.push({
            type: 'other',
            message: `maxOutputTokens (${cap ?? 'the provider default'}) was used up by reasoning (${thinkingTokens} tokens); no answer was produced. Raise maxOutputTokens or lower the reasoning effort.`,
          })
        }

        // Collect all warnings (adapter + normalize + reasoning cap + cost).
        const allWarnings: Warning[] = [
          ...adapterResult.warnings,
          ...normalizedResult.warnings,
          ...reasoningCapWarnings,
          ...costWarnings,
        ]

        // Step 10: Build LlmCallRecord.
        const latencyMs = ctx.clock.now() - dispatchStartMs
        const record = buildSuccessRecord(
          ctx.callId,
          attemptId,
          callSiteId,
          provider,
          effectiveReq.model,
          request.metadata,
          effectiveReq.config,
          adapterResult,
          normalizedResult.usage,
          cost,
          allWarnings,
          latencyMs,
          queueDelayMs,
          attemptStartMs,
          attemptNumber,
          request.externalId,
          outputParsed,
          authKeyIdOf(callAuth),
          request.tools?.map((t) => t.name),
        )

        // Step 11: Sink — fail-open.
        const rawText =
          adapterResult.text ??
          (adapterResult.rawStructured !== undefined
            ? JSON.stringify(adapterResult.rawStructured)
            : undefined)
        await recordToSink(
          sink,
          record,
          ctx.logger,
          ctx.callId,
          sinkTimeoutMs,
          sinkInterrupts,
          scheduler,
          payloadPlan?.(rawText !== undefined ? { text: rawText } : {}),
        )
        noteAttemptCost(cost)
        emitAttempt({
          callId: ctx.callId,
          attemptId,
          attemptNumber,
          provider,
          model: requestedModel,
          metadata: request.metadata ?? {},
          latencyMs,
          usage: normalizedResult.usage,
          ...(cost !== undefined ? { cost } : {}),
          ...(callSiteId !== undefined ? { callSiteId } : {}),
        })

        // Step 12: Return LlmResult.
        const result: LlmResult = {
          callId: ctx.callId,
          attemptId,
          usage: normalizedResult.usage,
          model: adapterResult.model,
          message: adapterResult.message,
          continuation: callDescriptor.capabilities?.continuation ?? 'history',
          latencyMs,
          queueDelayMs,
          warnings: allWarnings,
          ...(output !== undefined ? { output } : {}),
          ...(outputParsed !== undefined ? { outputParsed } : {}),
          ...(adapterResult.text !== undefined ? { text: adapterResult.text } : {}),
          ...(adapterResult.reasoningText !== undefined
            ? { reasoningText: adapterResult.reasoningText }
            : {}),
          ...(cost !== undefined ? { cost } : {}),
          ...(adapterResult.modelVersion !== undefined
            ? { modelVersion: adapterResult.modelVersion }
            : {}),
          ...(adapterResult.finishReason !== undefined
            ? { finishReason: adapterResult.finishReason }
            : {}),
          ...(adapterResult.responseId !== undefined
            ? { responseId: adapterResult.responseId }
            : {}),
          ...(adapterResult.servedServiceTier !== undefined
            ? { servedServiceTier: adapterResult.servedServiceTier }
            : {}),
          ...(adapterResult.citations !== undefined && adapterResult.citations.length > 0
            ? { citations: adapterResult.citations }
            : {}),
          // A copy: a host that edits toolCalls[i].args must not change the
          // arguments in `message`, which it replays (and a signature hashes).
          ...(adapterResult.toolCalls !== undefined && adapterResult.toolCalls.length > 0
            ? { toolCalls: structuredClone(adapterResult.toolCalls) }
            : {}),
          ...(adapterResult.providerMetadata !== undefined
            ? { providerMetadata: adapterResult.providerMetadata }
            : {}),
          ...(adapterResult.transientProviderState !== undefined
            ? { transientProviderState: adapterResult.transientProviderState }
            : {}),
        }
        return result
      } catch (rawErr) {
        // Invariant B: cleanup on every error path.
        cleanup()

        // Classify error (LlmError passes through unchanged). A cooperative
        // adapter that throws the signal's own abort reason (a DOMException, a
        // host cancellation error) is an abort, with that reason kept as cause.
        const err = classifyThrown(rawErr, ctx.signal)

        // Some providers return a billed HTTP 200 with no usable output. Keep
        // that attempt's usage and snapshot cost even though it is retryable.
        const failureNormalized =
          err.usage !== undefined ? normalizeUsage(err.usage) : undefined

        // Free the rate-limiter slot; a billed failure hands its usage over.
        try {
          release?.(failureNormalized?.usage)
        } catch {
          /* intentionally swallowed */
        }
        release = undefined
        const failureUsage =
          failureNormalized !== undefined
            ? failureNormalized.usage
            : (normalizedResult?.usage ?? EMPTY_USAGE)
        let failureCost = cost
        if (err.usage !== undefined) {
          try {
            const source = pricingSources[provider]
            failureCost = source?.price(
              callDescriptor.pricingFamily ?? callDescriptor.model,
              failureUsage,
              err.servedServiceTier ?? effectiveReq.config.serviceTier,
            )
            if (failureCost !== undefined && failureNormalized?.estimated === true) {
              failureCost = markEstimated(failureCost)
            }
          } catch (costErr) {
            ctx.logger.warn(
              { callId: ctx.callId, error: String(costErr) },
              'llm.call.cost.failed',
            )
          }
        }

        // Build postmortem record with whatever we know.
        // `dispatchStartMs` is only set immediately before `adapter.run()` is
        // called (Step 7). When it is still undefined here, the failure
        // happened before dispatch ever began — e.g. the rate limiter's
        // `acquire()` rejected, or the call was aborted/timed out while still
        // queued on `acquire()`. Provider-dispatch latency is zero in that
        // case; falling back to `attemptStartMs` would double-count the wait
        // already captured by `queueDelayMs` (see docs/ledger.md, SPEC.md).
        const latencyMs =
          dispatchStartMs !== undefined ? ctx.clock.now() - dispatchStartMs : 0
        const errorRecord = buildErrorRecord(
          ctx.callId,
          attemptId,
          callSiteId,
          provider,
          effectiveReq.model,
          request.metadata,
          effectiveReq.config,
          failureUsage,
          latencyMs,
          queueDelayMs,
          attemptStartMs,
          err,
          attemptNumber,
          request.externalId,
          authKeyIdOf(callAuth),
          request.tools?.map((t) => t.name),
          failureCost,
        )

        // Sink error record — fail-open. A payload is kept only for an attempt
        // that reached the adapter: one refused before dispatch sent nothing.
        await recordToSink(
          sink,
          errorRecord,
          ctx.logger,
          ctx.callId,
          sinkTimeoutMs,
          sinkInterrupts,
          scheduler,
          dispatchStartMs !== undefined
            ? payloadPlan?.({ errorMessage: err.message })
            : undefined,
        )
        // A failure that reported no usage is known to cost nothing only when
        // nothing was dispatched, or the provider answered with an error that is
        // never billed (see `failedAttemptCostsNothing`).
        noteAttemptCost(
          failureCost,
          err.usage === undefined &&
            normalizedResult === undefined &&
            failedAttemptCostsNothing(err, dispatchStartMs !== undefined),
        )
        lastFailure =
          err.usage !== undefined
            ? {
                usage: failureUsage,
                ...(failureCost !== undefined ? { cost: failureCost } : {}),
              }
            : undefined
        emitAttempt({
          callId: ctx.callId,
          attemptId,
          attemptNumber,
          provider,
          model: requestedModel,
          metadata: request.metadata ?? {},
          latencyMs,
          usage: failureUsage,
          ...(failureCost !== undefined ? { cost: failureCost } : {}),
          errorKind: err.kind,
          retryable: err.retryable,
          ...(err.reason !== undefined ? { reason: err.reason } : {}),
          ...(callSiteId !== undefined ? { callSiteId } : {}),
        })

        // Enrich the error with call context (idempotent — does not overwrite
        // if already set, e.g. by an outer middleware).
        attachCallContext(err, { callId: ctx.callId, attemptId })

        // Rethrow: the call-level epilogue (or retry middleware) handles
        // the final fate of this error.
        throw err
      }
    }

    // The handler at the bottom of the chain. It refuses to start once the
    // logical deadline has passed (a middleware sat on the time, or the call
    // already timed out and this is an orphaned continuation), and counts the
    // attempt as in flight for the whole of `runAttemptBody`, sink write
    // included, because that is when the attempt owns the deadline. When it
    // ends, the deadline learns whether it produced a result, which decides
    // whether a deadline that passed meanwhile fails the call or leaves the
    // billed result standing.
    async function runAttempt(
      incoming: ResolvedRequest,
      ctx: EngineCtx,
    ): Promise<LlmResult> {
      if (deadline.expired()) throw deadline.error()
      deadline.attemptStarted()
      let result: LlmResult | undefined
      try {
        result = await runAttemptBody(incoming, ctx)
        return result
      } catch (e) {
        if (e instanceof LlmError) lastAttemptError = e
        throw e
      } finally {
        deadline.attemptEnded(result)
      }
    }

    // ── Compose the middleware chain ───────────────────────────────────────
    // middleware[0] is outermost; runAttempt is innermost (reduceRight folds
    // from right so index-0 wraps everything else).
    //
    // Every middleware receives a guarded `next` (ADR-037): a request whose
    // provider or model differs from the call's is refused at the boundary,
    // before anything inside the offender (inner middleware, `runAttempt`)
    // runs. Hosts route and fall back themselves with a new call.
    // Highest attempt number any middleware handed down. A refused or failed
    // attempt never reaches `runAttempt`, so this is what the refusal row of
    // an attempt that did not run is numbered with.
    let boundaryAttemptNumber: number | undefined
    const guardBoundary =
      (next: Handler): Handler =>
      async (req, ctx) => {
        if (
          req.attemptNumber !== undefined &&
          (boundaryAttemptNumber === undefined ||
            req.attemptNumber > boundaryAttemptNumber)
        ) {
          boundaryAttemptNumber = req.attemptNumber
        }
        if (req.provider !== callProvider || req.model !== requestedModel) {
          throw new LlmError(
            'middleware may not change the provider or model; route in the host and make a new call.',
            {
              kind: 'bad_request',
              retryable: false,
              issues: [
                ...(req.provider !== callProvider
                  ? [
                      {
                        path: 'provider',
                        message: `call is for provider "${callProvider}", middleware passed "${String(req.provider)}".`,
                      },
                    ]
                  : []),
                ...(req.model !== requestedModel
                  ? [
                      {
                        path: 'model',
                        message: `call is for model "${requestedModel}", middleware passed "${String(req.model)}".`,
                      },
                    ]
                  : []),
              ],
            },
          )
        }
        // A middleware that swaps `modelDescriptor` (a quota policy reads it)
        // is overwritten here, so what inner middleware see is what dispatch
        // uses. Provider and model were checked above.
        return next(
          req.modelDescriptor === callDescriptor
            ? req
            : { ...req, modelDescriptor: callDescriptor },
          ctx,
        )
      }
    const chain: Handler = middleware.reduceRight(
      (next: Handler, mw: Middleware): Handler =>
        (req, ctx) =>
          mw.intercept(req, ctx, guardBoundary(next)),
      runAttempt,
    )

    // ── (c) Execute the chain with call-level epilogue ─────────────────────
    // telemetry.onSuccess / onError and the call-level logger events fire
    // ONCE here, after the chain (including any retry middleware) settles.
    try {
      // A signal that is already aborted never starts the call. The refusal
      // takes the same path as any other pre-attempt failure (one synthetic
      // row, `onError`, `llm.call.error`).
      if (callerSignal?.aborted === true) throw abortedError(callerSignal)

      // D4 (generate() path only) / D3: input-contract enforcement. Runs
      // immediately after callId allocation, BEFORE the middleware chain is
      // entered — before `@gullabs/quota` (never consumes budget on a
      // violation) and before the retry middleware (validated exactly once
      // per logical call, never per attempt). A throw here is caught by the
      // epilogue below exactly like a pre-attempt middleware refusal: the
      // same telemetry.onError / logger.error / D5 synthetic-record path.
      if (enforceInputContract && request.inputContract === undefined) {
        throw new LlmError(
          'createClient({ requireInputContract: true }): request is missing "inputContract".',
          {
            kind: 'bad_request',
            retryable: false,
            issues: [
              {
                path: 'inputContract',
                message:
                  'inputContract is required when requireInputContract is enabled.',
              },
            ],
          },
        )
      }
      if (request.inputContract !== undefined) {
        await validateInputContract(request.inputContract)
      }

      const chainResult = chain(preResolvedReq, engineCtx)
      // The deadline gate ends a call whose middleware (not an attempt) is
      // taking the time; the chain's own late result or error is then dropped.
      const chainedResult =
        deadline.gate === undefined
          ? await chainResult
          : await Promise.race([chainResult, deadline.gate])
      const latencyMs = clock.now() - callStartMs
      const callCost = callCostOf()
      const result =
        callCost !== undefined ? { ...chainedResult, callCost } : chainedResult
      try {
        const successEvent: CallSuccessEvent = {
          callId,
          attemptId: result.attemptId,
          provider: callProvider,
          model: requestedModel,
          metadata: request.metadata ?? {},
          latencyMs,
          usage: result.usage,
          ...(result.cost !== undefined ? { cost: result.cost } : {}),
          ...(callCost !== undefined ? { callCost } : {}),
          ...(callSiteId !== undefined ? { callSiteId } : {}),
        }
        telemetry.onSuccess?.(successEvent, span)
      } catch (err) {
        safeLogger.debug(
          { callId, phase: 'onSuccess', error: redactSecrets(String(err)) },
          'llm.telemetry.hook.failed',
        )
      }
      safeLogger.info(
        {
          callId,
          latencyMs,
          metadata: request.metadata ?? {},
          attemptNumber: lastAttemptNumber ?? 1,
        },
        'llm.call.success',
      )
      return result
    } catch (rawErr) {
      const err = classifyThrown(rawErr, deadline.signal)
      // An error with an attempt id came out of `runAttempt`, which already
      // wrote its row. Anything else was thrown by a middleware or the
      // prologue (input-contract refusal, boundary refusal, quota deferral,
      // retry budget exhausted, abort during back-off).
      const attemptRecorded = err.attemptId !== undefined
      // Ensure the error carries call context (idempotent). The call-level
      // attempt id is never stamped onto an error that did not come from that
      // attempt.
      attachCallContext(err, { callId })
      const latencyMs = clock.now() - callStartMs

      // D5: generic refusal row. "callId => the call's final error is in the
      // ledger" holds exceptionlessly (§0.4): when the final error did not come
      // from an attempt, write ONE synthetic zero-usage row (not billed).
      // `attemptNumber` is 0 when no attempt had run yet; otherwise it is the
      // number of the attempt that was refused (never below the last real
      // attempt + 1), so `error_reason` and the failure kind of a call that
      // ended in a middleware are always queryable. An attempt that a
      // middleware refused and the retry loop then re-ran leaves no row, so a
      // gap in attempt numbers means "refused before dispatch".
      //
      // Telemetry is deliberately unaffected: `CallErrorEvent.attemptId`
      // below still derives from the last real attempt, not from this
      // synthetic id, which has no telemetry counterpart.
      if (!attemptRecorded) {
        const syntheticAttemptId = ids.attemptId()
        const refusedAttemptNumber =
          lastAttemptNumber === undefined
            ? 0
            : Math.max(boundaryAttemptNumber ?? 0, lastAttemptNumber + 1)
        const syntheticRecord = buildErrorRecord(
          callId,
          syntheticAttemptId,
          callSiteId,
          callProvider,
          requestedModel,
          request.metadata,
          resolvedConfig,
          EMPTY_USAGE,
          0,
          undefined,
          callStartMs,
          err,
          refusedAttemptNumber,
          request.externalId,
          authKeyIdOf(callAuth),
          request.tools?.map((t) => t.name),
        )
        await recordToSink(
          sink,
          syntheticRecord,
          safeLogger,
          callId,
          sinkTimeoutMs,
          sinkInterrupts,
          scheduler,
        )
      }

      try {
        const attemptIdForEvent = err.attemptId ?? lastAttemptId
        const errorCallCost = callCostOf()
        const errorEvent: CallErrorEvent = {
          callId,
          provider: callProvider,
          model: requestedModel,
          metadata: request.metadata ?? {},
          latencyMs,
          errorKind: err.kind,
          retryable: err.retryable,
          ...(err.reason !== undefined ? { reason: err.reason } : {}),
          ...(callSiteId !== undefined ? { callSiteId } : {}),
          ...(attemptIdForEvent !== undefined ? { attemptId: attemptIdForEvent } : {}),
          // Usage and cost only when the failing attempt reported usage; a
          // failure that came from a refusal has none.
          ...(attemptRecorded && lastFailure !== undefined
            ? {
                usage: lastFailure.usage,
                ...(lastFailure.cost !== undefined ? { cost: lastFailure.cost } : {}),
              }
            : {}),
          ...(errorCallCost !== undefined ? { callCost: errorCallCost } : {}),
        }
        telemetry.onError?.(errorEvent, span)
      } catch (hookErr) {
        safeLogger.debug(
          {
            callId,
            phase: 'onError',
            error: redactSecrets(String(hookErr)),
          },
          'llm.telemetry.hook.failed',
        )
      }
      safeLogger.error(
        {
          callId,
          errorKind: err.kind,
          latencyMs,
          metadata: request.metadata ?? {},
          attemptNumber: lastAttemptNumber ?? 0,
        },
        'llm.call.error',
      )
      throw err
    } finally {
      deadline.cleanup()
    }
  }

  function validateFunctionCalling(
    request: LlmRequest,
    stateContinuation: boolean,
  ): void {
    const issues: LlmErrorIssue[] = []
    const tools = request.tools
    if (request.toolChoice !== undefined && (tools === undefined || tools.length === 0)) {
      issues.push({
        path: 'toolChoice',
        message: 'toolChoice is only valid when tools is present.',
      })
    }
    if (tools !== undefined && request.output?.jsonSchema !== undefined) {
      issues.push({
        path: 'tools',
        message: 'tools cannot be combined with structured output in this iteration.',
      })
    }
    const names = new Set<string>()
    if (tools !== undefined) {
      tools.forEach((tool, index) => {
        if (typeof tool.name !== 'string' || tool.name.length === 0) {
          issues.push({
            path: `tools.${index}.name`,
            message: 'tool name must be non-empty.',
          })
        } else if (names.has(tool.name)) {
          issues.push({
            path: `tools.${index}.name`,
            message: `tool name "${tool.name}" is duplicated.`,
          })
        } else {
          names.add(tool.name)
        }
        if (typeof tool.description !== 'string' || tool.description.length === 0) {
          issues.push({
            path: `tools.${index}.description`,
            message: 'tool description is required and must be non-empty.',
          })
        }
        if (
          tool.inputJsonSchema === null ||
          typeof tool.inputJsonSchema !== 'object' ||
          Array.isArray(tool.inputJsonSchema)
        ) {
          issues.push({
            path: `tools.${index}.inputJsonSchema`,
            message: 'inputJsonSchema must be an object schema.',
          })
        }
      })
    }
    if (request.toolChoice !== undefined && typeof request.toolChoice === 'object') {
      if (!names.has(request.toolChoice.name)) {
        issues.push({
          path: 'toolChoice.name',
          message: `toolChoice.name "${request.toolChoice.name}" is not a member of tools.`,
        })
      }
    }

    const seenCallIds: string[] = []
    request.messages.forEach((message, mi) => {
      if (message.role === 'assistant' && message.parts.length === 0) {
        issues.push({
          path: `messages.${mi}.parts`,
          message:
            'an assistant message must have at least one part; a result whose message has no parts (the provider returned only thoughts) is not appended to history.',
        })
      }
      message.parts.forEach((part, pi) => {
        if (isToolCallPart(part)) {
          if (message.role !== 'assistant') {
            issues.push({
              path: `messages.${mi}.parts.${pi}`,
              message: 'tool-call parts are only valid on assistant messages.',
            })
          }
          seenCallIds.push(part.toolCallId)
        }
        if (isToolResultPart(part)) {
          if (message.role !== 'user') {
            issues.push({
              path: `messages.${mi}.parts.${pi}`,
              message: 'tool-result parts are only valid on user messages.',
            })
          }
          // With `continuation: 'state'` the prior calls live in the state, not in
          // the messages, so pairing is checked by the adapter against the state.
          if (
            !(stateContinuation && request.transientProviderState !== undefined) &&
            !seenCallIds.includes(part.toolCallId)
          ) {
            issues.push({
              path: `messages.${mi}.parts.${pi}.toolCallId`,
              message: `tool-result toolCallId "${part.toolCallId}" does not match a prior tool-call.`,
            })
          }
        }
      })
    })

    if (issues.length > 0) {
      throw new LlmError('Invalid request messages or tools.', {
        kind: 'bad_request',
        retryable: false,
        issues,
      })
    }
  }

  /**
   * Validates what `registry.resolve` returned for (provider, model). The
   * registry is a public port, so a host registry may prefix-match or return a
   * fallback descriptor; the engine therefore re-checks the core invariants
   * (ADR-033): the descriptor belongs to the requested provider and the
   * requested string is its canonical id or a declared alias.
   */
  function checkDescriptor(
    descriptor: ModelDescriptor | undefined,
    provider: string,
    model: string,
  ): ModelDescriptor {
    if (descriptor === undefined) {
      throw new LlmError(unknownModelMessage(registry, provider, model), {
        kind: 'bad_request',
        retryable: false,
      })
    }
    if (descriptor.provider !== provider) {
      throw new LlmError(
        `Registry returned a descriptor for provider "${descriptor.provider}" when provider "${provider}" (model "${model}") was requested — refusing to validate against a mismatched provider.`,
        { kind: 'bad_request', retryable: false },
      )
    }
    if (descriptor.model !== model && !(descriptor.aliases ?? []).includes(model)) {
      throw new LlmError(
        `Registry returned the descriptor for model "${descriptor.model}" when model "${boundedModelText(model)}" was requested — model ids are matched exactly (canonical id or a declared alias).`,
        { kind: 'bad_request', retryable: false },
      )
    }
    return descriptor
  }

  /** `transientProviderState` is only valid on a model that declares `providerState`. */
  function assertProviderStateAdmitted(
    state: JsonValue | undefined,
    descriptor: ModelDescriptor,
    model: string,
  ): void {
    if (state !== undefined && descriptor.capabilities?.providerState !== true) {
      throw new LlmError(`Model "${model}" does not admit transientProviderState.`, {
        kind: 'bad_request',
        retryable: false,
      })
    }
  }

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  const impl = {
    async generate(request: LlmRequest, opts: GenerateOptions): Promise<LlmResult> {
      if (typeof request.provider !== 'string' || request.provider.length === 0) {
        throw new LlmError(
          'request.provider is required — model identity is (provider, model).',
          { kind: 'bad_request', retryable: false },
        )
      }
      // Call identity is captured here, synchronously, before the first await:
      // the request is the host's live object and may be reassigned (a
      // fallback loop reusing one object) while the call is still validating.
      const provider = request.provider
      const model = request.model
      const resolved = registry.resolve(provider, model)
      assertMessagesShape(request.messages, 'messages')
      validateFunctionCalling(request, resolved?.capabilities?.continuation === 'state')
      const runtimeOpts = opts as GenerateOptions | undefined
      const callAuth = requireAuth(runtimeOpts?.auth)
      const storePayload = resolveStorePayload(runtimeOpts?.storePayload)
      // Config resolution: libDefaults → request.config
      const descriptor = checkDescriptor(resolved, provider, model)
      assertProviderStateAdmitted(request.transientProviderState, descriptor, model)
      const merged = deepMergeConfig(libDefaults, request.config)
      const resolvedConfig = await validateResolvedConfig(model, descriptor, merged)
      return runPipeline(
        request,
        { provider, model },
        resolvedConfig,
        descriptor,
        request.callSiteId,
        runtimeOpts?.signal,
        callAuth,
        config.requireInputContract === true,
        storePayload,
      )
    },

    async runStructured(
      callSite: CallSite,
      varsOrOpts: Record<string, string> | RunStructuredOptions,
      opts?: RunStructuredOptions,
    ): Promise<LlmResult> {
      // D4: FIRST check in the runStructured prologue — before D2 validation,
      // D1 interpolation, and request building (before even the overload
      // detection / provider / auth checks below). Row-less (pre-callId).
      if (config.requireInputContract === true && callSite.inputSchema === undefined) {
        throw new LlmError(
          `createClient({ requireInputContract: true }): call site "${callSite.id}" is missing "inputSchema".`,
          {
            kind: 'bad_request',
            retryable: false,
            issues: [
              {
                path: 'inputSchema',
                message: 'inputSchema is required when requireInputContract is enabled.',
              },
            ],
          },
        )
      }

      // Detect overload: (callSite, opts) vs (callSite, vars, opts)
      let vars: Record<string, string>
      let resolvedOpts: RunStructuredOptions
      if (opts !== undefined) {
        // Three-arg form: (callSite, vars, opts)
        vars = varsOrOpts as Record<string, string>
        resolvedOpts = opts
      } else {
        // Two-arg form: (callSite, opts)
        vars = {}
        resolvedOpts = varsOrOpts as RunStructuredOptions
      }

      if (typeof callSite.provider !== 'string' || callSite.provider.length === 0) {
        throw new LlmError(
          'request.provider is required — model identity is (provider, model).',
          { kind: 'bad_request', retryable: false },
        )
      }

      const runtimeOpts = resolvedOpts as RunStructuredOptions | undefined
      const callAuth = requireAuth(runtimeOpts?.auth)
      const storePayload = resolveStorePayload(runtimeOpts?.storePayload)

      // Call identity captured before the first await (see `generate`).
      const provider = callSite.provider
      const model = callSite.model
      // Config resolution: libDefaults → callSite.config → opts.config
      const descriptor = checkDescriptor(
        registry.resolve(provider, model),
        provider,
        model,
      )
      const merged = deepMergeConfig(libDefaults, callSite.config, runtimeOpts?.config)
      const resolvedConfig = await validateResolvedConfig(model, descriptor, merged)

      // D2: opt-in callsite input contract. Runs before D1 so a missing/invalid
      // business field surfaces as the schema's own error, not a downstream
      // unresolved-placeholder violation.
      if (callSite.inputSchema !== undefined) {
        await validateCallSiteInput(callSite.id, callSite.inputSchema, vars)
      }

      // D1: strict template interpolation. Every {{var}} referenced by either
      // template must resolve to a string in vars, or the call is refused here
      // — before any request is built (row-less: this is the runStructured
      // prologue, pre-callId).
      assertTemplateVarsResolved(
        callSite.id,
        [callSite.userTemplate, callSite.system],
        vars,
      )

      // Render templates (non-recursive interpolation; every placeholder is
      // pre-validated above, so interpolate is total over its inputs).
      const userText =
        callSite.userTemplate !== undefined
          ? interpolate(callSite.userTemplate, vars)
          : ''
      const renderedSystem =
        callSite.system !== undefined ? interpolate(callSite.system, vars) : undefined

      // Option parity with `generate`: attachments extend the rendered user
      // message, history comes before it. A rendered message with no text and
      // no attachment would send an empty user turn, so it is refused here
      // (row-less, like the other prologue checks).
      const attachments = runtimeOpts?.attachments ?? []
      const history = runtimeOpts?.history ?? []
      assertPartsShape(attachments, 'attachments')
      assertMessagesShape(history, 'history')
      // A call site declares no tools, so a tool call or result has nothing to
      // refer to: refuse it here rather than send function-call history to a
      // provider with no declarations.
      const toolPath = (
        [
          ...attachments.map((part, i) => ({ part, path: `attachments[${i}]` })),
          ...history.flatMap((message, mi) =>
            message.parts.map((part, pi) => ({
              part,
              path: `history[${mi}].parts[${pi}]`,
            })),
          ),
        ] as Array<{ part: Part; path: string }>
      ).find(({ part }) => isToolCallPart(part) || isToolResultPart(part))
      if (toolPath !== undefined) {
        throw new LlmError(
          `${toolPath.path}: runStructured call sites declare no tools, so ${toolPath.part.kind} parts are not accepted; use generate for a tool loop.`,
          {
            kind: 'bad_request',
            retryable: false,
            issues: [
              { path: toolPath.path, message: `${toolPath.part.kind} is not accepted.` },
            ],
          },
        )
      }
      // Whitespace alone is as empty as the empty string: it is not a turn.
      if (userText.trim().length === 0 && attachments.length === 0) {
        throw new LlmError(
          `Call site "${callSite.id}" rendered an empty user message and no attachments were given; add a userTemplate that renders text, or pass attachments.`,
          {
            kind: 'bad_request',
            retryable: false,
            issues: [
              {
                path: 'userTemplate',
                message: 'rendered an empty user message and there are no attachments.',
              },
            ],
          },
        )
      }
      const userParts: Part[] = [
        ...(userText.trim().length > 0
          ? [{ kind: 'text' as const, text: userText }]
          : []),
        ...attachments,
      ]

      // Build the rendered request (no config on the request — already merged).
      const request: LlmRequest = {
        provider,
        model,
        messages: [...history, { role: 'user', parts: userParts }],
        ...(renderedSystem !== undefined ? { system: renderedSystem } : {}),
        ...(callSite.jsonSchema !== undefined
          ? { output: { jsonSchema: callSite.jsonSchema } }
          : {}),
        ...(runtimeOpts?.metadata !== undefined
          ? { metadata: runtimeOpts.metadata }
          : {}),
        ...(runtimeOpts?.externalId !== undefined
          ? { externalId: runtimeOpts.externalId }
          : {}),
        ...(runtimeOpts?.transientProviderState !== undefined
          ? { transientProviderState: runtimeOpts.transientProviderState }
          : {}),
      }
      validateFunctionCalling(request, descriptor.capabilities?.continuation === 'state')
      assertProviderStateAdmitted(request.transientProviderState, descriptor, model)

      return runPipeline(
        request,
        { provider, model },
        resolvedConfig,
        descriptor,
        callSite.id,
        runtimeOpts?.signal,
        callAuth,
        // `runStructured` never sets `LlmRequest.inputContract` (D3 is the
        // generate() path; this call site uses `CallSite.inputSchema`, D2) —
        // the requireInputContract precondition was already enforced above,
        // pre-callId, so runPipeline must not re-check it here.
        false,
        storePayload,
      )
    },

    async countTokens(
      request: TokenCountRequest,
      opts: CountTokensOptions,
    ): Promise<TokenCount> {
      if (typeof request.provider !== 'string' || request.provider.length === 0) {
        throw new LlmError(
          'request.provider is required — model identity is (provider, model).',
          { kind: 'bad_request', retryable: false },
        )
      }
      const runtimeOpts = opts as CountTokensOptions | undefined
      const callAuth = requireAuth(runtimeOpts?.auth)
      const countTimeoutMs = runtimeOpts?.timeoutMs
      if (countTimeoutMs !== undefined) {
        assertTimerMs(countTimeoutMs, 'countTokens: timeoutMs', 'timeoutMs')
      }

      const descriptor = checkDescriptor(
        registry.resolve(request.provider, request.model),
        request.provider,
        request.model,
      )

      const adapter = routeFn(request.provider, request.model, adapters)
      if (adapter.id !== request.provider) {
        throw new LlmError(
          `Adapter routing invariant violated: router returned adapter "${adapter.id}" ` +
            `for request provider "${request.provider}".`,
          { kind: 'bad_request', retryable: false },
        )
      }

      if (adapter.countTokens === undefined) {
        throw new LlmError(
          `Provider "${request.provider}" does not support token counting.`,
          { kind: 'bad_request', retryable: false },
        )
      }

      const countAdapterTokens = adapter.countTokens.bind(adapter)
      const callId = ids.callId()
      const startMs = clock.now()
      safeLogger.info(
        { callId, provider: request.provider, model: request.model },
        'llm.count_tokens.start',
      )

      // A signal that is already aborted never reaches the adapter.
      if (runtimeOpts?.signal?.aborted === true) {
        const err = abortedError(runtimeOpts.signal)
        attachCallContext(err, { callId })
        safeLogger.error(
          {
            callId,
            provider: request.provider,
            model: request.model,
            errorKind: err.kind,
            latencyMs: clock.now() - startMs,
          },
          'llm.count_tokens.error',
        )
        throw err
      }

      // Same cancellation race as a generation attempt: caller abort and
      // `timeoutMs` end the call even when the adapter ignores its signal.
      const cancellation = buildCancellationRace(
        runtimeOpts?.signal,
        countTimeoutMs,
        scheduler,
      )
      try {
        // An async wrapper turns a synchronous throw into a rejection the
        // race handles, instead of leaving a cancellation promise unhandled.
        const counting = (async () =>
          countAdapterTokens(request, {
            auth: callAuth,
            logger: safeLogger,
            modelDescriptor: descriptor,
            ...(cancellation.combinedSignal !== undefined
              ? { signal: cancellation.combinedSignal }
              : {}),
          }))()
        const result =
          cancellation.raceParts.length > 0
            ? await Promise.race([counting, ...cancellation.raceParts])
            : await counting
        cancellation.cleanup()
        const latencyMs = clock.now() - startMs
        safeLogger.info(
          {
            callId,
            provider: request.provider,
            model: request.model,
            totalTokens: result.totalTokens,
            latencyMs,
          },
          'llm.count_tokens.success',
        )
        return result
      } catch (rawErr) {
        cancellation.cleanup()
        const err = classifyThrown(rawErr, runtimeOpts?.signal)
        attachCallContext(err, { callId })
        const latencyMs = clock.now() - startMs
        safeLogger.error(
          {
            callId,
            provider: request.provider,
            model: request.model,
            errorKind: err.kind,
            latencyMs,
          },
          'llm.count_tokens.error',
        )
        throw err
      }
    },
  }

  // `generate`, `runStructured` and `countTokens` reject only with `LlmError`:
  // whatever else is thrown on the way (a host registry, a middleware, a bug)
  // is classified, with the original kept as `cause`.
  async function onlyLlmError<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (e) {
      throw classifyError(e)
    }
  }

  return {
    generate: (request: LlmRequest, opts: GenerateOptions): Promise<LlmResult> =>
      onlyLlmError(() => impl.generate(request, opts)),

    runStructured: (
      callSite: CallSite,
      varsOrOpts: Record<string, string> | RunStructuredOptions,
      opts?: RunStructuredOptions,
    ): Promise<LlmResult> =>
      onlyLlmError(() => impl.runStructured(callSite, varsOrOpts, opts)),

    countTokens: (
      request: TokenCountRequest,
      opts: CountTokensOptions,
    ): Promise<TokenCount> => onlyLlmError(() => impl.countTokens(request, opts)),
  }
}
