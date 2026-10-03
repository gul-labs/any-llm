/**
 * Model descriptor registry for @gullabs/core.
 *
 * Centralises model/provider knowledge. Descriptors are keyed by the pair
 * (`provider`, `model`) with exact matching plus declared aliases; unknown pairs
 * fail fast at call time.
 *
 * Core owns only the generic registry machinery — zero provider knowledge.
 * Each provider package (e.g. `@gullabs/google`) builds and exports its own
 * descriptor arrays via {@link createModelRegistry}.
 *
 * @module
 */

import type * as z from 'zod'

import { LlmError } from './errors.js'
import { toConfigJsonSchema, toConfigKeys } from './model-config/index.js'
import type { StandardSchemaV1 } from './standard-schema.js'
import type { JsonValue, Message, ReasoningEffort, Warning } from './types.js'

/**
 * Token limits of a model, taken from the provider's own documentation (the
 * descriptor's source comment names the page and the date it was read). A
 * number here is a figure the provider publishes; nothing is estimated.
 */
export interface ModelLimits {
  /**
   * Total tokens the model can hold in one call, input and output together as
   * the provider states it.
   */
  contextWindow: number
  /**
   * Largest `maxOutputTokens` the provider documents for the model. It counts
   * reasoning tokens on providers that reason. `null` means the provider
   * documents no output limit for this model: the descriptor does not invent
   * one, the config schema applies no cap, and the provider decides what it
   * accepts. Never read `null` as "unlimited" or as the context window. A
   * number is the schema's cap: `maxOutputTokens` above it is `bad_request`.
   */
  maxOutputTokens: number | null
}

export interface ModelDescriptor {
  /**
   * Canonical provider-native model identifier. Resolution is exact: a request
   * resolves to this descriptor only when its model string equals `model` or
   * one of {@link ModelDescriptor.aliases}. There is no prefix matching, so an
   * unregistered sibling (e.g. `"gemini-2.5-flash-image"` next to
   * `"gemini-2.5-flash"`) is never priced or validated as this model. Identity
   * for a descriptor is the pair (`provider`, `model`); the same bare `model`
   * string may be registered under multiple providers with different config
   * schemas.
   */
  model: string
  /**
   * Additional model strings that the provider serves as this same model
   * (real version suffixes such as a dated snapshot id). A request may name the
   * model by its canonical id or by any alias; the request string is forwarded
   * to the provider unchanged and the call is priced under this descriptor.
   * An alias must be unique within the provider and must not equal any
   * descriptor's canonical `model`.
   */
  aliases?: readonly string[]
  /** Provider identifier (e.g. `"google"`). Must match the adapter's `id`. */
  provider: string
  /**
   * Key into the pricing table (e.g. `"gemini-2.5-pro"`).
   * When omitted, the canonical {@link ModelDescriptor.model} is the pricing
   * key. Lookup is exact; there is no prefix matching.
   */
  pricingFamily?: string
  /**
   * Token limits from the provider's documentation. Required: every descriptor
   * states them, so hosts can size a call without a provider round trip.
   */
  limits: ModelLimits
  /**
   * The date the provider has announced it will stop serving this model, as
   * `YYYY-MM-DD` (UTC). Absent when no shutdown is announced. A successful call
   * to a model within {@link SHUTDOWN_WARNING_DAYS} days of this date, or past
   * it, carries a `warnings` entry naming the date. The call is never refused
   * for it: the provider decides what it still serves. Cite the provider page
   * and the date it was read next to the value.
   */
  shutdownDate?: string
  /** Capability flags for routing and adapter logic. */
  capabilities?: {
    reasoning?: boolean
    structuredOutput?: boolean
    nativeStructuredOutput?: boolean
    /**
     * What media the model accepts in `inline-media` and `file-uri` parts, as
     * the provider documents it. This is the one statement of multimodal
     * support (there are no separate `vision` / `audioInput` flags to
     * disagree with it): a host asks whether the model takes images with
     * {@link isMediaTypeAdmitted}. Each entry is a lower-case IANA media type
     * (`image/png`) or a family wildcard (`image/*`, every subtype of that
     * family) for providers that document a family, not a closed list.
     * Adapters reject any other media type with `bad_request` before dispatch
     * (see {@link assertInputMimeTypesAdmitted}); the match ignores case and
     * `; parameters`, and the string sent to the provider is never rewritten.
     * Absent or empty: the model admits no media part. Text, tool-call and
     * tool-result parts are not media.
     */
    inputMimeTypes?: readonly string[]
    reasoningApi?: 'budget' | 'level'
    admittedReasoningEfforts?: ReadonlyArray<ReasoningEffort>
    sampling?: 'tunable' | 'fixed'
    caching?: { explicit: boolean; minTokens: number }
    grounding?: boolean
    /**
     * Structured output combined with provider built-in tools (Google:
     * `googleSearch`). `true`: admitted by default. `false`: a capture showed
     * Search missing, so the call is rejected unless the host opts in per call.
     * Absent: never measured, so the adapter rejects the combination even with
     * the opt-in. The adapter reads this flag and carries no per-model list.
     */
    structuredOutputWithTools?: boolean
    functionCalling?: boolean
    /**
     * How the next turn of a tool loop is sent (repeated on every
     * `LlmResult.continuation`). Absent means `'history'`.
     *
     * - `'history'`: the host appends `result.message` to its history and sends
     *   the full history (plus `result.transientProviderState` when the model
     *   declares {@link providerState}).
     * - `'state'`: `result.transientProviderState` holds the provider's own
     *   output; the next request sends only the new messages plus the state.
     *   Requires {@link providerState}.
     */
    continuation?: 'history' | 'state'
    /**
     * The model returns and accepts `transientProviderState`. The engine rejects
     * state on a model that does not declare it. Provider-scoped and bound to the
     * requested model string; each adapter defines the shape.
     */
    providerState?: boolean
    serviceTiers?: readonly string[]
  }
  /** Zod runtime schema for the full per-model config contract. */
  configSchema: z.ZodType
  /**
   * Every top-level config key the model's schema names, sorted: the keys of
   * each object shape, across all branches of a union (Gemini's tier branches
   * name `serviceTier` differently, so the key appears once). Derive it with
   * {@link toConfigKeys}; `createModelRegistry` rejects a descriptor whose
   * list differs from what its `configSchema` names. It lists names only: a key
   * can be admitted on one branch and not another, so the schema stays the
   * authority for what a given config may hold.
   */
  configKeys: readonly string[]
  /**
   * JSON Schema derived from {@link configSchema} with {@link toConfigJsonSchema};
   * `createModelRegistry` rejects a descriptor whose value differs.
   */
  configJsonSchema: JsonValue
  /** Standard Schema adapter derived from {@link configSchema}. */
  validateConfig: StandardSchemaV1
}

