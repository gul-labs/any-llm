# @gullabs/quota

Provider quota primitives for `any-llm`. This package keeps quota policy, durable deferral, and
distributed state out of `@gullabs/core` while still speaking the core `Middleware` and
`RateLimiter` seams directly.

## Install

```bash
pnpm add @gullabs/quota @gullabs/core @gullabs/google
```

## Key exports

| Export                           | What it is                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `quotaPolicy(opts)`              | Builds a provider quota policy from per-model `rpm` / `rpd` / `tpm` limits                  |
| `quotaPolicyForGemini(opts)`     | Gemini preset over `quotaPolicy`: provider `google`, the day rolls over at Pacific time     |
| `quotaPolicyForXai(opts)`        | xAI preset over `quotaPolicy`: provider `xai`, host-supplied `rpm` / `tpm`, no day cap      |
| `checkProviderQuota(opts)`       | Returns a typed `QuotaDecision` (`allow` / `defer` / `deny`)                                |
| `enforceProviderQuota(opts)`     | Turns a `QuotaDecision` into quota events and typed `LlmError`s; returns a `QuotaAdmission` |
| `providerQuotaMiddleware(opts)`  | Core `Middleware` (`role: 'quota'`) that blocks before `next()`; the `store` is optional    |
| `providerQuotaRateLimiter(opts)` | Core `RateLimiter` wrapper for non-middleware hosts                                         |
| `inMemoryQuotaStore(opts?)`      | Single-process `QuotaStore`; takes a `clock` so tests drive the windows                     |
| `upstashQuotaStore(opts)`        | Distributed `QuotaStore` backed by the Upstash REST pipeline, each call time-bounded        |

## Quick example

```ts
import { createClient, composeProviders, retryMiddleware } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'
import {
  providerQuotaMiddleware,
  quotaPolicyForGemini,
  upstashQuotaStore,
} from '@gullabs/quota'

const quotaStore = upstashQuotaStore({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  // timeoutMs: 2_000 is the default: one slow store call cannot hold a call past its own timeout.
})

const policy = quotaPolicyForGemini({
  models: {
    'gemini-2.5-pro': { rpm: 60, rpd: 2_000, tpm: 1_000_000 },
    'gemini-2.5-flash': { rpm: 120, rpd: 10_000, tpm: 2_000_000 },
  },
})

const client = createClient({
  ...composeProviders([googleProvider()]),
  middleware: [
    // With retry, quota goes inside it: one quota unit per provider dispatch.
    retryMiddleware({ maxAttempts: 3 }),
    providerQuotaMiddleware({
      store: quotaStore,
      policy,
      // There is no default: choose what a failing store means for your traffic.
      onStoreError: 'fail-closed',
    }),
  ],
})
```

Hosts that prefer the lower-level core `rateLimiter` hook can wrap the same policy/store pair with
`providerQuotaRateLimiter(opts)` instead.

## Presets and the numbers they carry

`quotaPolicy({ provider, models, defaults, dayBoundary?, scope? })` is the general builder; `models`
are keyed by canonical model id and `defaults` limit a model the table does not list. Each limit is
optional: `rpm` (requests per minute), `rpd` (requests per day) and `tpm` (input tokens per minute),
non-negative integers; `0` disables the provider for the scope (see below). An option or limit key the
builders do not know (`defaultLimits`, a misspelt `rpmm`, an `rpd` on the xAI preset) is `bad_request`,
never dropped, and so is a limit that is not a non-negative integer (a fractional one, `NaN` from
`Number(process.env.X)`, a string): the builders throw when the policy is built, so a typo is a startup
error, not the first request's.

