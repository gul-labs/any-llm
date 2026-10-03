# @gullabs/testing

Reusable test fakes for any-llm. Lets you drive the full engine pipeline — including the Gemini adapter — without any network calls or mocking frameworks.

## Install

```bash
pnpm add -D @gullabs/testing @gullabs/core @gullabs/google
```

`fakeProviderError('google', ...)` needs `@google/genai` and `fakeProviderError('xai', ...)` needs
`openai` (optional peer dependencies, loaded only when such a scenario is built). A fake that stands in
for a whole adapter or client (`FakeAdapter`, `SignalAwareFakeAdapter`, `FakeClient`) also loads the
provider's own classifier, `@gullabs/google` or `@gullabs/xai` (optional peer dependencies at the exact
release version, like core), the first time it throws such an error; `FakeGoogleFileStore.upload` loads
`@gullabs/google` for its media-type list.

## Key exports

| Export                                      | What it is                                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `FakeClock`                                 | Deterministic `Clock` **and** `Scheduler`: `advance(ms)` / `advanceAsync(ms)` fire timers; see below             |
| `FakeIds`                                   | Sequential `IdGenerator`: returns `call_1`, `attempt_1`, etc.                                                    |
| `RecordingSink`                             | In-memory `UsageSink`; `dedupeOn: 'attemptId'` mirrors the Drizzle ledger; `payloads` holds stored payloads      |
| `RecordingTelemetry`                        | `Telemetry` that records start, attempt, success and error events                                                |
| `RecordingLogger`                           | `Logger` that records every line (`messages('error')`, `find(event)`)                                            |
| `fakeLlmResult(partial)`                    | A complete `LlmResult` (`message`, `continuation`, `callCost` and the rest), with overrides; unpriced by default |
| `FakeClient`                                | Scripted `Client` for host code that takes a `Client`: request capture, `expectRequest`, rejects `LlmError` only |
| `fakeHttpError` / `fakeNetworkError`        | Status and transport failures in the shape `classifyError` reads                                                 |
| `fakeBilledFailure(usage)`                  | The `LlmError` an adapter throws for a billed HTTP 200 with no usable output                                     |
| `fakeProviderError('google' \| 'xai', s)`   | A provider error built from the real SDK class and a pinned error body                                           |
| `makeFakeGemini(script)`                    | Creates a fake `@google/genai`-compatible client from a scripted response                                        |
| `fakeGeminiResponse(opts)`                  | Builds a `GeminiResponseLike` with usage metadata, thought parts, and JSON output                                |
| `fakeGeminiBlocked(opts)`                   | Builds a safety-blocked `GeminiResponseLike` (no candidates, `promptFeedback.blockReason` set)                   |
| `FakeAdapter`                               | Scriptable `ProviderAdapter` at the port level; rejects an entry that is not an `Error` or a result              |
| `SignalAwareFakeAdapter`                    | Like `FakeAdapter` but observes and honours `AbortSignal` from `AdapterCtx`                                      |
| `scriptedRateLimiter(opts)`                 | RateLimiter fake with injectable wait for deterministic `queueDelayMs` assertions                                |
| `inMemoryRateLimiter(opts?)`                | Convenience re-export of `@gullabs/core`'s in-process `RateLimiter` implementation                               |
| `makeFakeXai` / `fakeXaiResponse`           | Fake xAI Responses client for `@gullabs/xai` adapter tests                                                       |
| `FakeXaiFileStore`                          | In-memory xAI Files store (upload/TTL/delete/`failClosed`) for host unit tests                                   |
| `FakeGoogleFileStore`                       | In-memory Gemini Files store with the real store's surface and delete semantics                                  |
| `FakeGoogleCacheStore`                      | In-memory Gemini context-cache store: process-scoped reuse, expiry skew, refresh                                 |
| `FakeCliRunner`                             | Scripted runner for `@gullabs/claude-cli` and `@gullabs/codex-cli`: no process is spawned                        |
| `runToolLoop(client, req, tools, { auth })` | Runs a function-calling loop, following `result.continuation` after every turn (see below)                       |

For a quota store in tests use `inMemoryQuotaStore({ clock })` from `@gullabs/quota`; it takes the same
`FakeClock`.

## Deterministic time

`FakeClock` is both a `Clock` and a `Scheduler`. Pass it as `clock` **and** `scheduler` and every wait
the engine owns runs on it: the attempt timeout, the call deadline (`timeoutMs`), the sink waits, the
back-off of `retryMiddleware`, and the delay of `FakeAdapter` / `SignalAwareFakeAdapter`. No real time
passes, so a test of a 30-second timeout takes microseconds and cannot flake.