export interface ModelRegistry {
  /** The descriptor for `model` (canonical id or declared alias) under `provider`, exact match. */
  resolve(provider: string, model: string): ModelDescriptor | undefined
  /**
   * Every descriptor that names `model` as its canonical id or a declared alias,
   * across providers, in registration order; empty when none does. The same
   * bare id may be registered under several providers (ADR-022), so this
   * returns all of them instead of picking one: a caller that has no provider
   * yet uses it to find the candidates, then calls `resolve` with the provider
   * it chose. Exact match, like `resolve`.
   */
  findByModel(model: string): readonly ModelDescriptor[]
  /**
   * Every registered descriptor, in registration order (a copy). Like `resolve`
   * and `findByModel`, it answers from the list the registry was built with:
   * descriptors added to the caller's array afterwards are not part of it.
   */
  listDescriptors(): readonly ModelDescriptor[]
}

/** A media type's `type` and `subtype` token (RFC 6838, lower case). */
const MEDIA_TOKEN = '[a-z0-9][a-z0-9!#$&^_.+-]*'
const MEDIA_ESSENCE = new RegExp(`^${MEDIA_TOKEN}/${MEDIA_TOKEN}$`)
const MEDIA_ADMISSION_ENTRY = new RegExp(`^${MEDIA_TOKEN}/(?:${MEDIA_TOKEN}|\\*)$`)

