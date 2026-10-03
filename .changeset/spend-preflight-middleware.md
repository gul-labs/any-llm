---
'@gullabs/core': minor
---

Add `spendPreflightMiddleware`, an advisory spend check against the host's own ledger (ADR-036 amendment).

`spendPreflightMiddleware({ limitMicroUsd, key, spentSoFar })` calls your `spentSoFar(key)` (micro-USD, from your ledger) before dispatch and, at or above `limitMicroUsd`, throws `rate_limited`, `retryable: false`, `reason: 'spend_ceiling'` with a refusal row. `key` is a string or a function of the request. It is advisory: the read and the dispatch are not atomic, so concurrent workers can overshoot; the call that crosses the ceiling is allowed; and billed calls with unknown usage count only if your ledger counts them. It sets no `Middleware.role` and works inside or outside retry. An enforced ceiling is tracked in `BACKLOG.md`.

What hosts must change:

- Nothing is required. Add it to `ClientConfig.middleware` (first, outside retry, to check once per logical call) if you want a preflight.