- **`quotaPolicyForGemini`** is `quotaPolicy` with provider `google` and
  `dayBoundary: { timeZone: 'America/Los_Angeles' }`. Source: Google's rate-limits page,
  https://ai.google.dev/gemini-api/docs/rate-limits, re-read on 2026-10-03, which states that
  requests-per-day (RPD) quotas reset at midnight Pacific time, that limits apply per project (not per
  API key), and that the dimensions are RPM, TPM (input tokens) and RPD. The page gives no per-model
  numbers (they depend on the project's tier and are shown in AI Studio), so the limits are yours.
- **`quotaPolicyForXai`** is `quotaPolicy` with provider `xai`, and carries **no numbers**: xAI's
  rate-limits page, https://docs.x.ai/developers/rate-limits, re-read on 2026-10-03, publishes limits
  per tier and model, but a team's tier follows its cumulative spend since 2026-01-01 and moves
  automatically, so any number baked in would be wrong for most teams. Read your team's limits on the
  Models page of the xAI Console and pass them in. xAI states limits as requests per second and tokens
  per minute (per-second is the per-minute request budget divided by 60), and documents no daily
  limit, so the preset has `rpm` and `tpm` and no `rpd` or day boundary. A per-minute bucket is looser
  than a per-second limit within the minute.

```ts
import { quotaPolicyForXai } from '@gullabs/quota'

const policy = quotaPolicyForXai({
  models: { 'grok-4.5': { rpm: 600, tpm: 2_000_000 } }, // your team's numbers, from the console
})
```

## The day window and its time zone

`ProviderQuotaRule.dayBoundary: { timeZone }` (an IANA name, resolved with `Intl.DateTimeFormat`, no
dependency) says where the per-day window rolls over; without it the day is the UTC day. Both stores
name the day counter by the local calendar date and the zone's canonical name (`US/Pacific` and
`America/Los_Angeles` share one counter; UTC, however spelled, is the same window as no boundary at all;
a different zone never shares a counter with another) and set its TTL to the time until the next local midnight, so the counter
dies with its window. The boundary is found by searching for the first instant whose local date is
later, never by adding 24 hours, so it is correct on the 23-hour and 25-hour days of a DST change
(2026-03-08 and 2026-11-01 in Pacific time) and in a zone whose DST change skips midnight. An unknown
zone is `bad_request`.

The Lua `EVAL` store takes the TTL in milliseconds as an argument (computed per call), so the same
single `EVAL` serves the minute, token and day windows.

## Tokens per minute

A rule with `tpm` paces on input tokens. Each attempt reserves an estimate and the real usage corrects
it afterwards:

- The engine passes `hint.estimatedInputTokens` to `RateLimiter.acquire(key, signal, hint)` for
  every attempt, and the middleware computes the same figure itself. It is
  `estimateInputTokens(req)` from `@gullabs/core`: the characters of the system instruction, text
  parts, tool calls, tool results, tool declarations and the structured-output schema, divided by 4.
  **It is an estimate, not a count**: inline media, file URIs and file references are not counted, so a
  request that carries them is under-estimated, and a script with few characters per token (CJK) is
  under-estimated too. It is for pacing, never for billing or refusing.
- A call is deferred (`rate_limited`, `reason` `tpm_exhausted` on the `defer` event, `retryAfterMs`
  to the next minute) when its estimate would push the minute past `tpm`. A call larger than the whole
  window is let through when the window is empty (the provider decides on it) rather than deferred for
  ever.
- After the attempt, `Release(usage)` (rate limiter) or the middleware adds `usage.inputTokens` minus
  the reservation to that minute's counter (negative when the estimate was too high; the counter never
  goes below 0). A billed failure that carries `usage` reconciles too; an attempt that ended with no
  usage (a timeout, an abort, a transport failure) keeps its reservation, because the provider may
  have counted the request. A window that has already ended is left alone. Reconciliation never fails
  or delays a call: the middleware and the rate limiter start it when the attempt ends and do not wait
  for it, so a slow store holds nothing. It is **at-most-once**: a process that ends first loses the
  correction and the reservation stays (the counter over-counts until the minute ends, the safe side),
  and a second `Release` call does nothing. A store error becomes a `backend_error` event and an
  `llm.quota.reconcile_failed` warning (the middleware); the store bounds its own call
  (`upstashQuotaStore`: `timeoutMs`).
- `QuotaStore` gains `adjustTokens({ scope, nowMs, tokens })` for this; a custom store implements it
  (a no-op for a store that enforces no `tpm`).

## When the store fails: choose

`providerQuotaMiddleware`, `providerQuotaRateLimiter` and `enforceProviderQuota` take
`onStoreError: 'fail-closed' | 'fail-open'` when they have a store, and there is no default (a missing
or unknown value is `bad_request`, thrown when the middleware or limiter is built). `'fail-closed'`
fails the call with one error whatever went wrong with the store (a timeout, an HTTP failure, a
transport failure, a malformed reply (for the Upstash store: a status that is not exactly `0` or `1`, a counter that is not a non-negative integer, or counters that contradict the status), even a store that throws a `rate_limited` of its own):
`LlmError { kind: 'server', retryable: false, reason: 'quota_store_unavailable' }`, the store's error as
`cause`. It is not a provider timeout and is not retried (a retry would repeat the failure against a
struggling store), so there is one store call per dispatch and the ledger row is a refusal row that
says `server` / `quota_store_unavailable` for a call that never reached the provider. No call can
exceed a quota the store could not confirm. `'fail-open'` lets the call through unchecked, so a store
outage does not stop traffic. Both emit a `backend_error` event. A caller abort or deadline that
interrupts the store call is never fail-open and is the abort or timeout, not a store failure: that
call is over.

