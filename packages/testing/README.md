# @gullabs/testing

Reusable test fakes for any-llm. Lets you drive the full engine pipeline — including the Gemini adapter — without any network calls or mocking frameworks.

## Install

```bash
pnpm add -D @gullabs/testing @gullabs/core @gullabs/google
```

## Key exports

| Export                                      | What it is                                                                                     |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `FakeClock`                                 | Deterministic `Clock` — `advance(ms)` / `set(ms)` for latency assertions                       |
| `FakeIds`                                   | Sequential `IdGenerator` — returns `call_1`, `attempt_1`, etc.                                 |
| `RecordingSink`                             | In-memory `UsageSink` — accumulates records; inspect via `sink.records` / `sink.last()`        |
| `makeFakeGemini(script)`                    | Creates a fake `@google/genai`-compatible client from a scripted response                      |
| `fakeGeminiResponse(opts)`                  | Builds a `GeminiResponseLike` with usage metadata, thought parts, and JSON output              |
| `fakeGeminiBlocked(opts)`                   | Builds a safety-blocked `GeminiResponseLike` (no candidates, `promptFeedback.blockReason` set) |
| `FakeAdapter`                               | Scriptable `ProviderAdapter` — use at the port level (bypasses Gemini SDK entirely)            |
| `SignalAwareFakeAdapter`                    | Like `FakeAdapter` but observes and honours `AbortSignal` from `AdapterCtx`                    |
| `scriptedRateLimiter(opts)`                 | RateLimiter fake with injectable wait for deterministic `queueDelayMs` assertions              |
| `inMemoryRateLimiter(opts?)`                | Convenience re-export of `@gullabs/core`'s in-process `RateLimiter` implementation             |
| `makeFakeXai` / `fakeXaiResponse`           | Fake xAI Responses client for `@gullabs/xai` adapter tests                                     |
| `FakeXaiFileStore`                          | In-memory xAI Files store (upload/TTL/delete/`failClosed`) for host unit tests                 |
| `runToolLoop(client, req, tools, { auth })` | Runs a function-calling loop, following `result.continuation` after every turn (see below)     |

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

It is a test helper, not an agent runtime: it throws if the model calls a tool you did not
implement, or keeps calling tools past `maxTurns` (default 8).

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
import type { Clock, IdGenerator, UsageSink } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'
import type { GeminiAdapterOptions } from '@gullabs/google'
import { drizzleUsageSink } from '@gullabs/drizzle'
import { db, llmCalls } from '../db/schema.js'

export interface MakeLlmClientOverrides {
  /** Production default: a real `@google/genai` client. Tests: `makeFakeGemini(...)`. */
  client?: GeminiAdapterOptions['client']
  sink?: UsageSink
  clock?: Clock
  ids?: IdGenerator
}

export function makeLlmClient(overrides: MakeLlmClientOverrides = {}) {
  return createClient({
    ...composeProviders([
      googleProvider({
        ...(overrides.client !== undefined && { client: overrides.client }),
      }),
    ]),
    sink: overrides.sink ?? drizzleUsageSink(db, llmCalls),
    ...(overrides.clock !== undefined && { clock: overrides.clock }),
    ...(overrides.ids !== undefined && { ids: overrides.ids }),
  })
}
```

Production call sites import `makeLlmClient()` with no arguments and get the real Gemini
client + real sink. `overrides.client` is typed as `GeminiAdapterOptions['client']` —
the exact type `googleProvider({ client })` already accepts — so the factory never
redeclares the Gemini client shape itself. The conditional spreads matter under
`exactOptionalPropertyTypes` (which this repo enables): `client`, `clock`, and `ids` are
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
    const client = makeLlmClient({
      client: makeFakeGemini(
        fakeGeminiResponse({ structuredJson: '{"ok":true}', candidatesTokenCount: 10 }),
      ),
      sink,
      clock: new FakeClock(0),
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
- [`@gullabs/core` README](../core/README.md) — the ports (`Clock`, `IdGenerator`, `UsageSink`, `RateLimiter`) these fakes implement
- [`@gullabs/google` README](../google/README.md) — the real Gemini adapter these fakes stand in for