function assertConfigKeys(descriptor: ModelDescriptor): void {
  const where = `Model descriptor for provider "${descriptor.provider}" model "${descriptor.model}"`
  const declared: unknown = (descriptor as Partial<ModelDescriptor>).configKeys
  if (!Array.isArray(declared)) {
    throw new LlmError(`${where} is missing required configKeys.`, {
      kind: 'bad_request',
      retryable: false,
    })
  }
  // The keys and the JSON Schema are recomputed from the real `configSchema`:
  // a declared artifact is only trusted when it equals what the schema yields.
  const expectedJsonSchema = toConfigJsonSchema(descriptor.configSchema)
  if (
    JSON.stringify(descriptor.configJsonSchema) !== JSON.stringify(expectedJsonSchema)
  ) {
    throw new LlmError(
      `${where} has a stale configJsonSchema: it differs from toConfigJsonSchema(configSchema).`,
      { kind: 'bad_request', retryable: false },
    )
  }
  const expected = toConfigKeys(descriptor.configSchema)
  if (
    declared.length !== expected.length ||
    declared.some((key, i) => key !== expected[i])
  ) {
    throw new LlmError(
      `${where} has stale configKeys [${declared.map(String).join(', ')}]: its configSchema names [${expected.join(', ')}]. Derive configKeys with toConfigKeys(configSchema).`,
      { kind: 'bad_request', retryable: false },
    )
  }
}

function assertLimits(descriptor: Partial<ModelDescriptor>): void {
  const where = `Model descriptor for provider "${descriptor.provider ?? '<unknown>'}" model "${
    descriptor.model ?? '<unknown>'
  }"`
  const limits = descriptor.limits as Partial<ModelLimits> | null | undefined
  if (limits === undefined || limits === null || typeof limits !== 'object') {
    throw new LlmError(`${where} is missing required limits.`, {
      kind: 'bad_request',
      retryable: false,
    })
  }
  const isCount = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
  if (!isCount(limits.contextWindow)) {
    throw new LlmError(
      `${where} has invalid limits.contextWindow: expected a positive integer.`,
      { kind: 'bad_request', retryable: false },
    )
  }
  // `null` is the documented "the provider publishes no output limit"; an
  // omitted value is a mistake, so it is refused instead of read as `null`.
  if (limits.maxOutputTokens !== null && !isCount(limits.maxOutputTokens)) {
    throw new LlmError(
      `${where} has invalid limits.maxOutputTokens: expected a positive integer, or null when the provider documents no output limit.`,
      { kind: 'bad_request', retryable: false },
    )
  }
  if (limits.maxOutputTokens !== null && limits.maxOutputTokens > limits.contextWindow) {
    throw new LlmError(
      `${where} declares limits.maxOutputTokens above limits.contextWindow.`,
      {
        kind: 'bad_request',
        retryable: false,
      },
    )
  }
}

/** A successful call to a model this close to its `shutdownDate` (or past it) warns. */
export const SHUTDOWN_WARNING_DAYS = 90

const SHUTDOWN_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Midnight UTC of a `YYYY-MM-DD` date, or `undefined` for anything else (including 2027-02-30). */
function parseShutdownDate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const m = SHUTDOWN_DATE_RE.exec(value)
  if (m === null) return undefined
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return new Date(ms).toISOString().startsWith(value) ? ms : undefined
}

function assertShutdownDate(descriptor: Partial<ModelDescriptor>): void {
  if (descriptor.shutdownDate === undefined) return
  if (parseShutdownDate(descriptor.shutdownDate) === undefined) {
    throw new LlmError(
      `Model descriptor for provider "${descriptor.provider ?? '<unknown>'}" model "${
        descriptor.model ?? '<unknown>'
      }" has an invalid shutdownDate: expected a real calendar date as YYYY-MM-DD.`,
      { kind: 'bad_request', retryable: false },
    )
  }
}

/**
 * The advisory for a model announced to shut down: `undefined` until `nowMs` is
 * within {@link SHUTDOWN_WARNING_DAYS} days of the descriptor's `shutdownDate`,
 * then a `shutdown` warning naming the date and the days left (or gone by). The
 * engine attaches it once per client and model; this function is the pure rule.
 */
