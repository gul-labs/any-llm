-- @gullabs/drizzle upgrade: validate the ledger v2 CHECK constraints.
--
-- Run this AFTER `0002-ledger-v2.sql` and AFTER cleaning legacy rows. The
-- constraints `0002-ledger-v2.sql` adds are NOT VALID: they already reject bad
-- values on new and updated rows, but rows written before the upgrade were never
-- checked. `VALIDATE CONSTRAINT` checks them. It takes SHARE UPDATE EXCLUSIVE, so
-- inserts and updates keep running while it scans; it fails, changing nothing,
-- when any existing row violates a constraint. Re-running it once the
-- constraints are valid is a no-op.
--
-- Which rows can violate: `@gullabs/core` 0.2.0 (and the `@gullabs/drizzle`
-- release used with it) wrote `status = 'parse_error'` and
-- `error_kind = 'parse_error'` for a structured-output parse failure. Later
-- releases removed that value; no other release wrote a value outside the
-- vocabularies. A host that never ran 0.2.x has no such rows and can run this
-- file straight away.
--
-- Find them (NULL `error_kind` is allowed and not listed):
--
--   SELECT status, error_kind, count(*) AS rows
--     FROM llm_calls
--    WHERE status NOT IN ('ok', 'api_error', 'timeout', 'aborted', 'content_filter')
--       OR error_kind NOT IN ('invalid_auth', 'rate_limited', 'server', 'timeout',
--                             'aborted', 'bad_request', 'content_filter', 'unknown')
--    GROUP BY status, error_kind ORDER BY rows DESC, status, error_kind;
--
-- This library does not rewrite your history: deciding what an old row becomes
-- is yours. If `parse_error` is the only legacy value, one reasonable mapping
-- keeps the original in `metadata` (JSONB, NOT NULL) and files the row under the
-- closest current values (a failed call that the request or schema caused):
--
--   UPDATE llm_calls
--      SET metadata = metadata || jsonb_build_object('legacy_status', status,
--                                                    'legacy_error_kind', error_kind),
--          status = CASE WHEN status = 'parse_error' THEN 'api_error' ELSE status END,
--          error_kind = CASE WHEN error_kind = 'parse_error' THEN 'bad_request'
--                            ELSE error_kind END
--    WHERE status = 'parse_error' OR error_kind = 'parse_error';
--
-- On a large table run the UPDATE in batches (add a `LIMIT`-ed subselect on
-- `attempt_id`) so it does not hold row locks for long.
--
-- If you would rather keep the old rows exactly as they are, skip this file: the
-- constraints stay NOT VALID, which is safe (new rows are still enforced) and
-- visible as `convalidated = false` in `pg_constraint`.
--
-- The table name is `llm_calls`. If your Drizzle table uses another name,
-- substitute it.

SET lock_timeout = '3s';

ALTER TABLE llm_calls VALIDATE CONSTRAINT llm_calls_status_check;
ALTER TABLE llm_calls VALIDATE CONSTRAINT llm_calls_error_kind_check;

RESET lock_timeout;
