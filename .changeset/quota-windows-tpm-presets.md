---
'@gullabs/quota': minor
'@gullabs/core': minor
---

Quota gains a time-zone day boundary, tokens per minute, an in-memory store, presets, a bounded Upstash call and an explicit store-failure policy; the `RateLimiter` port carries a token estimate and the attempt's usage.

- `ProviderQuotaRule.dayBoundary?: { timeZone }` (`Intl.DateTimeFormat`, no dependency, correct on DST days) rolls the per-day window over at local midnight; the Lua `EVAL` store sets the counter TTL to the time left in that day. `quotaPolicyForGemini` now defaults to `America/Los_Angeles`: Google's rate-limits page (https://ai.google.dev/gemini-api/docs/rate-limits, read 2026-10-03) says daily quotas reset at midnight Pacific time. Existing per-day counters keyed by the UTC date are not reused.
- `ProviderQuotaRule.tpm` (input tokens per minute). `RateLimiter.acquire(key, signal, hint?: { estimatedInputTokens? })` and `Release = (usage?: Usage) => void`: the engine passes `estimateInputTokens(req)` (new core export, an estimate that does not count media) and releases with the attempt's usage; the middleware does the same itself. The reservation is corrected with the real usage through the new `QuotaStore.adjustTokens`.
- `inMemoryQuotaStore({ clock })`, `quotaPolicy({ provider, models, defaults, dayBoundary?, scope? })`, and `quotaPolicyForXai` (no numbers baked in: xAI limits depend on the team's tier, so the host passes `rpm` and `tpm`).
- `providerQuotaMiddleware` works without a `store`: `rpd: 0` still denies with `provider_disabled`; the windows are skipped with one warning per instance.
- `upstashQuotaStore({ url, token, timeoutMs? })` bounds each REST call (default 2 000 ms) and passes the caller's signal, so a slow store cannot hold a call past its `config.timeoutMs`. It takes a `scheduler` for the timer.

What hosts must change:

- Pass `onStoreError: 'fail-open' | 'fail-closed'` to `providerQuotaMiddleware`, `providerQuotaRateLimiter` and `enforceProviderQuota` whenever a store is given. There is no default; a missing value is `bad_request`.
- A custom `QuotaStore` implements `adjustTokens` (a no-op when it enforces no `tpm`), and its `checkAndConsume` receives the new optional `tpm`, `tokens` and `dayBoundary` inputs.
- Rename `quotaPolicyForGemini({ defaultLimits })` to `defaults`. `enforceProviderQuota` now resolves to a `QuotaAdmission` (`reconcile(usage)`) instead of `void`.
- A custom `RateLimiter` may ignore the new `hint` and `usage` arguments.