export function shutdownWarning(
  descriptor: Pick<ModelDescriptor, 'model' | 'shutdownDate'>,
  nowMs: number,
): Warning | undefined {
  const shutdownMs = parseShutdownDate(descriptor.shutdownDate)
  if (shutdownMs === undefined || descriptor.shutdownDate === undefined) return undefined
  if (!Number.isFinite(nowMs)) return undefined
  const days = Math.ceil((shutdownMs - nowMs) / 86_400_000)
  if (days > SHUTDOWN_WARNING_DAYS) return undefined
  const { model, shutdownDate } = descriptor
  const message =
    days > 0
      ? `Model "${model}" is scheduled to shut down on ${shutdownDate} (in ${days} day${days === 1 ? '' : 's'}); move to a model without a shutdown date before then.`
      : days === 0
        ? `Model "${model}" is scheduled to shut down today (${shutdownDate}); move to a model without a shutdown date.`
        : `Model "${model}" was scheduled to shut down on ${shutdownDate} (${-days} day${days === -1 ? '' : 's'} ago) and may stop being served at any time; move to a model without a shutdown date.`
  return { type: 'shutdown', message, shutdownDate }
}

function assertDescriptorSchemaArtifacts(descriptor: Partial<ModelDescriptor>): void {
  const missing: string[] = []
  if (descriptor.configSchema === undefined) missing.push('configSchema')
  if (descriptor.configJsonSchema === undefined) missing.push('configJsonSchema')
  if (descriptor.validateConfig === undefined) missing.push('validateConfig')

  if (missing.length > 0) {
    throw new LlmError(
      `Model descriptor for provider "${descriptor.provider ?? '<unknown>'}" model "${
        descriptor.model ?? '<unknown>'
      }" is missing required schema artifacts: ${missing.join(', ')}.`,
      {
        kind: 'bad_request',
        retryable: false,
      },
    )
  }
}

function assertInputMimeTypes(descriptor: ModelDescriptor): void {
  const list: unknown = descriptor.capabilities?.inputMimeTypes
  if (list === undefined) return
  const where = `Model descriptor for provider "${descriptor.provider}" model "${descriptor.model}"`
  if (!Array.isArray(list)) {
    throw new LlmError(`${where} has inputMimeTypes that is not an array.`, {
      kind: 'bad_request',
      retryable: false,
    })
  }
  const seen = new Set<unknown>()
  for (const entry of list) {
    if (
      typeof entry !== 'string' ||
      entry !== entry.toLowerCase() ||
      !MEDIA_ADMISSION_ENTRY.test(entry) ||
      seen.has(entry)
    ) {
      throw new LlmError(
        `${where} has an invalid or duplicate inputMimeTypes entry ${JSON.stringify(entry)}: expected a lower-case "type/subtype" or "type/*", listed once.`,
        { kind: 'bad_request', retryable: false },
      )
    }
    seen.add(entry)
  }
}

function assertContinuationCapabilities(descriptor: ModelDescriptor): void {
  if (
    descriptor.capabilities?.continuation === 'state' &&
    descriptor.capabilities.providerState !== true
  ) {
    throw new LlmError(
      `Model descriptor for provider "${descriptor.provider}" model "${descriptor.model}" declares continuation "state" without providerState: true.`,
      { kind: 'bad_request', retryable: false },
    )
  }
}

/** Composite key for the exact (provider, model) match map. */
function descriptorKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`
}

/**
 * Adapter-side guard: the descriptor the engine resolved for this call must
 * belong to this adapter's provider and to the model the request names.
 *
 * `descriptor.provider` must equal both `req.provider` and `adapterProvider`,
 * and `req.model` must be the descriptor's canonical id or one of its declared
 * {@link ModelDescriptor.aliases}. The request string is never rewritten: the
 * adapter forwards `req.model` to the provider exactly as the host sent it.
 * Throws `LlmError('bad_request')` otherwise.
 */
export function assertModelMatchesDescriptor(
  req: { readonly provider: string; readonly model: string },
  descriptor: ModelDescriptor | undefined,
  adapterProvider: string,
): asserts descriptor is ModelDescriptor {
  if (
    descriptor === undefined ||
    descriptor.provider !== adapterProvider ||
    descriptor.provider !== req.provider ||
    (descriptor.model !== req.model && !(descriptor.aliases ?? []).includes(req.model))
  ) {
    throw new LlmError(
      `No matching ${adapterProvider} model descriptor for "${req.model}"` +
        (descriptor === undefined
          ? '.'
          : ` (descriptor is provider "${descriptor.provider}" model "${descriptor.model}").`),
      { kind: 'bad_request', retryable: false },
    )
  }
}

/**
 * The media type of a MIME string as the admission check reads it: parameters
 * (`; charset=utf-8`) dropped, surrounding whitespace trimmed, lower-cased.
 * Used for matching only; the string sent to a provider is never replaced by
 * this.
 */
function mediaTypeEssence(mimeType: string): string {
  const semicolon = mimeType.indexOf(';')
  return (semicolon === -1 ? mimeType : mimeType.slice(0, semicolon)).trim().toLowerCase()
}

/**
 * Whether `mimeType` is admitted by `admitted` (a descriptor's
 * {@link ModelDescriptor.capabilities}`.inputMimeTypes`). Case and `; parameters`
 * are ignored; an entry `family/*` admits every `family/<subtype>`. An empty or
 * malformed string is never admitted. Nothing is mapped: `image/jpg` is not
 * `image/jpeg`.
 */
