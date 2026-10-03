---
'@gullabs/core': minor
---

`spendPreflightMiddleware` reports an unreadable ledger as a typed `server` error (ADR-036 amendment).

A `spentSoFar` that throws or rejects used to surface the host's raw error classified `unknown`. It now fails the call closed with `LlmError { kind: 'server', retryable: false, cause }`: nothing is dispatched, retry middleware does not repeat it, and `cause` carries the ledger's error. It is not `rate_limited` (no ceiling was reached) and not retryable (a retry reads the same ledger). The docs also state that, inside `retryMiddleware`, a provider failure followed by a ceiling hit leaves the caller with the `spend_ceiling` error. `LlmErrorReason` keeps `'search_budget_exceeded'` as a reserved member that nothing emits until streaming ships (ADR-036 now says so).

What hosts must change:

- A host that matched a ledger failure as `unknown` should match `server` with `retryable: false`, or read `error.cause`.
- Do not branch on `reason: 'search_budget_exceeded'` yet; it is reserved.
