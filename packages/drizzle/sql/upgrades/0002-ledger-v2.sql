-- @gullabs/drizzle upgrade: ledger v2 (record schema version 2).
--
-- Applies after 0001-add-error-reason.sql (the table already has `error_reason`,
-- which this file does not touch). Every statement is idempotent on its own, so
-- the file is safe to run twice and safe to resume after a failed statement,
-- whether it runs inside one transaction or statement by statement (`psql -f`
-- without `-1`). Run it with `psql -v ON_ERROR_STOP=1 -f ...` so a statement
-- that gives up on `lock_timeout` stops the file instead of being skipped.
--
-- Adds:
--   * `cost_confidence`, `cost_details`, `cost_unpriced_reason`: the cost facts
--     the engine computes and the ledger used to drop. Existing rows keep NULL:
--     their confidence was never stored and cannot be recovered; their
--     `record_schema_version` is 1.
--   * indexes on `created_at` and `(call_site_id, created_at)` for time-window
--     and per-call-site queries.
--   * CHECK constraints on `status` and `error_kind` (the closed core
--     vocabularies), added NOT VALID: they are enforced for every new and
--     updated row at once, and existing rows are checked later by
--     `0002-validate-checks.sql`, which you run after cleaning legacy rows (see
--     that file). `error_reason` stays unconstrained on purpose: its vocabulary
--     grows in core releases and a new member must never need SQL.
--
-- Locks and what to do on a big table:
--   * `SET lock_timeout` below makes any statement that cannot get its table lock
--     within 3 s fail instead of queueing. A queued ALTER blocks every insert
--     behind it, and the sink drops rows it cannot write within `sinkTimeoutMs`.
--     Re-run the file when it fails; nothing is half-applied that the next run
--     does not finish. `lock_timeout` bounds the wait for a lock, not the work
--     done once the lock is held.
--   * `ADD COLUMN` (nullable, no default) and `ADD CONSTRAINT ... NOT VALID` hold
--     ACCESS EXCLUSIVE for an instant: no table scan, no rewrite. The constraint
--     statements are skipped when the constraint already exists.
--   * `CREATE INDEX` (as written here) takes a SHARE lock for the whole build:
--     writes to `llm_calls` wait. On a large table build the indexes yourself
--     first, same names, with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (below);
--     the statements here then skip them. `CONCURRENTLY` cannot run inside a
--     transaction block, so use it from a psql session or a migration tool step
--     that does not wrap in a transaction. A failed concurrent build leaves an
--     INVALID index that `IF NOT EXISTS` would accept: find it with
--     `SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid AND
--     indrelid = 'llm_calls'::regclass`, `DROP INDEX` it, and build again.
--
--       CREATE INDEX CONCURRENTLY IF NOT EXISTS llm_calls_created_at_idx
--         ON llm_calls (created_at);
--       CREATE INDEX CONCURRENTLY IF NOT EXISTS llm_calls_call_site_created_at_idx
--         ON llm_calls (call_site_id, created_at);
--
-- The table name is `llm_calls`. If your Drizzle table uses another name,
-- substitute it (including in the catalog checks below).

SET lock_timeout = '3s';

ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS cost_confidence TEXT;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS cost_details JSONB;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS cost_unpriced_reason TEXT;

CREATE INDEX IF NOT EXISTS llm_calls_created_at_idx ON llm_calls (created_at);
CREATE INDEX IF NOT EXISTS llm_calls_call_site_created_at_idx
  ON llm_calls (call_site_id, created_at);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'llm_calls'::regclass AND conname = 'llm_calls_status_check'
  ) THEN
    ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_status_check
      CHECK (status IN ('ok', 'api_error', 'timeout', 'aborted', 'content_filter'))
      NOT VALID;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'llm_calls'::regclass AND conname = 'llm_calls_error_kind_check'
  ) THEN
    ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_error_kind_check
      CHECK (error_kind IN ('invalid_auth', 'rate_limited', 'server', 'timeout', 'aborted',
                            'bad_request', 'content_filter', 'unknown'))
      NOT VALID;
  END IF;
END
$$;

RESET lock_timeout;