export function isMediaTypeAdmitted(
  mimeType: string,
  admitted: readonly string[],
): boolean {
  if (typeof mimeType !== 'string') return false
  const essence = mediaTypeEssence(mimeType)
  if (!MEDIA_ESSENCE.test(essence)) return false
  const family = `${essence.slice(0, essence.indexOf('/'))}/*`
  return admitted.includes(essence) || admitted.includes(family)
}

/**
 * Throws `LlmError('bad_request')` unless `mimeType` is admitted by `admitted`
 * (see {@link isMediaTypeAdmitted}). An empty or missing media type gets its own
 * message, since no list can admit it. The one rule behind
 * {@link assertInputMimeTypesAdmitted} and any other place that takes a media
 * type before a call (a file upload, for one), so they cannot disagree.
 *
 * @param path - Where the media type was given, for the message and `issues`.
 * @param subject - The provider and model (or operation) the list belongs to.
 */
export function assertMediaTypeAdmitted(
  mimeType: unknown,
  admitted: readonly string[],
  path: string,
  provider: string,
  subject: string,
): void {
  const missing = typeof mimeType !== 'string' || mediaTypeEssence(mimeType).length === 0
  if (!missing && isMediaTypeAdmitted(mimeType, admitted)) return
  const shown = missing ? '' : boundedModelText(mimeType)
  const list =
    admitted.length === 0
      ? 'it admits no media input'
      : `admitted types: ${admitted.join(', ')}`
  const message = missing
    ? `${path}: a media type is required for ${subject}, got ${
        typeof mimeType === 'string' ? 'an empty string' : String(mimeType)
      } (${list}).`
    : `${path}: ${subject} does not accept media type "${shown}" (${list}).`
  throw new LlmError(message, {
    kind: 'bad_request',
    retryable: false,
    provider,
    issues: [
      {
        path,
        message: missing
          ? 'a media type is required'
          : `media type "${shown}" is not admitted`,
      },
    ],
  })
}

/**
 * Adapter-side guard: every `inline-media` and `file-uri` part in `messages`
 * must carry a media type the descriptor admits
 * ({@link ModelDescriptor.capabilities}`.inputMimeTypes`). The match ignores
 * case and `; parameters` and the string the host sent is forwarded unchanged;
 * an empty or missing media type is refused. Throws `LlmError('bad_request')`
 * naming the first offending part and the admitted types.
 */
export function assertInputMimeTypesAdmitted(
  messages: readonly Message[],
  descriptor: ModelDescriptor,
  adapterProvider: string,
): void {
  const admitted = descriptor.capabilities?.inputMimeTypes ?? []
  messages.forEach((message, mi) => {
    message.parts.forEach((part, pi) => {
      if (part.kind !== 'inline-media' && part.kind !== 'file-uri') return
      assertMediaTypeAdmitted(
        part.mimeType,
        admitted,
        `messages[${mi}].parts[${pi}]`,
        adapterProvider,
        `${adapterProvider} model "${descriptor.model}"`,
      )
    })
  })
}

/** Longest model string echoed in a message or scored for suggestions. */
const MAX_MODEL_TEXT = 128

/**
 * A host that forwards user-chosen model names must not pay CPU or log volume
 * proportional to the string it was handed: cap it before it is scored or
 * echoed.
 *
 * @internal
 */
export function boundedModelText(model: string): string {
  const text = String(model)
  return text.length <= MAX_MODEL_TEXT
    ? text
    : `${text.slice(0, MAX_MODEL_TEXT)}… (${text.length} characters)`
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = curr
  }
  return prev[b.length] ?? 0
}

