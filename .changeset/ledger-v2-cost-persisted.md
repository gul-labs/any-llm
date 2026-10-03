---
'@gullabs/core': minor
'@gullabs/drizzle': minor
---

Ledger v2: cost confidence and lanes are persisted (ADR-039).

`LlmCallRecord.recordSchemaVersion` is `2`. The record gains `costConfidence` (`'exact' | 'estimated'`), `costDetails` (`{ input, cached, output, tools }`, only when priced) and `costUnpricedReason` (only when `costMicroUsd` is `null`), and `@gullabs/drizzle` writes them to `cost_confidence`, `cost_details` and `cost_unpriced_reason`. `buildRecord` now caps `reasoningText` and `errorMessage` at 16 KiB of UTF-8 (marker `…[truncated]`, plus a warning; the live result and error keep the full text), as the SPEC always claimed. The Drizzle table gains indexes on `created_at` and `(call_site_id, created_at)` and CHECK constraints on `status` and `error_kind` (none on `error_reason`). The `drizzle-orm` peer range is `>=0.36 <1`. New SQL: `sql/install.sql` is updated and `sql/upgrades/0002-ledger-v2.sql` upgrades a table at the 0.7.2 shape plus upgrade 0001; every statement is idempotent on its own. `sql/upgrades/0002-validate-checks.sql` validates the CHECKs separately.

What hosts must change:

- If you use `@gullabs/drizzle`'s `llmCalls` table, run `sql/upgrades/0002-ledger-v2.sql` (after 0001) before deploying this version. Without it every insert fails on the missing columns and, because sinks are fail-open, the rows are dropped; `assertLlmCallsSchema(db)` detects it. The upgrade sets `lock_timeout = '3s'`, adds the two CHECKs `NOT VALID` (enforced for new rows at once) and builds two indexes without `CONCURRENTLY` (a SHARE lock; build them concurrently first on a very large table). Then run `0002-validate-checks.sql` to validate existing rows. Rows written by `@gullabs/core` 0.2.0 (`status` / `error_kind` = `parse_error`) block validation: the file documents the query that finds them and a suggested `UPDATE`; the library does not rewrite your history.
- If you maintain your own table or sink, add the three optional cost columns and persist the new record fields. Check `recordSchemaVersion`: it is now `2`.
- Rows written before this version have NULL cost confidence; it was never stored.
- Code that read a full `reasoningText` or `errorMessage` from a record must expect the 16 KiB cap.
