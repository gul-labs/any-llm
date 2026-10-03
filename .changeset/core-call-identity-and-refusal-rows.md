---
'@gullabs/core': minor
---

Call identity is captured at call start; the engine re-checks the registry; refusals after an earlier attempt are persisted.

- `generate()` and `runStructured()` read `provider`, `model` and the resolved descriptor once, synchronously, before the first `await`. A host that reuses and reassigns one request or call-site object while a call is still validating can no longer make the adapter receive a model that disagrees with the descriptor it is priced under.
- After `registry.resolve`, `generate`, `runStructured` and `countTokens` verify that the descriptor belongs to the provider and that the requested string is its canonical id or a declared alias (ADR-033). A custom `ModelRegistry` that prefix-matches or returns a fallback descriptor now fails with `bad_request` instead of being priced as the wrong model.
- A call whose final error did not come out of a provider attempt (middleware boundary refusal, quota deferral, retry budget exhausted, abort during back-off) now writes one zero-usage refusal row even when earlier attempts already ran. It is numbered with the refused attempt; `attemptNumber: 0` stays reserved for "no attempt had run". `error_reason` of such calls (for example `quota_window` on attempt 2) is therefore queryable. A gap in attempt numbers means a middleware refused that attempt before dispatch.
- The middleware list is copied and frozen at `createClient`, so reordering or pushing onto the host's array afterwards no longer bypasses the quota-inside-retry check. A wrapper that hides a built-in's `role` is still not detected.
- A whitespace-only answer counts as no answer for the reasoning-cap warning. Unknown-model messages cap the echoed model string and the suggestion scoring at 128 characters.

What hosts must change:

- Custom `ModelRegistry` implementations must resolve exactly (canonical id or declared alias).
- Queries that assumed `attemptNumber: 0` is the only zero-usage refusal row should also expect refusal rows numbered above 0.