/**
 * Builds the `bad_request` message for a (provider, model) pair the registry
 * does not know, naming the closest registered ids (canonical ids and
 * aliases) of the same provider when the registry can list them.
 *
 * @internal
 */
export function unknownModelMessage(
  registry: ModelRegistry,
  provider: string,
  model: string,
): string {
  const shown = boundedModelText(model)
  const scored = String(model).slice(0, MAX_MODEL_TEXT)
  const base = `No registered model for provider "${boundedModelText(provider)}" model "${shown}".`
  const candidates: string[] = []
  for (const d of registry.listDescriptors()) {
    if (d.provider !== provider) continue
    candidates.push(d.model, ...(d.aliases ?? []))
  }
  if (candidates.length === 0) return base
  const closest = candidates
    .map((id) => ({ id, distance: levenshtein(scored, id) }))
    .sort((x, y) => x.distance - y.distance || x.id.localeCompare(y.id))
    .slice(0, 3)
    .map((c) => `"${c.id}"`)
  return `${base} Model ids are matched exactly; closest registered ids: ${closest.join(', ')}.`
}

export function createModelRegistry(input: readonly ModelDescriptor[]): ModelRegistry {
  // One snapshot: every answer below comes from this list, not from an array the
  // caller can still change.
  const descriptors = input.slice()
  // Exact (provider, model-or-alias) -> descriptor. No prefix matching.
  const exactMap = new Map<string, ModelDescriptor>()

  for (const descriptor of descriptors) {
    assertDescriptorSchemaArtifacts(descriptor)
    assertConfigKeys(descriptor)
    assertLimits(descriptor)
    assertShutdownDate(descriptor)
    assertInputMimeTypes(descriptor)
    assertContinuationCapabilities(descriptor)
    // A table shared by several descriptors must not be writable through any
    // one of them (the checks above ran once, at construction).
    Object.freeze(descriptor.limits)
    if (descriptor.capabilities?.inputMimeTypes !== undefined) {
      Object.freeze(descriptor.capabilities.inputMimeTypes)
    }
    Object.freeze(descriptor.configKeys)
    if (descriptor.aliases !== undefined) Object.freeze(descriptor.aliases)

    const key = descriptorKey(descriptor.provider, descriptor.model)
    if (exactMap.has(key)) {
      throw new LlmError(
        `Duplicate model descriptor for provider "${descriptor.provider}" model "${descriptor.model}"`,
        {
          kind: 'bad_request',
          retryable: false,
        },
      )
    }
    exactMap.set(key, descriptor)
  }

  // Aliases are registered after every canonical id so an alias can never
  // shadow, or be shadowed by, a canonical id regardless of descriptor order.
  for (const descriptor of descriptors) {
    for (const alias of descriptor.aliases ?? []) {
      if (typeof alias !== 'string' || alias.length === 0) {
        throw new LlmError(
          `Model descriptor for provider "${descriptor.provider}" model "${descriptor.model}" declares an empty or non-string alias.`,
          { kind: 'bad_request', retryable: false },
        )
      }
      const key = descriptorKey(descriptor.provider, alias)
      if (exactMap.has(key)) {
        throw new LlmError(
          `Model alias "${alias}" of provider "${descriptor.provider}" model "${descriptor.model}" collides with an existing model id or alias.`,
          { kind: 'bad_request', retryable: false },
        )
      }
      exactMap.set(key, descriptor)
    }
  }

  // Bare model string (canonical id or alias) -> descriptors, across providers.
  const byModel = new Map<string, ModelDescriptor[]>()
  const addByModel = (model: string, descriptor: ModelDescriptor): void => {
    const list = byModel.get(model)
    if (list === undefined) byModel.set(model, [descriptor])
    else if (!list.includes(descriptor)) list.push(descriptor)
  }
  for (const descriptor of descriptors) {
    addByModel(descriptor.model, descriptor)
    for (const alias of descriptor.aliases ?? []) addByModel(alias, descriptor)
  }

  return {
    resolve(provider: string, model: string): ModelDescriptor | undefined {
      return exactMap.get(descriptorKey(provider, model))
    },
    findByModel(model: string): readonly ModelDescriptor[] {
      return (byModel.get(model) ?? []).slice()
    },
    listDescriptors(): readonly ModelDescriptor[] {
      return descriptors.slice()
    },
  }
}