`upstashQuotaStore({ url, token, timeoutMs? })` bounds each REST call (default 2 000 ms) and passes
the caller's signal to it, so a slow store cannot hold a call past its own `config.timeoutMs` (the
engine starts the attempt timer only after middleware returns). A call still pending at the limit is
aborted and fails with `Upstash quota call timed out after <n>ms`, which `onStoreError` then handles
(the `cause` of a `quota_store_unavailable` under `'fail-closed'`).

## Without a store

`providerQuotaMiddleware` works with no `store` (and no `onStoreError`): the rules still evaluate, so
a limit of `0` denies with `provider_disabled` and a `deny` event, but the `rpm`, `rpd` and `tpm`
windows cannot be checked and are skipped, with one `warn` log per middleware instance and scope. Its
message is the event name `llm.quota.windows_skipped`; `callId`, `provider`, `model` and `scope` are
fields. Use it to keep a kill switch in a deployment that has no shared store yet.

## In-memory store

`inMemoryQuotaStore({ clock })` is the same windows and the same check-and-consume rule in a `Map`,
for single-process hosts and tests. The `clock` is the store's own time source for counter expiry (as a
Redis server's clock is): pass the client's `FakeClock` and one `advance` rolls the windows over. It
does not share state between processes.

```ts
import {
  inMemoryQuotaStore,
  providerQuotaMiddleware,
  quotaPolicyForXai,
} from '@gullabs/quota'
import { FakeClock } from '@gullabs/testing'

const policy = quotaPolicyForXai({ models: { 'grok-4.5': { rpm: 600, tpm: 2_000_000 } } })
const clock = new FakeClock(Date.UTC(2026, 9, 3, 12))
const store = inMemoryQuotaStore({ clock })
const middleware = providerQuotaMiddleware({
  store,
  policy,
  onStoreError: 'fail-closed',
  now: () => clock.now(),
})
```

## Fail-open default in core

`createClient()` defaults to `NOOP_RATE_LIMITER` when no `rateLimiter` is configured. That is a
conscious fail-open decision, not an oversight. For production Gemini traffic, wire at minimum
`inMemoryRateLimiter` from `@gullabs/core` on a single node or `@gullabs/quota` for shared,
distributed enforcement.

This is the same default described in `packages/core/src/ports.ts` on the `RateLimiter` port. The
core doc comment points back here for the quota-specific tradeoffs and limitations.

## Consume on allow, one unit per dispatch

- **Consume on allow.** `upstashQuotaStore` and `inMemoryQuotaStore` check every configured window
  (`rpm`, `rpd`, `tpm`) and add to them (one unit for the request windows, the estimate for `tpm`) in
  one Lua `EVAL` / one synchronous step, and only when **all** are under their limits. A denied call
  consumes nothing, and concurrent callers at the limit admit exactly the remaining capacity. The
  store needs `EVAL` support on a single database (Upstash REST qualifies); both window keys are
  passed as `KEYS`. A custom `QuotaStore` must be atomic in the same way.
- **One unit per dispatch: place quota inside retry.** The intended accounting is one quota unit per
  provider dispatch, so use `middleware: [retryMiddleware(...), providerQuotaMiddleware(...)]`.
  Quota outside retry would consume once for a call that dispatches several times. `createClient`
  rejects a quota middleware placed before a retry middleware with `bad_request`. It identifies them
  by the readonly `Middleware.role` the factories set (`'quota'`, `'retry'`), not by `id`, so custom
  ids do not change the rule.
- **A quota unit is not refunded** when something else fails the call afterwards (a provider
  error, or an offending middleware outside quota). It counts attempts that reached quota, not
  successes: an attempt that is then refused before dispatch (per-attempt config validation, routing,
  the rate limiter) or aborted after the store call was sent still spent its unit.
- **Long deferrals are not slept through.** `providerQuotaMiddleware({ maxDeferMs })` and
  `providerQuotaRateLimiter({ maxDeferMs })` share one rule and one default, 60 000 ms. A deferral
  whose `retryAfterMs` exceeds it, a per-day window for instance, fails with `rate_limited`,
  `retryable: false`, `reason: 'quota_window'` (and keeps `retryAfterMs`), so the retry middleware
  returns at once and the host can reschedule. The cap exists to stop multi-hour windows being slept
  on, not per-minute ones: an `rpm` deferral waits at most 60 s, so it stays retryable at the default.
  `maxDeferMs` must be a finite number >= 0 (`bad_request` otherwise); `0` makes every deferral
  non-retryable. Every deferral that stays retryable consumes one of the retry middleware's
  `maxAttempts`. The retry sleeps the deferral (plus up to 1 s of jitter) when it is at most its
  `maxDelayMs` (default 60 s, the same as this default, `maxAttempts` 3) and leaves a usable window
  before `timeoutMs`; a deferral beyond either ends the retry with the deferral error,
  `retryAfterMs` intact, rather than waking early and being deferred again. Keep the retry
  `maxDelayMs` at or above `maxDeferMs` when you want every per-minute window waited out, and raise
  `maxAttempts` when several callers share a limit.
