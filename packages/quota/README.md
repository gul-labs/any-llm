# @gullabs/quota

Provider quota primitives for `any-llm`. This package keeps quota policy, durable deferral, and
distributed state out of `@gullabs/core` while still speaking the core `Middleware` and
`RateLimiter` seams directly.

## Install

```bash
pnpm add @gullabs/quota @gullabs/core @gullabs/google
```

## Key exports

| Export                           | What it is                                                      |
| -------------------------------- | --------------------------------------------------------------- |
| `quotaPolicyForGemini(opts)`     | Builds a provider quota policy for Gemini/Google model IDs      |
| `checkProviderQuota(opts)`       | Returns a typed `QuotaDecision` (`allow` / `defer` / `deny`)    |
| `enforceProviderQuota(opts)`     | Turns a `QuotaDecision` into quota events and typed `LlmError`s |
| `providerQuotaMiddleware(opts)`  | Core `Middleware` (`role: 'quota'`) that blocks before `next()` |
| `providerQuotaRateLimiter(opts)` | Core `RateLimiter` wrapper for non-middleware hosts             |
| `upstashQuotaStore(opts)`        | Distributed `QuotaStore` backed by the Upstash REST pipeline    |

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
})

const quotaPolicy = quotaPolicyForGemini({
  models: {
    'gemini-2.5-pro': { rpm: 60, rpd: 2_000 },
    'gemini-2.5-flash': { rpm: 120, rpd: 10_000 },
  },
})

const client = createClient({
  ...composeProviders([googleProvider()]),
  middleware: [
    // With retry, quota goes inside it: one quota unit per provider dispatch.
    retryMiddleware({ maxAttempts: 3 }),
    providerQuotaMiddleware({
      store: quotaStore,
      policy: quotaPolicy,
    }),
  ],
})
```

Hosts that prefer the lower-level core `rateLimiter` hook can wrap the same policy/store pair with
`providerQuotaRateLimiter(opts)` instead.

## Fail-open default in core

`createClient()` defaults to `NOOP_RATE_LIMITER` when no `rateLimiter` is configured. That is a
conscious fail-open decision, not an oversight. For production Gemini traffic, wire at minimum
`inMemoryRateLimiter` from `@gullabs/core` on a single node or `@gullabs/quota` for shared,
distributed enforcement.

This is the same default described in `packages/core/src/ports.ts` on the `RateLimiter` port. The
core doc comment points back here for the quota-specific tradeoffs and limitations.

## Consume on allow, one unit per dispatch

- **Consume on allow.** `upstashQuotaStore` checks every configured window (`rpm`, `rpd`) and
  increments them in one Lua `EVAL`, and only when **all** are under their limits. A denied call
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
  error, or an offending middleware outside quota). It counts dispatches attempted, not successes.
- **Long deferrals are not slept through.** `providerQuotaMiddleware({ maxDeferMs })` (default
  30 000 ms): a deferral whose `retryAfterMs` exceeds it, a per-day window for instance, fails with
  `rate_limited`, `retryable: false`, `reason: 'quota_window'` (and keeps `retryAfterMs`), so the
  retry middleware returns at once and the host can reschedule. Shorter deferrals stay retryable.

## Decision model

- `allow`: proceed immediately.
- `defer`: quota is temporarily exhausted; `retryAfterMs` is present and the thrown `LlmError` is
  `retryable: true` (unless it exceeds `maxDeferMs` in the middleware, above).
- `deny`: quota policy permanently disables the model for this scope; today that means
  `reason: 'provider_disabled'` and `retryable: false`.

### The `rpd: 0` convention (deliberate, not incidental)

Setting `rpd: 0` on a model's `GeminiQuotaLimits` is a documented, intentional way to disable that
model/scope entirely: `evaluateQuotaDecision` checks `resolved.rpd === 0` before consulting the
`QuotaStore` at all and returns `{ kind: 'deny', reason: 'provider_disabled' }` immediately, with
no store round-trip. Use it to hard-turn-off a model (e.g. one that's over budget or deprecated)
without removing its `quotaPolicyForGemini` entry or touching `RateLimiter` wiring — every call
gets a non-retryable `LlmError` instead of quietly falling through to `allow`. This is distinct
from omitting `rpd` (which leaves the day-limit unenforced) or setting a positive `rpd` that the
store exhausts (which yields a retryable `defer`, not a `deny`).

## Known limitations

- `classifyError` in `@gullabs/core` maps every HTTP `429` to `kind: 'rate_limited'` uniformly.
  The only capacity-versus-quota split anywhere in this repo is regex text matching in
  `@gullabs/google`'s `flex-fallback.ts` (`CAPACITY_PATTERNS` / `QUOTA_PATTERNS`). That is an
  unversioned prose contract with Google's API. A false positive there spends money on
  standard-tier traffic; a false negative only loses availability.
- `RateLimiter.acquire` is keyed as `"${provider}:${model}"` (the descriptor's canonical model id)
  and runs once per **attempt**, before the adapter, so each retry acquires again.
  `providerQuotaRateLimiter` therefore also counts one unit per dispatch. The built-in Gemini flex-to-standard fallback happens later inside the adapter, so
  there is no tier key seam for a future policy to gate the standard-tier leg separately.

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`@gullabs/core` README](../core/README.md) — `RateLimiter`, `Middleware`, and the `LlmError` contract
- [`@gullabs/google` README](../google/README.md) — the Gemini adapter this package's default policy targets
