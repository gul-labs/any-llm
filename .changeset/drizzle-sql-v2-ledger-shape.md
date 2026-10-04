---
'@gullabs/drizzle': minor
---

The ledger SQL is renumbered, `cost_micro_usd` is BIGINT, and two partial indexes serve the queries the guide advertises.

- **Renumbered:** the upgrade files are `0001-add-error-reason.sql`, `0002-ledger-v2.sql`, `0003-validate-checks.sql` (was `0002-validate-checks.sql`) and `0004-llm-call-payloads.sql` (was `0003-llm-call-payloads.sql`), so a numeric-prefix runner accepts the directory. Nothing was published under the old names. `0003` is optional and fails on legacy `parse_error` rows: fix them or skip that file, then apply `0004`.
- **`cost_micro_usd` is `BIGINT`** (INTEGER capped one attempt at 2,147,483,647 micro-USD and dropped its row). `0002-ledger-v2.sql` widens it; the change rewrites the table under an exclusive lock, so run it in a quiet period on a large table or comment that last statement out (the sink works either way). Drizzle reads the column as a JS number; a SQL `SUM()` over it is `numeric`, which the Postgres drivers return as a string: cast it (`::float8`) or `Number()` it. If you already applied the earlier `0002-ledger-v2.sql`, apply it again (it is idempotent).
- **New partial indexes** `llm_calls_error_reason_idx` (`WHERE error_reason IS NOT NULL`) and `llm_calls_auth_key_id_idx` (`WHERE auth_key_id IS NOT NULL`), in `install.sql` and `0002-ledger-v2.sql`, so "find the deferred calls" and per-key queries are not full scans.
- **Documented:** while the CHECKs are `NOT VALID` any `UPDATE` of a legacy row fails with `new row for relation "llm_calls" violates check constraint "llm_calls_error_kind_check"` (or `..._status_check`), including your own tenant-deletion `UPDATE`; run the cleanup in `0003-validate-checks.sql` first. `schema.ts` is for typed queries and `drizzle-kit push`; the SQL files are authoritative and `drizzle-kit generate` cannot produce `NOT VALID` CHECKs or a `lock_timeout`. `token_details` holds xAI's `cost_in_usd_ticks` (1e-10 USD), the only persisted trace of what xAI billed.
