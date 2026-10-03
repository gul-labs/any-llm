---
'@gullabs/quota': minor
'@gullabs/core': minor
---

A fail-closed quota store outage is one non-retryable `quota_store_unavailable` error, and the quota windows are stricter and more consistent.

- New member of the closed `LlmErrorReason` union: `quota_store_unavailable`. Under `onStoreError: 'fail-closed'` every store failure (a timeout, an HTTP failure, a transport failure, a malformed reply, a store that throws its own `rate_limited`) is `LlmError { kind: 'server', retryable: false, reason: 'quota_store_unavailable' }` with the store's error as `cause`. It used to be classified by message text: a timeout became a retryable provider `timeout` (retried three times, three store calls, and a ledger row that said the provider timed out for a call that never reached it), an HTTP failure became `unknown`. Now there is one store call per dispatch and one refusal row. A caller abort or deadline that interrupts the call is still the abort or the timeout. `kind: 'server'` is otherwise retryable; `retryable` stays authoritative.
- `providerQuotaMiddleware` no longer awaits `adjustTokens` after the provider answered: it starts the correction and moves on, on a result and on an error, so a slow store cannot delay either. It is at-most-once (a process that ends first loses it and the reservation stays); a failure is a `backend_error` event and an `llm.quota.reconcile_failed` warning. `Release` and `QuotaAdmission.reconcile` correct once however often they are called.
- `rpm: 0`, `rpd: 0` and `tpm: 0` all mean "provider disabled" (`deny`, `provider_disabled`); a negative or fractional limit is `bad_request`. `rpm: 0` used to mean unlimited and `tpm: 0` was `bad_request`. The policy builders reject an unknown option or limit key (`defaultLimits`, a misspelt `rpmm`, `rpd` on the xAI preset) with `bad_request`.
- `onStoreError` is validated when `providerQuotaMiddleware` or `providerQuotaRateLimiter` is built, not at the first call.
- The per-day counter is keyed by the zone's canonical name: `US/Pacific` and `America/Los_Angeles` share a counter, and UTC spelled any way is the same window as no boundary.
- The skipped-windows warning's message is the event name `llm.quota.windows_skipped` (fields `callId`, `provider`, `model`, `scope`), once per scope instead of once per instance.
- `estimateInputTokens` counts the structured-output schema, so a structured call reserves more `tpm`.
- `upstashQuotaStore` clears its timer and listener when a custom `invoke` throws synchronously, and cancels the body of a non-OK response.
- CI installs `lua5.4` and sets `REQUIRE_LUA=1`: the shipped Lua scripts and the Upstash store run on a real interpreter there, and a missing interpreter fails the run.

What hosts must change:

- Keep a `default` branch when you switch on `LlmError.reason`; handle `quota_store_unavailable` (the quota store is down, not the provider) where you handle store outages.
- Replace `rpm: 0` meaning "unlimited" with an omitted `rpm`. A host that relied on a rejected `tpm: 0` now gets a disabled provider.
- A custom `QuotaStore.adjustTokens` is called without the call waiting for it: bound it yourself.
- Counters keyed with a non-canonical zone alias or with `UTC` as a boundary are not reused.
