/**
 * @gullabs/testing — reusable test fakes for the any-llm library.
 *
 * ```ts
 * import {
 *   FakeClock,
 *   FakeIds,
 *   RecordingSink,
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
