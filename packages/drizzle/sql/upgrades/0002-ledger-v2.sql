-- @gullabs/drizzle upgrade: ledger v2 (record schema version 2).
--
-- Applies after 0001-add-error-reason.sql (the table already has `error_reason`,
-- which this file does not touch). Idempotent: running it twice is a no-op.
--
-- Adds:
--   * `cost_confidence`, `cost_details`, `cost_unpriced_reason`: the cost facts
--     the engine computes and the ledger used to drop. Existing rows keep NULL:
--     their confidence was never stored and cannot be recovered; their
--     `record_schema_version` is 1.
--   * indexes on `created_at` and `(call_site_id, created_at)` for time-window
--     and per-call-site queries.
--   * CHECK constraints on `status` and `error_kind` (the closed core
--     vocabularies). `error_reason` stays unconstrained on purpose: its
--     vocabulary grows in core releases and a new member must never need SQL.
--
-- Lock note: the CHECK constraints are validated against every existing row
-- and the indexes are built without CONCURRENTLY, so a very large table is
-- locked while this runs. Run it in a maintenance window, or create the
-- indexes yourself with CREATE INDEX CONCURRENTLY (same names) beforehand; the
-- IF NOT EXISTS clauses then skip them.
--
-- The table name is `llm_calls`. If your Drizzle table uses another name,
-- substitute it.

ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS cost_confidence TEXT;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS cost_details JSONB;
ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS cost_unpriced_reason TEXT;

CREATE INDEX IF NOT EXISTS llm_calls_created_at_idx ON llm_calls (created_at);
CREATE INDEX IF NOT EXISTS llm_calls_call_site_created_at_idx
  ON llm_calls (call_site_id, created_at);

ALTER TABLE llm_calls DROP CONSTRAINT IF EXISTS llm_calls_status_check;
ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_status_check
  CHECK (status IN ('ok', 'api_error', 'timeout', 'aborted', 'content_filter'));

ALTER TABLE llm_calls DROP CONSTRAINT IF EXISTS llm_calls_error_kind_check;
ALTER TABLE llm_calls ADD CONSTRAINT llm_calls_error_kind_check
  CHECK (error_kind IN ('invalid_auth', 'rate_limited', 'server', 'timeout', 'aborted',
                        'bad_request', 'content_filter', 'unknown'));
