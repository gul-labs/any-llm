---
'@gullabs/drizzle': minor
---

`assertLlmCallsSchema(db)` detects an un-migrated `llm_calls` table without writing.

The sink writes every column on every row, so a table that missed an upgrade (such as `0001-add-error-reason.sql`) makes every insert fail, successes included, and the engine swallows sink failures by design. The sink stays fail-open and gets no compatibility path for the old shape. Instead the failure is loud and detectable: every dropped row is logged at `error` as `llm.call.sink.failed` (now with `attemptId`, `attemptNumber`, `provider`, `model`), and the new `assertLlmCallsSchema(db)` selects every column the schema names with `LIMIT 0` and rejects with an error that points at `sql/upgrades/`. It needs no running client: call it from a deploy or CI step, a readiness endpoint or at boot.

What hosts must change:

- Run the upgrade SQL in `@gullabs/drizzle/sql/upgrades/` before deploying the new sink, on every release that ships one. The packages version in lockstep, so a core bump for an unrelated fix is a drizzle bump too.
- Alert on `llm.call.sink.failed`, or call `assertLlmCallsSchema(db)` where it fits.
