---
'@gullabs/testing': minor
'@gullabs/google': minor
---

The whole-adapter fakes throw what the real adapters throw, and the fakes mirror the real stores and clock contract more closely.

- `FakeAdapter`, `SignalAwareFakeAdapter` and `FakeClient` run an error built by `fakeProviderError` through the real provider classifier (`classifyGoogleError` / `classifyXaiError`) before throwing, as the real adapter classifies the SDK's error. A per-day Gemini quota is now `rate_limited`, `retryable: false`, `reason: 'daily_quota'` (a retry loop stops; it used to be retried), exhausted xAI credits are `credits_exhausted`, a bad Gemini key is `invalid_auth`, a stale cache is `bad_request` / `cache_not_found`, and the error is an `LlmError`. `fakeProviderError` itself still returns the raw SDK error, which the SDK-level fakes (`makeFakeGemini`, `makeFakeXai`) hand to the real adapter. Tests run each scenario through a `FakeAdapter` and through the real adapter and require equal results. `@gullabs/google` and `@gullabs/xai` are new optional peer dependencies of `@gullabs/testing` (exact release version, like core), loaded the first time such an error is thrown.
- `FakeClient` rejects only with `LlmError`, like a real `Client`: an `Error` entry is classified with core's `classifyError` (the original is the `cause`), so `fakeHttpError(503)` arrives as `server`.
- `FakeClock`'s `now`, `setTimeout`, `clearTimeout`, `advance`, `advanceAsync` and `set` work detached (`Clock` and `Scheduler` methods are `this: void`). `advance`, `advanceAsync` and `set` throw `RangeError` for `NaN`, an infinite amount and (for `advance`) a negative one; an `advance` inside a timer callback is allowed and time never ends behind the furthest target.
- Concurrent delayed `FakeAdapter` calls each take their own scripted entry (they used to all get the last).
- `FakeGoogleFileStore.upload` applies the real store's media-type admission (`application/x-foo` is `bad_request`), and takes `failUpload`. `FakeGoogleCacheStore` takes `failCreate`, `preflight` and `coalesce`. Scripted errors are classified as the real stores classify them.
- `fakeLlmResult` defaults to an unpriced, `estimated` cost (and one unpriced attempt in `callCost`) instead of an exact `$0`, and numbers `callId` / `attemptId` per process so two results do not collide under `RecordingSink({ dedupeOn: 'attemptId' })`.
- `fakeProviderError('xai', scenario, { headers })` carries response headers. `fakeNetworkError` names the syscall and errno of its code (`ECONNREFUSED` is `connect`).
- `@gullabs/google` exports `classifyGoogleError` and `GEMINI_INPUT_MIME_TYPES`. `GoogleFileStore` takes a `scheduler` for the poll wait, and the Gemini flex/standard client-side timeout ceiling runs on `ctx.scheduler`, so a `FakeClock` passed as the client's `scheduler` fires both. The packed-install check now imports `@gullabs/testing` and makes a fake call.

What hosts must change:

- A test that threw `fakeProviderError(...)` from a `FakeAdapter` and expected the engine's generic classification now sees the provider's classification; update the expected `kind`, `retryable` and `reason`. Install `@gullabs/google` / `@gullabs/xai` next to `@gullabs/testing` to use those scenarios in a whole-adapter fake.
- Code that read the raw error off a `FakeClient` rejection reads it from `error.cause`.
- A `fakeLlmResult()` that relied on a priced `$0` passes `cost`.
- `FakeGoogleFileStore.upload` needs `@gullabs/google` installed (it supplies the admitted media types).