```ts
import { createClient } from '@gullabs/core'
import { FakeAdapter, FakeClock } from '@gullabs/testing'

const clock = new FakeClock(1_000)
const client = createClient({
  adapters: [new FakeAdapter('google', okResult, { delayMs: 60_000 })],
  modelRegistry,
  clock,
  scheduler: clock,
})

const call = client.generate({ ...request, config: { timeoutMs: 30_000 } }, { auth })
const outcome = call.then(
  () => 'ok',
  (error: unknown) => error,
)

await clock.advanceAsync(30_000) // the call's timeout fires; promise continuations settle
await expect(outcome).resolves.toMatchObject({ kind: 'timeout' })
```

- `advance(ms)` moves the clock and fires every timer that falls due, in due-time order, synchronously.
  Promise continuations a timer wakes run after it returns.
- `advanceAsync(ms)` also lets promise continuations run after each timer (a bounded number of promise
  turns, no real waiting), so a timer that a continuation schedules inside the window fires too. Await
  it. Use it whenever the code under test awaits between timers (retry back-off, a polling loop).
- `set(ms)` jumps to an absolute time; a later time fires the timers it passes.
- `advance`, `advanceAsync` and `set` throw `RangeError` for `NaN`, an infinite amount, or (for `advance`)
  a negative one: time never moves backwards through `advance` (use `set`) and is never `NaN`. An
  `advance` from inside a timer callback is allowed: the clock only moves forward, the outer call fires
  what remains due and the clock ends at the furthest target.
- `now`, `setTimeout`, `clearTimeout` and the rest are arrow-function properties, so `const { now } =
clock` and `providerQuotaMiddleware({ now: clock.now })` work: `Clock` and `Scheduler` methods are
  declared `this: void`.
- `pendingTimers` counts timers set and not yet fired or cleared: assert `0` to prove nothing leaks.
- While a timer's callback runs, `now()` is that timer's due time.

`FakeAdapter` does not honour the abort signal, so its own delay timer stays pending after a timeout;
use `SignalAwareFakeAdapter` when the test needs the adapter to stop.

## Error factories

Hand-built `{ status: 429 }` objects hide the bugs that matter (a missing header, a body the SDK
wraps differently). The factories produce what the SDKs and transports really throw.

