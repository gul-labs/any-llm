# @gullabs/quota

## 0.16.0

### Minor Changes

- fb79350: One call deadline shared by the engine and retry, an abort that never dispatches, a bounded sink, a scheduler port, and a retry that honours the provider's delay.

  - **The call deadline.** `timeoutMs` is armed when the call starts, so middleware time counts against it, and `EngineCtx.deadlineAt` (new, on the `clock`'s scale) is the end of that budget. `EngineCtx.signal` is the caller's signal merged with the deadline (it can abort with an `LlmError('timeout')` reason), and an attempt's window is what the deadline has left. An attempt that ends without a result after the timer fired, while the call is still pending, ends the call with the deadline error and aborts `ctx.signal`, so a middleware that hangs cannot hold `generate()`. A result an attempt produced is returned when work after `next()` runs past the deadline: one success row, no `timeout`. `config.timeoutMs`, `sinkTimeoutMs` and `countTokens`' `timeoutMs` must be finite, greater than 0 and at most 2147483647 (a longer timer fired after 1 ms), else `bad_request` before any row.
  - **Validators run under the deadline.** An async `inputContract` validator and the per-attempt config validation end at `timeoutMs` or the caller's abort (a validator that never settles no longer holds `generate()` or `runStructured()`), and a deadline that passed while one ran is re-checked before the middleware chain and before dispatch.
  - **Retry.** `retryMiddleware` measures against `ctx.deadlineAt`, reads `ctx.clock` and no longer takes a `now` option or stamps `attemptTimeoutMs`. It validates its policy at construction (`maxAttempts` a positive integer, `baseDelayMs` and `maxDelayMs` finite from 0 to 2147483647, `shouldRetry` synchronous), and `maxDelayMs` defaults to 60 s, the same as the quota `maxDeferMs`. A provider `retryAfterMs` is honoured or the retry stops: a delay longer than `maxDelayMs`, or one that leaves the next attempt less than 250 ms of the budget, rethrows that attempt's own error with `retryAfterMs` intact (whatever `shouldRetry` says) and logs `llm.call.retry.stopped`; a delay that is `NaN`, zero or negative is not a delay; up to 10 % (at most 1 s) of jitter is added on top of a provider delay. `computeBackoffMs` returns `retryAfterMs` unchanged and `maxDelayMs` caps only the computed back-off. A retry is pinned to the served tier only when the request named a tier, so an untiered call is never retried with an explicit `serviceTier: 'standard'`.
  - **Abort.** A signal that is already aborted fails `generate()` / `runStructured()` with `aborted` before the middleware chain (one refusal row, `onError`), an abort between attempts stops the next dispatch, and `countTokens` rejects without calling the adapter. A middleware or adapter that rejects with the signal's own reason (any custom `Error`) is `aborted` with that reason as `cause`. A `signal` that is not an `AbortSignal` is `bad_request` (`issues[0].path` `signal`) and arms no timer.
  - **Sink and limiter.** `ClientConfig.sinkTimeoutMs` (default 5000) bounds each `sink.record`; on expiry the engine logs `llm.call.sink.timeout` and returns the result or error unchanged. The wait also ends 100 ms after an abort or the deadline (`llm.call.sink.interrupted`); the write is always started. When a timeout or abort wins while `rateLimiter.acquire` is pending, the engine calls the `Release` it resolves with later.
  - **`ClientConfig.scheduler?: { setTimeout, clearTimeout }`** runs every wait the engine owns (attempt timeout, deadline, sink waits, retry back-off through `EngineCtx.scheduler`, adapter waits through the optional `AdapterCtx.scheduler`). The default is the platform's timers; the scheduler must run on the `clock`'s scale. `FakeClock` implements both. `countTokens` passes the scheduler to the adapter.
  - **`countTokens` takes `CountTokensOptions`** (`GenerateOptions` plus an optional `timeoutMs`); caller abort and the timeout end the call even when the adapter ignores its signal.
  - `RateLimiter.acquire(key, signal, hint?)` receives a `RateLimitHint` (`estimatedInputTokens`, an estimate from the new `estimateInputTokens(req)` that does not count media, and `nowMs`, the engine clock's reading) and `Release` takes the attempt's usage, `(usage?: Usage) => void`.

  What hosts must change:

  - Drop `now` from `retryMiddleware` options and give the client a `clock` that advances in real time when you set `timeoutMs`; a frozen clock leaves middleware time uncounted. A call whose `timeoutMs` was above 2147483647 or not positive now fails with `bad_request`.
  - A 429 whose `retryAfterMs` exceeds `maxDelayMs` now reaches the caller after the first attempt instead of being retried early: raise `maxDelayMs` to wait in process, or reschedule from `error.retryAfterMs`. Code that matched the old "Overall timeout budget" message reads `kind` and `retryable`.
  - A hand-built `EngineCtx` (a middleware unit test) adds `scheduler`. A middleware that waits or does I/O honours `ctx.signal`; a custom `RateLimiter.acquire` rejects when its signal fires.

- fb79350: Lockstep versions with `@gullabs/core` as an exact peer, runtime support that is written down and tested, correct `exports`, and `LICENSE` plus `NOTICE` in every tarball.

  - **One version for every package.** The nine `@gullabs/*` packages are one changesets `fixed` group and always release at the same version; a package with no code change still gets the bump. `@gullabs/google`, `@gullabs/xai`, `@gullabs/quota`, `@gullabs/drizzle`, `@gullabs/testing`, `@gullabs/claude-cli`, `@gullabs/codex-cli` and `@gullabs/any-llm` declare `@gullabs/core` as a `peerDependency` pinned to the exact release version instead of a regular dependency, so a second copy of core cannot sit in `node_modules` without a peer-dependency conflict and `instanceof LlmError` always sees one engine. Mixed versions, patch releases included, are a peer-dependency error under pnpm's strict peers and `ERESOLVE` under npm 7+; they are not supported or tested.
  - **No Node built-in in `core`, `google`, `xai`, `quota`, `drizzle` and `any-llm`.** Ids come from `globalThis.crypto.randomUUID()`, hashes from the new dependency-free `sha256Hex(input)` that `@gullabs/core` exports next to `canonicalJson`, and `Buffer` and `process` are gone. The built ESM entries load with every `node:` import blocked and fake-backed calls run with `Buffer` and `process` removed (`pnpm test:runtime`, in CI); ESLint rejects `node:*`, `Buffer` and `process` in their source. Deno 2.4.1 passes by hand; Bun, Cloudflare Workers, Vercel Edge and browsers are not tested. `claude-cli`, `codex-cli` and `testing` stay Node only. `createClient` throws `bad_request` (path `ids`) when `ClientConfig.ids` is not given and the runtime has no `globalThis.crypto.randomUUID`, instead of failing with a `TypeError` on the first call.
  - **`exports` has nested conditions**: `import` gives `index.d.ts` and `index.js`, `require` gives `index.d.cts` and `index.cjs`, and every package also exports `./package.json`. A TypeScript consumer under `node16` / `nodenext` that `require`s a package now gets CommonJS types (it got ESM types), and `require.resolve('@gullabs/core/package.json')` no longer throws. The ESM and CommonJS builds are separate copies: a process that loads one package through both holds two `LlmError` classes, so use one module format.
  - **One Node floor, `>=22.12.0`**, in every `engines`, the README and the SPEC. CI runs the tests on 22.12.0 and 24.
  - **Every tarball ships `LICENSE` and `NOTICE`** (Apache-2.0 4(d)); `@gullabs/drizzle` also ships its `sql/` directory.

  What hosts must change:

  - Install `@gullabs/core` next to any package that is not the facade, at the same version (`pnpm add @gullabs/core @gullabs/xai openai`); npm 7+ and pnpm install a missing peer unless npm's `legacy-peer-deps` is on or pnpm's `auto-install-peers` is off. Upgrade every `@gullabs/*` package together.
  - Remove any use of `VERSION` from `@gullabs/core` or `@gullabs/any-llm` (it read `0.0.0`); read your own `package.json`. `@gullabs/any-llm` still exports `ANY_LLM_VERSION`.
  - On a runtime without `crypto.randomUUID` (a browser page served over plain http, some embedded runtimes), pass `ids`.
  - A host compiled with `moduleResolution: node16` that `require`s a package may see new, correct type errors where it relied on the ESM declarations.

- fb79350: `@gullabs/quota`: consume only on allow, a time-zone day boundary, tokens per minute, presets, an in-memory store, a bounded Upstash call and an explicit store-failure policy (ADR-041).

  **Windows and policies.**

  - **Consume on allow.** `upstashQuotaStore.checkAndConsume` runs one Lua `EVAL` that reads every counter and increments them all only when every window is under its limit, so a denied call changes nothing (it used to increment both windows before deciding). A custom `QuotaStore` checks and consumes atomically too (all windows or none); the Upstash store needs `EVAL`, which Upstash REST supports. A single call larger than a whole window passes into an empty window.
  - **`ProviderQuotaRule.dayBoundary?: { timeZone }`** (`Intl.DateTimeFormat`, no dependency, correct on DST days) rolls the per-day window over at local midnight; the counter's TTL is the time left in that day, in whole milliseconds (a fractional clock no longer leaves a dangling counter). The day counter is keyed by the zone's canonical name (`US/Pacific` and `America/Los_Angeles` share a counter; UTC spelled any way is the same window as no boundary). `ProviderQuotaRule.tpm` limits input tokens per minute.
  - **Builders.** `quotaPolicy({ provider, models, defaults, dayBoundary?, scope? })` (limits are looked up by own property, so a model named `toString` or `constructor` gets `defaults`), `quotaPolicyForGemini` (now defaulting to `America/Los_Angeles`: Google's rate-limits page, read 2026-10-03, says daily quotas reset at midnight Pacific time; limits are per project, so use one scope per project) and `quotaPolicyForXai` (no numbers baked in: xAI limits depend on the team's tier, so the host passes `rpm` and `tpm`; no day window). `models` are keyed by canonical model id: a table keyed by a declared alias of the model being called throws `bad_request` instead of silently not limiting it. An option or limit key the builders do not know (`defaultLimits`, a misspelt `rpmm`, an `rpd` on the xAI preset) is `bad_request`, and so is a limit that is not a non-negative integer, **checked when the policy is built** (a `NaN` from `Number(process.env.X)` is a startup error, not the first request's). `rpm: 0`, `rpd: 0` and `tpm: 0` all mean "provider disabled" (`deny`, `provider_disabled`, no store round trip).
  - **`inMemoryQuotaStore({ clock })`** for tests and single-node hosts; `providerQuotaMiddleware` works without a `store` (a limit of `0` still denies, the windows are skipped with one `llm.quota.windows_skipped` warning per instance and scope).
  - **Tokens.** The engine passes `RateLimitHint.estimatedInputTokens` (from the new `estimateInputTokens(req)`, which counts text, tool calls and results, tool declarations and the output schema, and not media) to `RateLimiter.acquire` and releases with the attempt's usage; `providerQuotaMiddleware` does the same itself. The reservation is corrected with the real usage through the new `QuotaStore.adjustTokens`, started when the attempt ends and never awaited (at-most-once: a process that ends first loses the correction and the reservation stays; a failure is a `backend_error` event and an `llm.quota.reconcile_failed` warning; `Release` and `QuotaAdmission.reconcile` correct once however often they are called). `enforceProviderQuota` resolves to a `QuotaAdmission` instead of `void`.

  **Deferrals and errors.**

  - **`maxDeferMs`** (middleware and `providerQuotaRateLimiter`, default 60,000, a finite number >= 0 else `bad_request` at construction; `Infinity` is rejected, pass a large finite number to disable the cap): a deferral longer than that fails with `rate_limited`, `retryable: false`, `reason: 'quota_window'` instead of being retried, so retry does not sleep through a per-day window. 60 s equals the retry `maxDelayMs` default, so a per-minute deferral stays retryable.
  - **A `deny` is a typed error:** `rate_limited`, `retryable: false`, `reason: 'quota_window'` (the decision and the `deny` event keep `provider_disabled`).
  - **A fail-closed store outage is one error.** Under `onStoreError: 'fail-closed'` every store failure (a timeout, an HTTP failure, a transport failure, a malformed reply, a store that throws its own `rate_limited`) is `LlmError { kind: 'server', retryable: false, reason: 'quota_store_unavailable' }` with the store's error as `cause`; one store call per dispatch and one refusal row. A caller abort or deadline that interrupts the call is still the abort or the timeout. `onStoreError` (`'fail-open' | 'fail-closed'`, no default) is validated when the middleware or limiter is built. A malformed Upstash `EVAL` reply is a store failure and never an admission: the reply must be an array of one status (exactly `0` or `1`) and one non-negative integer counter per window, a `1` must follow from windows that started under their limits, and a `0` must be explained by a window over its limit (an unknown status such as `2` used to read as a denial that a low count then turned into `allowed: true`).
  - **Order.** `Middleware` gains a readonly `role?: 'retry' | 'quota'` (set by `retryMiddleware` and `providerQuotaMiddleware`, not configurable); `createClient` rejects, with `bad_request`, a quota middleware outside a retry middleware, whatever the ids. The middleware looks the policy up by the descriptor's canonical model id, so an alias is limited like its model, and core pins `modelDescriptor` at every middleware boundary.
  - **Time.** Windows are named by the `now` option, else the engine clock (`ctx.clock`; for the limiter, `RateLimitHint.nowMs`, which the engine sets from the same clock), and only a direct `acquire` call with no time uses the system clock.
  - **`upstashQuotaStore({ url, token, timeoutMs?, scheduler? })`** bounds each REST call (default 2,000 ms), passes the caller's signal so a slow store cannot hold a call past its `config.timeoutMs`, clears its timer and listener when a custom `invoke` throws synchronously, and cancels the body of a non-OK response.
  - CI runs the shipped Lua scripts and the Upstash store on a real Lua interpreter (`lua5.4`, `REQUIRE_LUA=1`).

  What hosts must change:

  - Order middleware as `[retryMiddleware(...), providerQuotaMiddleware(...)]`; the reverse is rejected at construction.
  - Pass `onStoreError: 'fail-open' | 'fail-closed'` to `providerQuotaMiddleware`, `providerQuotaRateLimiter` and `enforceProviderQuota` whenever a store is given: there is no default and a missing value is `bad_request`. Handle `quota_store_unavailable` (the quota store is down, not the provider) where you handle store outages, and `reason: 'quota_window'` by rescheduling (`retryAfterMs` is still set) rather than retrying in process.
  - A custom `QuotaStore` implements `adjustTokens` (a no-op when it enforces no `tpm`), bounds its own calls (`adjustTokens` is not awaited by the call), and its `checkAndConsume` receives the optional `tpm`, `tokens` and `dayBoundary` inputs. A custom `RateLimiter` may ignore the new `hint` and `usage` arguments.
  - Rename `quotaPolicyForGemini({ defaultLimits })` to `defaults`; key `models` by canonical ids; pass a finite `maxDeferMs`; to wait out a per-minute window with `retryMiddleware`, set its `maxDelayMs` and `maxAttempts` high enough (every deferral consumes an attempt).
  - Replace `rpm: 0` meaning "unlimited" with an omitted `rpm`; `tpm: 0` is a disabled provider, not an error. Existing per-day counters keyed by the UTC date, or by a non-canonical zone alias, are not reused. Handlers `onEvent`, `onReconcileError` and `onWindowChecksSkipped` may be `async`: a rejection can no longer crash the process.

## 0.4.2

### Patch Changes

- Updated dependencies [64942d1]
  - @gullabs/core@0.15.0

## 0.4.1

### Patch Changes

- Updated dependencies [cb4980f]
  - @gullabs/core@0.14.1

## 0.4.0

### Minor Changes

- 79bac18: Raise the supported runtime and narrow provider peer ranges.

  - **Breaking:** `engines.node` is now `>=22.12.0` on every published package. Node 20
    reached end of life in April 2026 and is no longer supported.
  - **Breaking:** `@gullabs/google` requires `@google/genai` `^2` (was `^1 || ^2`), and
    `@gullabs/any-llm` now depends on `@google/genai` `^2.19.0`.
  - **Breaking:** `@gullabs/xai` requires `openai` `^7` (was `^6 || ^7`).

  Development moves to Node 24 (`.nvmrc` pins 24.20.0) and pnpm 11.24.0; pnpm settings
  now live in `pnpm-workspace.yaml` rather than `package.json` and `.npmrc`.

### Patch Changes

- 79bac18: Point `repository.url`, `homepage`, and `bugs` at the canonical GitHub org path
  `gul-labs/any-llm`. The org was renamed from `GulLabs`; the old path still
  redirects in a browser, but npm provenance matches `repository.url` literally
  against the attestation's `sourceRepositoryURI`, so a redirect does not satisfy
  it and the next provenance publish would have failed the same way the earlier
  lowercase-casing incident did.

  The npm scope `@gullabs` is a separate namespace and is unchanged.

- Updated dependencies [79bac18]
- Updated dependencies [79bac18]
  - @gullabs/core@0.14.0

## 0.3.8

### Patch Changes

- Updated dependencies [6a5a662]
  - @gullabs/core@0.13.1

## 0.3.7

### Patch Changes

- Updated dependencies [0521973]
- Updated dependencies [0521973]
  - @gullabs/core@0.13.0

## 0.3.6

### Patch Changes

- Updated dependencies [90a47a1]
  - @gullabs/core@0.12.1

## 0.3.5

### Patch Changes

- Updated dependencies [2ab1ea6]
  - @gullabs/core@0.12.0

## 0.3.4

### Patch Changes

- Updated dependencies [d46fd27]
  - @gullabs/core@0.11.0

## 0.3.3

### Patch Changes

- Updated dependencies [a3f74be]
  - @gullabs/core@0.10.0

## 0.3.2

### Patch Changes

- Updated dependencies [20453fc]
  - @gullabs/core@0.9.0

## 0.3.1

### Patch Changes

- 0b44a5e: Provider-plugin architecture: `@gullabs/core` becomes provider-agnostic (zero Google/Gemini/Gemma knowledge), provider packages own their model configs, pricing, and options types, and wiring goes through a new `composeProviders()` seam. New `@gullabs/xai` package adds a Grok provider (breaking, pre-1.0).

  **Breaking changes:**

  - `ProviderOptions` is removed as a closed type. It is replaced by an extensible `ProviderOptionsMap` interface; provider packages declare their own options via module augmentation (`declare module '@gullabs/core' { interface ProviderOptionsMap { google?: GoogleProviderOptions } }`).
  - `GenConfig.serviceTier` widens from Google's literal union `'flex' | 'standard'` to an opaque provider-defined `string`; `ModelDescriptor.capabilities.serviceTiers` widens to `readonly string[]`. Retry tier pinning (`revalidatePinnedServiceTier`) is now descriptor-driven instead of hardcoding Google's tier vocabulary.
  - `GenConfig.flexFallback` is removed from core. It now lives under `providerOptions.google.flexFallback`, admitted only by the flex branch of each Gemini model's config schema.
  - `@gullabs/core` no longer exports any Google/Gemini/Gemma-named symbol: `GoogleProviderOptions`, `GoogleSafetySetting`, `GoogleSearchTool`, the Gemini/Gemma model descriptors and config schemas, `GEMINI_PRICING`, `TIER_FACTOR`, `geminiPricingSource`, and `defaultGeminiRegistry` all move to `@gullabs/google`. They remain available from `@gullabs/any-llm`, which re-exports both `@gullabs/core` and `@gullabs/google`.
  - `ClientConfig.modelRegistry` is now required — there is no default registry. Build one via `composeProviders()`.
  - `GeminiClientLike.countTokens` is now a required method on the structural client interface. Anyone building a custom fake against this interface (including via `@gullabs/testing`) must implement it.

  **New features:**

  - New `@gullabs/xai` package: an xAI Grok provider adapter (`xaiProvider()`) with `grok-4.5` on the Responses API — reasoning (`low`/`high` effort), native structured output, vision, automatic caching via `promptCacheKey`, and live-verified pricing including the >200k long-context tier.
  - New `ProviderPlugin` interface and `composeProviders()` helper in `@gullabs/core` — the standard way to wire one or more provider packages into `createClient`: `createClient({ ...composeProviders([googleProvider(), xaiProvider()]) })`.
  - New `Client.countTokens()` — dry-run token counting with no generation and no billing, implemented for Google via `@google/genai`'s `models.countTokens`.
  - `GoogleCacheStore` gains an optional token-count preflight gate before cache creation.
  - New `geminiContentToMessages()` migration utility in `@gullabs/google` for converting hand-authored `@google/genai` prompts into any-llm's normalized message shape.
  - New `assertRegistryInvariants()` shared test helper in `@gullabs/testing` for provider-package model-onboarding tests (schema-artifact completeness, JSON-schema staleness, pinned model-id lists, pricing coverage, fixture-list membership).
  - New `claudeCliProvider()` / `codexCliProvider()` plugin factories for the existing dev-only CLI provider packages, so they compose the same way as API-backed providers.

  **Migration notes:**

  Wire providers through `composeProviders()` instead of constructing `adapters`/`modelRegistry`/`pricingSources` by hand:

  ```ts
  import { createClient, composeProviders } from '@gullabs/core'
  import { googleProvider } from '@gullabs/google'

  const client = createClient({
    ...composeProviders([googleProvider()]),
  })
  ```

  Flex-fallback configuration moves to `providerOptions.google.flexFallback` on the request.

- Updated dependencies [0b44a5e]
  - @gullabs/core@0.8.0

## 0.3.0

### Minor Changes

- ba21620: Provider-qualified model identity — explicit `(provider, model)` everywhere (breaking, pre-1.0).

  - `LlmRequest`, `CallSite`, and `ResolvedRequest` now require a top-level `provider: string`; `model` stays the bare provider-native string forwarded verbatim to SDKs/CLIs. Bare requests without a provider, unregistered `(provider, model)` pairs, and slash-style `'provider/model'` strings are rejected with `bad_request`.
  - `ModelRegistry` is keyed by `(provider, model)`: `resolve(provider, model)`, `ModelDescriptor.id` renamed to `model`, duplicate exact pairs throw, the same bare model may exist under multiple providers with different config schemas, and prefix matching never crosses providers.
  - Routing is always by `req.provider`: the single-adapter bypass is removed, custom `route(provider, model, adapters)` results are checked against `adapter.id === req.provider`, and `createClient` verifies every registry descriptor's provider has a matching adapter.
  - Pricing composes per provider: `ClientConfig.pricing` is replaced by `pricingSources: Record<provider, PricingSource>`; the port shape is unchanged and `geminiPricingSource()` is the google-scoped source. A provider without a source yields an unpriced result with a warning.
  - Telemetry events carry `provider`; quota's `providerQuotaMiddleware` reads `req.provider` from the request (the `provider` option is removed).

### Patch Changes

- Updated dependencies [ba21620]
  - @gullabs/core@0.7.0

## 0.2.5

### Patch Changes

- Updated dependencies [e3da339]
  - @gullabs/core@0.6.0

## 0.2.4

### Patch Changes

- Updated dependencies [b39ceac]
  - @gullabs/core@0.5.0

## 0.2.3

### Patch Changes

- Updated dependencies [78b7636]
  - @gullabs/core@0.4.3

## 0.2.2

### Patch Changes

- c1aa7ad: Open-source documentation pass: rewrote the root README and all package READMEs for
  accuracy and consistency, fixed stale content in DESIGN.md/SPEC.md/docs/architecture.md
  left over from the forward-only structured-output migration, restructured the root
  CHANGELOG.md to point at each package's own changelog, archived internal planning docs
  into `docs/archive/`, and scrubbed a private host name from a `@gullabs/core` source
  comment (no behavior change).

  `@gullabs/any-llm` also ships a new Agent Skill at `skills/any-llm/SKILL.md` teaching AI
  coding assistants (e.g. Claude Code) how to use this library correctly — per-call auth,
  the forward-only structured-output contract, error handling, and common mistakes.

- Updated dependencies [c1aa7ad]
  - @gullabs/core@0.4.2

## 0.2.1

### Patch Changes

- dab0792: Fix bugs found in an independent adversarial audit of the adoption-backlog implementation:

  - `@gullabs/core`: `resolveReasoning()` no longer throws for positive sub-tier `budgetTokens` values on level-api models (only an explicit `0` budget is rejected as "none"); the engine no longer double-counts rate-limiter queue wait as provider-dispatch `latencyMs` when a call fails before dispatch ever starts (`latencyMs` is now `0` in that case, matching the documented `queueDelayMs`/`latencyMs` split).
  - `@gullabs/google`: add `normalizeGroundingCitations()` and the `Citation` type, a fail-open post-processing helper for deduplicating and normalizing Gemini grounding-chunk citations.
  - `@gullabs/quota`: reject non-integer/negative `rpm`/`rpd` quota-rule config with a deterministic `LlmError` (`kind: "bad_request"`, `retryable: false`) instead of a plain `Error` or silently disabling enforcement.

- Updated dependencies [dab0792]
  - @gullabs/core@0.4.1

## 0.2.0

### Minor Changes

- Implement the adoption backlog: add core reasoning resolution exports, pricing-source introspection
  and construction-time strict pricing, unpriced-cost warnings, queue-delay attribution on results and
  records, Drizzle `queue_delay_ms`, hardened quota deny/defer decisions, service-tier re-validation
  after Google provider-options merge, and deterministic testing support for rate-limiter wait time.

  Docs now cover ledger sidecar transaction composition, `metadata.operationId` correlation for
  grounded-to-structured workflows, multi-runtime retry caveats, and caller-owned structured-output
  validation.

### Patch Changes

- Updated dependencies
  - @gullabs/core@0.4.0

## 0.1.0

### Minor Changes

- Add the provider-quota companion package for any-llm with typed allow/defer/deny decisions,
  middleware and `RateLimiter` adapters, and an Upstash-compatible distributed store.
