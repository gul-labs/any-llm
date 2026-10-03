---
'@gullabs/testing': minor
---

`@gullabs/testing` reproduces failures: error factories, recorders, a client fake, Google store fakes, a CLI runner fake, and a `FakeClock` that is also a scheduler.

- `FakeClock` implements `Scheduler`: `setTimeout`, `clearTimeout`, `advance` (fires due timers in order), `advanceAsync` (lets promise continuations run between timers), `pendingTimers`. Pass it as both `clock` and `scheduler` of `createClient`.
- `fakeHttpError`, `fakeNetworkError`, `fakeBilledFailure`, `fakeProviderError('google' | 'xai', scenario)`: the provider scenarios build the real `@google/genai` `ApiError` and `openai` `APIError` from the error bodies pinned in the provider fixtures. `@google/genai` and `openai` are optional peer dependencies.
- `RecordingSink({ dedupeOn: 'attemptId' })` (repeats are kept on `duplicates`), `RecordingTelemetry`, `RecordingLogger`, `fakeLlmResult`, `FakeClient` (request capture, `expectRequest`), `FakeGoogleFileStore`, `FakeGoogleCacheStore`, `FakeCliRunner`. `scriptedRateLimiter` takes a `scheduler`.
- `FakeAdapter` and `SignalAwareFakeAdapter` take their delay from the client's scheduler.

What hosts must change:

- `FakeAdapter` and `SignalAwareFakeAdapter` throw `TypeError` at construction for an entry that is neither an `Error` nor a complete `AdapterResult`. Replace `{ status: 429 }` entries with `fakeHttpError(429)`.