**What a factory error becomes depends on what throws it**, because the real thing differs the same
way. `fakeProviderError` returns the raw SDK error: from `makeFakeGemini` / `makeFakeXai` (or a fake
store's SDK client) it reaches the real adapter or store you are testing, which classifies it. From a
`FakeAdapter`, a `SignalAwareFakeAdapter` or a `FakeClient` entry the fake replaces the adapter, so it
runs the real classifier itself (`classifyGoogleError` / `classifyXaiError`, the same function the real
adapter calls) before throwing, and the error is an `LlmError`: `per-day-quota` is `rate_limited`,
`retryable: false`, `reason: 'daily_quota'` (a retry loop stops); `credits-exhausted-429` is
`credits_exhausted`; a bad Gemini key is `invalid_auth`, not the HTTP 400 core alone would call
`bad_request`. Tests compare a `FakeAdapter` run with the real adapter run on the same scenario. A
`fakeHttpError` or `fakeNetworkError` carries no provider mark, so it reaches the engine as thrown and
core classifies it, as it does for any adapter.

```ts
import {
  fakeBilledFailure,
  fakeHttpError,
  fakeNetworkError,
  fakeProviderError,
} from '@gullabs/testing'

new FakeAdapter('google', [
  fakeHttpError(429, { retryAfter: 2 }), // status + a real Headers object with Retry-After
  fakeNetworkError(), // TypeError('fetch failed') with the errno on the cause, as Node fetch throws
  fakeBilledFailure({ inputTokens: 1_200, outputTokens: 0 }), // billed 200 with no usable output
  fakeProviderError('google', 'per-day-quota'), // real @google/genai ApiError + the pinned body
  okResult,
])
```

- `fakeHttpError(status, { retryAfter?, headers?, body?, message? })` is an `Error` with `status` and a
  real `Headers`: the shape `classifyError` reads. `retryAfter` is seconds or an HTTP-date.
- `fakeNetworkError({ code? })` is `TypeError: fetch failed` whose `cause` carries the errno and the
  syscall Node reports for that code (`ECONNRESET` by default, `read`; `ECONNREFUSED` is `connect`; the
  `UND_ERR_*_TIMEOUT` codes carry neither and classify as `timeout`).
- `fakeBilledFailure(usage, { kind?, retryable?, warnings?, provider? })` is the `LlmError` an adapter
  throws when the provider answered HTTP 200 and billed the call but returned nothing usable. The
  engine keeps that attempt's `usage` and cost on its ledger row.
- `fakeProviderError('google', scenario)` builds the real `ApiError` from `@google/genai` (status plus
  the JSON body as the message). `fakeProviderError('xai', scenario, { headers? })` builds the real
  `openai` SDK status error with `APIError.generate(status, body, undefined, headers)`; `headers`
  (`retry-after`, `x-request-id`, rate-limit headers) are what the xAI classifier reads. Scenarios (the body of each
  is copied from the provider package's pinned fixture, and a test fails if a copy drifts):
  - Google, captured live (probe P6, 2026-10-03): `invalid-api-key`, `empty-api-key`,
    `stale-cached-content`, `malformed-cache-name`. Doc-derived, **not** captures: `expired-api-key`,
    `per-minute-quota`, `per-day-quota`, `capacity-503`, `retry-info-only`, `bare-429` (no Gemini 429
    body was ever captured).
  - xAI, captured live: `nonexistent-model`, `malformed-body`, `invalid-api-key`. Reported shape:
    `safety-check`. Doc-derived, **not** captures: `credits-exhausted-429`, `credits-exhausted-403`.

`@google/genai` and `openai` are optional peer dependencies, needed only for the provider scenarios of
that SDK; `@gullabs/google` and `@gullabs/xai` only for the provider classification above. The class comes from the SDK's CommonJS build: a host that imports the SDK as ESM holds a
different copy, so `instanceof ApiError` against it is false (the dual-package hazard). The shape, which
is what the classifiers read, is identical.

## FakeAdapter validates its script

A `FakeAdapter` or `SignalAwareFakeAdapter` entry must be an `Error` or an `AdapterResult` (a non-empty
`model`, a `usage` object and an assistant `message`). Anything else, a plain `{ status: 429 }` or a
result missing `usage`, throws a `TypeError` naming the entry when the adapter is built. Concurrent
calls on one adapter (a `delayMs` makes them overlap) each take their own entry, in arrival order. A mistyped
result is never silently turned into a thrown value, and the message is never rebuilt from `text`.

## RecordingSink: dedupe like the ledger

```ts
import { RecordingSink } from '@gullabs/testing'

const sink = new RecordingSink({ dedupeOn: 'attemptId' })
// ... run a call that retries ...
expect(sink.records.map((r) => r.attemptNumber)).toEqual([1, 2]) // one row per attempt
expect(sink.duplicates).toEqual([]) // nothing re-delivered under the same attemptId
```

`drizzleUsageSink` writes with `onConflictDoNothing` on `attemptId`; `dedupeOn: 'attemptId'` gives the
recording sink the same idempotence, drops the repeat and keeps it on `duplicates`, so a test can tell
a retry that reuses an id from one that mints a fresh one. `failOnRecord` still simulates a broken sink.

With `payloads: {}` on the client (ADR-038), `sink.payloads` is a `Map` from `attemptId` to the redacted, capped
payload the engine handed the sink; an attempt that got none (storage off, `include` said no, `storePayload: false`)
has no entry.

## RecordingTelemetry and RecordingLogger

```ts
import { RecordingLogger, RecordingTelemetry } from '@gullabs/testing'

const telemetry = new RecordingTelemetry()
const logger = new RecordingLogger()
const client = createClient({ adapters, modelRegistry, telemetry, logger })

await client.generate(request, { auth })

telemetry.starts // CallStartEvent[]
telemetry.attempts // AttemptEvent[], one per provider attempt
telemetry.successes[0]?.callCost // CallSuccessEvent
telemetry.errors // CallErrorEvent[]
telemetry.events // every event in order, with the span handle it received

logger.messages('error') // ['llm.call.sink.timeout', ...]
logger.find('llm.call.retry')?.fields // { callId, attemptNumber, delayMs, ... }
```

`RecordingTelemetry.onStart` returns a fresh span handle (`{ span: 1 }`, `{ span: 2 }`, ...) and the
later events record the handle they got, so a test can check that one call's events share a span.

## fakeLlmResult and FakeClient

`fakeLlmResult(partial)` builds a complete `LlmResult` (every required field, including `message`,
`continuation` and `callCost`), with `partial` overriding the defaults. `text` and `message` stay
consistent: give one and the other is derived. The default `cost` is **unpriced** (`microUsd: null`,
`confidence: 'estimated'`) and the `callCost` counts one unpriced attempt: a fake that was not told the
price does not claim `$0`, so host branches on an unpriced or non-exact cost run by default; pass `cost`
(and the `callCost` follows) for a priced result. `callId` and `attemptId` are numbered per process, so
two results never collide under `RecordingSink({ dedupeOn: 'attemptId' })`; pass them for exact values.

`FakeClient` is a scripted `Client` for host code that takes a `Client` and needs no engine. It
records every call and answers from a script of results and errors (in order, the last repeating).
Each entry is validated when the client is built: it must be an `Error` or a complete `LlmResult`.
Like a real `Client` it rejects **only with `LlmError`**: an `Error` entry is classified as the engine
classifies it (`classifyError`, the original kept as `cause`), an error from `fakeProviderError` goes
through the real provider classifier first, and an `LlmError` entry is thrown unchanged. So
`catch (e) { if (e instanceof LlmError && e.kind === 'rate_limited') ... }` in host code is exercised.

```ts
import { FakeClient, fakeHttpError, fakeLlmResult } from '@gullabs/testing'

const client = new FakeClient(
  [
    fakeLlmResult({ text: 'draft' }),
    fakeHttpError(503),
    fakeLlmResult({ text: 'final' }),
  ],
  { countTokens: { totalTokens: 1_200, accuracy: 'exact', raw: {} } },
)

await summarise(client, 'long text') // host code under test

client.calls // [{ method: 'generate', request, opts }, ...] exactly as the host sent them
client.expectRequest({
  provider: 'google',
  config: { temperature: 0 },
  messages: [{ role: 'user', parts: [{ kind: 'text', text: 'long text' }] }],
}) // subset match against the last call; { call: 0 } picks another
```

`expectRequest` matches objects by subset and arrays element by element and of equal length, and
throws an `Error` showing the expected subset and the received request when they differ. To exercise
the engine itself (retry, timeouts, ledger rows) use `createClient` with a `FakeAdapter` instead.

## Fake Google stores

`FakeGoogleFileStore` and `FakeGoogleCacheStore` stand in for `GoogleFileStore` and `GoogleCacheStore`
with the same surface and the same fail-open and idempotent-delete behaviour, structurally (no import
of `@gullabs/google`). Both take a `now` so expiry follows a `FakeClock`.

```ts
import { FakeClock, FakeGoogleCacheStore, FakeGoogleFileStore } from '@gullabs/testing'

const clock = new FakeClock(0)
const files = new FakeGoogleFileStore({ now: () => clock.now() }) // a file lives 48 h, as Google's
const handle = await files.upload(new Uint8Array([1, 2, 3]), 'image/png')
files.size // 1
await files.delete(handle) // a missing file is success; `failClosed` / `deleteMissingAsError` for failures

const caches = new FakeGoogleCacheStore({ now: () => clock.now(), tokenCount: 4_096 })
const key = { model: 'gemini-2.5-pro', stableKey: 'system-prompt-v3' }
const a = await caches.getOrCreate(key, async () => ({ ttlSeconds: 600 }))
const b = await caches.getOrCreate(key, async () => ({ ttlSeconds: 600 }))
// b === a, caches.created === 1; after the expiry skew (30 s before expiry) a new cache is created
```

`FakeGoogleFileStore.upload` applies the real store's media-type admission (core's
`assertMediaTypeAdmitted` over the list `@gullabs/google` exports as `GEMINI_INPUT_MIME_TYPES`): an
empty type or `application/x-foo` is `bad_request`, as with the real store. `failUpload` (an error or a
list, one per upload in order) scripts upload failures. `FakeGoogleCacheStore` takes `failCreate`
(same shape), `preflight: { minTokens, countTokens }` (the real store's opt-in token gate; Gemini 3.x
caches need at least 2048 tokens) and `coalesce`. A scripted error is classified as the real store
classifies an SDK failure, so `fakeProviderError('google', 'per-day-quota')` arrives as
`rate_limited` / `daily_quota`. The stores are always ACTIVE: no processing delay is simulated.

## FakeCliRunner

`FakeCliRunner` satisfies the `run(args, input, opts)` seam of both `ClaudeCliRunner` and
`CodexCliRunner`, so the CLI adapters run without a process.

```ts
import { claudeCliAdapter } from '@gullabs/claude-cli'
import { FakeCliRunner } from '@gullabs/testing'

const runner = new FakeCliRunner([
  { stdout: JSON.stringify(envelope) }, // stderr '' and exitCode 0 by default
  { stdout: '', stderr: 'rate limited', exitCode: 1 }, // a non-zero exit resolves, as with the real runner
  Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }), // a spawn failure rejects
  (call) => ({ stdout: render(call.input), stderr: '', exitCode: 0 }), // or compute it
])
const adapter = claudeCliAdapter({ runner })
// ... run calls ...
runner.calls[0]?.args // argv exactly as the adapter built it
```

Entries are consumed in order, the last repeating. A run whose `signal` is already aborted rejects with
an `AbortError`, as the real runners do.

## Tool loops

`runToolLoop(client, req, tools, { auth })` drives a function-calling conversation to its final
answer so a host test exercises the contract the provider really has. After each turn it reads
`result.continuation`: for `'history'` it appends `result.message` and the tool results and resends
the full history; for `'state'` it sends only the new tool results plus
`result.transientProviderState`. `req.tools` declares the tools, `tools` implements them by name.

```ts
import { runToolLoop } from '@gullabs/testing'

const { result, turns } = await runToolLoop(
  client,
  {
    provider: 'google',
    model: 'gemini-3.6-flash',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Weather in Paris?' }] }],
    tools: [
      {
        name: 'get_weather',
        description: 'Current weather for a city',
        inputJsonSchema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
  },
  { get_weather: () => ({ tempC: 18 }) },
  { auth: { apiKey: 'test' }, maxTurns: 4 },
)
// result.text is the final answer; turns holds every LlmResult, in order.
```

It is a test helper, not an agent runtime. A tool that throws does not abort the loop: its error
message goes back to the model as a tool result with `isError: true`, so a test can drive the model's
recovery turn. It throws `bad_request` if the model calls a tool you did not implement, and throws if
the model keeps calling tools past `maxTurns` (default 8).

## Quick example — end-to-end with fake Gemini client

```ts
import { createClient, composeProviders, defineCallSite } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'
import {
  FakeClock,
  FakeIds,
  RecordingSink,
  fakeGeminiResponse,
  makeFakeGemini,
} from '@gullabs/testing'

const fakeClient = makeFakeGemini(
  fakeGeminiResponse({
    structuredJson: '{"ok":true}',
    thoughtText: 'Thinking...',
    promptTokenCount: 100,
    candidatesTokenCount: 10,
    thoughtsTokenCount: 20,
    finishReason: 'STOP',
  }),
)

const sink = new RecordingSink()
const client = createClient({
  ...composeProviders([googleProvider({ client: fakeClient })]),
  sink,
  clock: new FakeClock(0),
  ids: new FakeIds(),
})

const callSite = defineCallSite({
  id: 'test',
  provider: 'google',
  model: 'gemini-2.5-flash',
  jsonSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  },
  userTemplate: 'Hello',
  config: { reasoning: { includeThoughts: true } },
})

// Auth is required per call.
const result = await client.runStructured(callSite, {}, { auth: { apiKey: 'fake' } })

// Assertions
console.assert(result.output?.ok === true)
console.assert(result.outputParsed === true)
console.assert(result.usage.thinkingTokens === 20)
console.assert(sink.last()?.status === 'ok')
```

## Wiring fakes through a host-owned factory

Real hosts don't call `createClient()` at call sites — they own a factory module that
assembles the client once (providers, sink, quota middleware) and hand out the built
`client` to call sites. The fakes above are designed to flow through that same factory
unchanged: the factory takes its ports (adapter/client, sink, clock, ids) as injectable
parameters with production defaults, so tests pass fakes and production passes nothing.

**1. The host's factory module** — e.g. `src/llm/make-llm-client.ts`:

```ts
import { createClient, composeProviders } from '@gullabs/core'
import type { Clock, IdGenerator, Scheduler, UsageSink } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'
import type { GeminiAdapterOptions } from '@gullabs/google'
import { drizzleUsageSink } from '@gullabs/drizzle'
import { db, llmCalls } from '../db/schema.js'

export interface MakeLlmClientOverrides {
  /** Production default: a real `@google/genai` client. Tests: `makeFakeGemini(...)`. */
  client?: GeminiAdapterOptions['client']
  sink?: UsageSink
  clock?: Clock
  /** Tests pass the same `FakeClock` as `clock`, so timeouts and back-off are deterministic. */
  scheduler?: Scheduler
  ids?: IdGenerator
}

export function makeLlmClient(overrides: MakeLlmClientOverrides = {}) {
  return createClient({
    ...composeProviders([
      googleProvider({
        ...(overrides.client !== undefined && { client: overrides.client }),
      }),
    ]),
    sink: overrides.sink ?? drizzleUsageSink({ db }),
    ...(overrides.clock !== undefined && { clock: overrides.clock }),
    ...(overrides.scheduler !== undefined && { scheduler: overrides.scheduler }),
    ...(overrides.ids !== undefined && { ids: overrides.ids }),
  })
}
```

Production call sites import `makeLlmClient()` with no arguments and get the real Gemini
client + real sink. `overrides.client` is typed as `GeminiAdapterOptions['client']` —
the exact type `googleProvider({ client })` already accepts — so the factory never
redeclares the Gemini client shape itself. The conditional spreads matter under
`exactOptionalPropertyTypes` (which this repo enables): `client`, `clock`, `scheduler`, and `ids` are
optional properties, not `| undefined` unions, so explicitly passing
`client: undefined` on the production path would be a type error — omit each key
entirely when no override is given.

**2. A vitest test calling the same factory:**

```ts
import { describe, it, expect } from 'vitest'
import { defineCallSite } from '@gullabs/core'
import {
  FakeClock,
  FakeIds,
  RecordingSink,
  fakeGeminiResponse,
  makeFakeGemini,
} from '@gullabs/testing'
import { makeLlmClient } from '../src/llm/make-llm-client.js'

const checkOk = defineCallSite({
  id: 'check-ok',
  provider: 'google',
  model: 'gemini-2.5-flash',
  jsonSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  },
  userTemplate: 'Hello',
})

describe('makeLlmClient', () => {
  it('runs a structured call through the host factory with fakes', async () => {
    const sink = new RecordingSink()
    const clock = new FakeClock(0)
    const client = makeLlmClient({
      client: makeFakeGemini(
        fakeGeminiResponse({ structuredJson: '{"ok":true}', candidatesTokenCount: 10 }),
      ),
      sink,
      clock,
      scheduler: clock,
      ids: new FakeIds(),
    })

    const result = await client.runStructured(checkOk, {}, { auth: { apiKey: 'fake' } })

    expect(result.output).toEqual({ ok: true })
    expect(result.usage.outputTokens).toBe(10)
    expect(sink.last()?.status).toBe('ok')
  })
})
```

Zero `vi.mock()` calls, zero production-code changes — the test drives the exact same
`makeLlmClient` factory production code calls, just with fakes threaded through its
existing override parameters.

### Port-level tests — bypassing the Gemini SDK shape entirely

For tests that don't care about `@google/genai`'s response shape at all (e.g. testing
retry/rate-limit/cost-ledger behavior in isolation), inject `FakeAdapter` (or
`SignalAwareFakeAdapter` for abort-signal assertions) directly as the adapter instead of
going through `googleProvider({ client })`. Reuse `googleProvider()`'s own
`modelRegistry`/`pricingSources` from `composeProviders` — only the `adapters` entry
needs to change:

```ts
import { createClient, composeProviders } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'
import { FakeAdapter, RecordingSink } from '@gullabs/testing'

const { modelRegistry, pricingSources } = composeProviders([googleProvider()])
const fakeAdapter = new FakeAdapter('google', {
  message: { role: 'assistant', parts: [{ kind: 'text', text: 'hi' }] },
  text: 'hi',
  model: 'gemini-2.5-flash',
  usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
  warnings: [],
})

const client = createClient({
  adapters: [fakeAdapter],
  modelRegistry,
  pricingSources,
  sink: new RecordingSink(),
})
```

Wire this shape into the host factory the same way — add an `adapters` override
alongside `client`/`sink`/`clock`/`ids` when a host needs port-level tests in addition to
SDK-shape-level ones.

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`@gullabs/core` README](../core/README.md) — the ports (`Clock`, `Scheduler`, `IdGenerator`, `UsageSink`, `RateLimiter`) these fakes implement
- [`@gullabs/quota` README](../quota/README.md) — `inMemoryQuotaStore({ clock })` for quota tests
- [`@gullabs/google` README](../google/README.md) — the real Gemini adapter these fakes stand in for
