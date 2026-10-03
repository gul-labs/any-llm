-- @gullabs/drizzle upgrade: the `llm_call_payloads` table (opt-in payload storage).
--
-- Applies after 0002-ledger-v2.sql. It adds one table, `llm_call_payloads`, keyed
-- by `attempt_id` with a foreign key to `llm_calls` (ON DELETE CASCADE) and an
-- index on `created_at` that the purge helper uses. It does not touch
-- `llm_calls` or any existing row. The table stays empty unless a client sets
-- `ClientConfig.payloads`; a host that never does can skip this file (the sink
-- then never writes to the table).
--
-- Every statement is idempotent on its own, so the file is safe to run twice and
-- safe to resume after a failed statement, whether it runs inside one
-- transaction or statement by statement (`psql -f` without `-1`). Run it with
-- `psql -v ON_ERROR_STOP=1 -f ...` so a statement that gives up on `lock_timeout`
-- stops the file instead of being skipped.
--
-- A table that is already called `llm_call_payloads` and is not this one (a
-- payload table you built yourself) must be renamed first, with its index and
-- foreign key, for example:
--
--   ALTER TABLE llm_call_payloads RENAME TO app_llm_call_payloads;
--
-- The first statement below stops the file with an error when such a table
-- exists, rather than let `CREATE TABLE IF NOT EXISTS` skip it and leave the sink
-- writing into a table of another shape.
--
-- Locks: `SET lock_timeout` makes a statement that cannot get its lock within 3 s
-- fail instead of queueing behind (and blocking) sink writes. Creating the
-- foreign key takes a brief SHARE ROW EXCLUSIVE lock on `llm_calls`; the new
-- table is empty, so nothing is scanned. Re-run the file when it fails.
--
-- Payloads can contain customer data. This library never deletes them on its
-- own: schedule `purgeLlmCallPayloads` and use `deleteLlmCallPayloads`.
--
-- The table names are `llm_calls` and `llm_call_payloads`. If your Drizzle tables
-- use other names, substitute them (including in the catalog check below).

SET lock_timeout = '3s';

DO $$
BEGIN
  IF to_regclass('llm_call_payloads') IS NOT NULL AND (
    SELECT count(*) FROM pg_catalog.pg_attribute
     WHERE attrelid = to_regclass('llm_call_payloads')
       AND attnum > 0 AND NOT attisdropped
       AND attname IN ('attempt_id', 'request', 'response', 'created_at')
  ) <> 4 THEN
    RAISE EXCEPTION 'llm_call_payloads already exists and is not the @gullabs/drizzle payload table; rename it first (see the header of this file)';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS llm_call_payloads (
  attempt_id TEXT         PRIMARY KEY,
  request    JSONB        NOT NULL,
  response   JSONB        NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT llm_call_payloads_attempt_id_llm_calls_attempt_id_fk
    FOREIGN KEY (attempt_id) REFERENCES llm_calls (attempt_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS llm_call_payloads_created_at_idx
  ON llm_call_payloads (created_at);

RESET lock_timeout;
