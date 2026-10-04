/**
 * @gullabs/testing — reusable test fakes for the any-llm library.
 *
 * ```ts
 * import {
 *   FakeClock,
 *   FakeIds,
 *   RecordingSink,
 *   fakeLlmResult,
 *   fakeHttpError,
 *   fakeGeminiResponse,
 *   makeFakeGemini,
 * } from '@gullabs/testing'
 * ```
 *
 * @module
 */

export { FakeClock } from './clock.js'
export { FakeIds } from './ids.js'
export { RecordingSink } from './recording-sink.js'
export type { RecordingSinkOptions } from './recording-sink.js'
export { RecordingTelemetry } from './recording-telemetry.js'
export type { RecordedTelemetryEvent } from './recording-telemetry.js'
export { RecordingLogger } from './recording-logger.js'
export type { LogEntry, LogLevel } from './recording-logger.js'
export { fakeLlmResult } from './fake-llm-result.js'
export { FakeClient } from './fake-client.js'
export type { FakeClientCall, FakeClientEntry, FakeClientOptions } from './fake-client.js'
export {
  fakeHttpError,
  fakeNetworkError,
  fakeBilledFailure,
  fakeStreamFailure,
  fakeProviderError,
  HttpStatusError,
} from './errors.js'
export type {
  FakeHttpErrorOptions,
  FakeNetworkErrorOptions,
  FakeBilledFailureOptions,
  FakeStreamFailureOptions,
  FakeXaiProviderErrorOptions,
  GoogleErrorScenario,
  XaiErrorScenario,
} from './errors.js'
export { FakeGoogleFileStore } from './fake-google-file-store.js'
export type {
  FakeGoogleFileHandle,
  FakeGoogleFileDeleteOptions,
  FakeGoogleFileStoreOptions,
} from './fake-google-file-store.js'
export { FakeGoogleCacheStore } from './fake-google-cache-store.js'
export type {
  FakeGoogleCacheHandle,
  FakeGoogleCacheKey,
  FakeGoogleCacheCreateInput,
  FakeGoogleCacheStoreOptions,
} from './fake-google-cache-store.js'
export { FakeCliRunner } from './fake-cli-runner.js'
export type {
  FakeCliRunCall,
  FakeCliRunEntry,
  FakeCliRunOptions,
  FakeCliRunResult,
} from './fake-cli-runner.js'
export { fakeGeminiResponse, fakeGeminiBlocked, makeFakeGemini } from './fake-gemini.js'
export type {
  GeminiPartLike,
  GeminiContentLike,
  GeminiCandidateLike,
  GeminiUsageMetadataLike,
  GeminiResponseLike,
  FakeGeminiResponseOpts,
  FakeGeminiBlockedOpts,
  GeminiScript,
  GeminiCountTokensResponseLike,
  GeminiCountTokensScript,
  FakeGeminiModels,
  FakeGeminiClient,
} from './fake-gemini.js'
export { fakeXaiResponse, makeFakeXai } from './fake-xai.js'
export type {
  XaiReasoningSummaryPartLike,
  XaiReasoningOutputItemLike,
  XaiOutputTextPartLike,
  XaiFunctionCallOutputItemLike,
  XaiMessageOutputItemLike,
  XaiOutputItemLike,
  XaiUsageLike,
  XaiResponseLike,
  FakeXaiResponseOpts,
  XaiScript,
  FakeXaiClient,
} from './fake-xai.js'
export { FakeXaiFileStore } from './fake-xai-file-store.js'
export type {
  FakeXaiFileHandle,
  FakeXaiFileUploadInput,
  FakeXaiFileDeleteOptions,
  FakeXaiFileStoreOptions,
} from './fake-xai-file-store.js'
export { FakeAdapter } from './fake-adapter.js'
export type { FakeAdapterEntry } from './fake-adapter.js'
export { SignalAwareFakeAdapter } from './signal-aware-fake-adapter.js'
export type { SignalAwareFakeAdapterOptions } from './signal-aware-fake-adapter.js'
export { inMemoryRateLimiter, scriptedRateLimiter } from './rate-limiter.js'
export type {
  InMemoryRateLimiterOptions,
  ScriptedRateLimiterOptions,
} from './rate-limiter.js'
export { runToolLoop } from './tool-loop.js'
export type {
  ToolLoopClient,
  ToolImplementation,
  ToolLoopOptions,
  ToolLoopOutcome,
} from './tool-loop.js'
export { assertRegistryInvariants } from './registry-invariants.js'
export type { AssertRegistryInvariantsOptions } from './registry-invariants.js'
