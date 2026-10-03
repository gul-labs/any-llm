/**
 * @gullabs/core — public surface re-exports.
 *
 * Import from `@gullabs/core` to access types, errors, port interfaces, and
 * the record builder.  Nothing else is exported; internal helpers are kept
 * module-private.
 *
 * @module
 */

export type { StandardSchemaV1 } from './standard-schema.js'

// Core types
export type {
  JsonValue,
  CallMetadata,
  TextPart,
  InlineMediaPart,
  FileUriPart,
  FileRefPart,
  ToolCallPart,
  ToolResultPart,
  Part,
  Message,
  ToolDefinition,
  ToolChoice,
  ReasoningEffort,
  ReasoningIntent,
  ProviderOptions,
  ProviderOptionsMap,
  GenConfig,
  LlmRequest,
  FinishReason,
  Warning,
  Usage,
  Cost,
  Citation,
  LlmResult,
} from './types.js'
export {
  isTextPart,
  isInlineMediaPart,
  isFileUriPart,
  isFileRefPart,
  isToolCallPart,
  isToolResultPart,
} from './types.js'

// Errors
export type {
  LlmErrorKind,
  LlmErrorReason,
  LlmErrorOptions,
  LlmErrorIssue,
  HttpClassification,
  RetryAfterHeaders,
} from './errors.js'
export {
  LlmError,
  classifyHttpStatus,
  classifyError,
  causeChain,
  isTransportError,
  parseRetryAfter,
} from './errors.js'

// Ports
export type {
  ResolvedRequest,
  AdapterCtx,
  AdapterResult,
  ProviderAdapter,
  UsageSink,
  PricingSource,
  AuthMaterial,
  ApiKeyAuth,
  CliSessionAuth,
  Clock,
  IdGenerator,
  Logger,
  Telemetry,
  // Telemetry event types
  CallStartEvent,
  CallSuccessEvent,
  CallErrorEvent,
  RateLimiter,
  Release,
  // Middleware seam
  EngineCtx,
  Handler,
  Middleware,
  // Token counting
  TokenCountRequest,
  TokenCount,
} from './ports.js'

// Record
export type { LlmCallRecord, BuildRecordInput } from './record.js'
export { buildRecord, errorKindToStatus, normalizeUsage } from './record.js'

// Pricing shapes (generic — no provider pricing tables live in core)
export type { ModelRates } from './pricing.js'

// Cost computation
export { computeCost } from './cost.js'
export type { CostRatesLookup } from './cost.js'

// Engine
export type {
  ClientConfig,
  GenerateOptions,
  CountTokensOptions,
  RunStructuredOptions,
  Client,
} from './engine.js'
export { createClient } from './engine.js'

// Provider plugin composition
export type { ProviderPlugin } from './plugin.js'
export { composeProviders } from './plugin.js'

// Model registry
export type { ModelDescriptor, ModelLimits, ModelRegistry } from './registry.js'
export {
  createModelRegistry,
  assertModelMatchesDescriptor,
  assertInputMimeTypesAdmitted,
} from './registry.js'
export {
  toConfigJsonSchema,
  toConfigKeys,
  zodToStandardSchema,
} from './model-config/index.js'

// Call site
export type { CallSite } from './callsite.js'
export { defineCallSite } from './callsite.js'

// In-memory rate limiter (production-ready, dependency-free)
export { inMemoryRateLimiter } from './rate-limiter.js'
export type { InMemoryRateLimiterOptions } from './rate-limiter.js'

// Retry middleware
export type { RetryPolicy } from './retry.js'
export { retryMiddleware, computeBackoffMs } from './retry.js'

// Advisory spend preflight
export type { SpendPreflightOptions } from './spend-preflight.js'
export { spendPreflightMiddleware } from './spend-preflight.js'

// Utilities
export { canonicalJson } from './canonical-json.js'

export { assertNever } from './assert.js'

// JSON Schema contract (ADR-034)
export type { JsonSchemaProfile } from './json-schema.js'
export {
  assertStandardJsonSchema,
  assertJsonSchemaProfile,
  assertPortableJsonSchema,
  PORTABLE_JSON_SCHEMA_KEYWORDS,
  PORTABLE_JSON_SCHEMA_FORMATS,
} from './json-schema.js'

// Secret redaction (best-effort; for persisted/logged error text)
export { redactSecrets } from './redact.js'

/** Library version — kept in sync with `package.json`. */
export const VERSION = '0.0.0'
