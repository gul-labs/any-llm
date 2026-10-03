---
'@gullabs/core': minor
'@gullabs/drizzle': minor
'@gullabs/google': minor
---

Typed error reasons are persisted.

`LlmCallRecord.errorReason` carries `LlmError.reason` (the closed `LlmErrorReason` union), `CallErrorEvent.reason` carries it to telemetry, and `@gullabs/drizzle` writes it to a new `error_reason` text column. The column has no CHECK constraint, so a reason added in a later core release needs no SQL. The reason is written on provider-attempt rows and on `attemptNumber: 0` refusal rows. `classifyGoogleError` keeps the reason when it re-classifies an `LlmError`. `@gullabs/drizzle` now ships SQL: `sql/install.sql` for a fresh table and `sql/upgrades/0001-add-error-reason.sql` for a table created by 0.7.2 or earlier. ADR-036 records the policy: the union is closed, adding a member is a core minor, and there is no extension form.

What hosts must change:

- If you use `@gullabs/drizzle`'s `llmCalls` table, run `sql/upgrades/0001-add-error-reason.sql` (`ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS error_reason TEXT`) before deploying this version. Without it the sink's insert fails on the missing column, and because sinks are fail-open the rows are dropped.
- If you maintain your own table or sink, add an optional `error_reason` text column and persist `record.errorReason`.
- Keep a `default` branch when you switch on `LlmErrorReason`: new members arrive in core minors.
