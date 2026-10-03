---
'@gullabs/core': minor
'@gullabs/drizzle': minor
---

Every attempt gets its own ledger row; `LlmRequest.idempotencyKey` is deleted (ADR-031).

`attemptId` used to equal `idempotencyKey` on attempt 1, and the drizzle sink drops a row whose `attempt_id` already exists. A host retry that reused the key (as the docs recommended) made a second billed provider call whose row was silently dropped, so spend was under-reported. Now `attemptId` is always minted by the engine, one per attempt, refusal rows (`attemptNumber: 0`) included. The library never deduplicates provider calls. The sink's `onConflictDoNothing` on `attempt_id` stays and only absorbs an at-least-once sink re-delivering the same record.

What hosts must change:

- Remove `idempotencyKey` from requests (it is a type error now). Give every host-level retry of one logical operation the same `externalId` instead: it is persisted on every attempt row and is indexed in `@gullabs/drizzle`, and it is deliberately not unique.
- History joined on the old key-derived `attemptId`s (`key`, `key:2`, ...) must join on `externalId` going forward. Existing rows are not rewritten.
- To see everything a retried operation cost, query `llm_calls` by `external_id`, not by `attempt_id` or `call_id`.