- **Limits are looked up by the canonical model id.** The middleware resolves a declared alias to
  its model before it asks the policy, so `quotaPolicy({ models })` (and the presets) must be keyed by the
  canonical id. A table keyed by an alias would never match, and the model would silently be
  unlimited, so the policy throws `bad_request` on the first call that sees such a key. (The
  `RateLimiter` path receives only the canonical id and cannot make that check.)
- **Windows use the caller's clock.** Bucket keys and TTLs come from the `now` option, else the engine
  clock (the middleware's `ctx.clock`; the limiter's `RateLimitHint.nowMs`, which the engine sets from
  the same clock), and only a direct `acquire` call with no time falls back to the system clock
  (rounded up to whole milliseconds for `PEXPIRE`). A client built with a `FakeClock` therefore needs
  `now:` on neither; pair it with `inMemoryQuotaStore({ clock })` so counter expiry follows it too. Hosts whose clocks disagree near a minute or day
  boundary can over-admit for the skew; keep clocks synchronised (NTP) when exactness matters.

## Decision model

- `allow`: proceed immediately.
- `defer`: quota is temporarily exhausted; `retryAfterMs` is present and the thrown `LlmError` is
  `retryable: true` (unless it exceeds `maxDeferMs` in the middleware, above).
- `deny`: quota policy permanently disables the model for this scope; today that means
  `reason: 'provider_disabled'` on the decision and the `deny` event. The thrown `LlmError` is
  `rate_limited`, `retryable: false`, with `error.reason === 'quota_window'` (a local quota rule
  keeps the call from being sent), the same reason as a deferral longer than `maxDeferMs`. Its
  message names the scope.

### The `0` convention (deliberate, not incidental)

Setting `rpm: 0`, `rpd: 0` or `tpm: 0` on a model's limits is a documented, intentional way to disable
that model/scope entirely, and the three mean the same: the policy evaluator checks for a `0` before
consulting the `QuotaStore` at all (a store is not even needed) and returns
`{ kind: 'deny', reason: 'provider_disabled' }` immediately, with no store round-trip. Use it to
hard-turn-off a model (e.g. one that's over budget or deprecated) without removing its policy entry or
touching `RateLimiter` wiring: every call gets a non-retryable `LlmError` instead of quietly falling
through to `allow`. This is distinct from omitting a limit (which leaves that window unenforced) or
setting a positive limit that the store exhausts (which yields a retryable `defer`, not a `deny`). A
negative or fractional limit is `bad_request`.

## Known limitations

- The Lua scripts are atomic because Redis runs a script as one step, but the default test suite
  exercises them through a JavaScript port of their logic (the script body is the same string, and a typo
  in it would not be caught there). `consume-on-allow.test.ts` also runs the shipped scripts, and the
  Upstash store end to end, on a real Lua interpreter against a small Redis shim. CI installs `lua5.4` and
  sets `REQUIRE_LUA=1`, which makes a missing interpreter a failure; locally the block is skipped when no
  `lua` binary is on `PATH` (for example `brew install lua`). The shim is not Redis (Redis embeds Lua
  5.1), and nothing exercises the scripts on a real Redis or Upstash in CI, nor behaviour under truly
  concurrent connections.
- `classifyError` in `@gullabs/core` maps every HTTP `429` to `kind: 'rate_limited'` uniformly.
  Nothing in this repo reads error text to split capacity from quota: `@gullabs/google` retries a
  Flex call on the Standard tier only for an HTTP 503, and a Flex 429 is an ordinary rate limit
  (the provider's retry delay is honoured, no Standard dispatch). Google documents no field that
  tells a capacity 429 from a quota 429, so a host that needs the split has to infer it itself.
- `RateLimiter.acquire` is keyed as `"${provider}:${model}"` (the descriptor's canonical model id)
  and runs once per **attempt**, before the adapter, so each retry acquires again.
  `providerQuotaRateLimiter` therefore also counts one unit per dispatch. The built-in Gemini flex-to-standard fallback happens later inside the adapter, so
  there is no tier key seam for a future policy to gate the standard-tier leg separately.

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`@gullabs/core` README](../core/README.md) — `RateLimiter`, `Middleware`, and the `LlmError` contract
- [`@gullabs/google` README](../google/README.md) — the Gemini adapter this package's default policy targets
