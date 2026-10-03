-- @gullabs/drizzle upgrade: the `llm_call_payloads` table (opt-in payload storage).
--
-- Applies after 0002-ledger-v2.sql. It adds one table, `llm_call_payloads`, keyed
-- by `attempt_id` with a foreign key to `llm_calls` (ON DELETE CASCADE) and an
-- index on `created_at` that the purge helper uses. It does not touch
-- `llm_calls` or any existing row. The table stays empty unless a client sets
-- `ClientConfig.payloads`; a host that never does can skip this file (the sink
-- then never writes to the table).
--
-- The file is one transaction (`BEGIN` ... `COMMIT`), so it applies whole or not at
-- all, and the `lock_timeout` it sets is `SET LOCAL`: it ends with the
-- transaction, even when a statement fails, and never lingers on a connection a
-- runner reuses. Every statement is also idempotent, so the file is safe to run
-- twice. Run it with `psql -v ON_ERROR_STOP=1 -f ...` so a statement that gives
-- up on `lock_timeout` stops the file. A migration runner that already wraps
-- each file in a transaction must drop the `BEGIN;` and `COMMIT;` lines (the
-- `SET LOCAL` then applies to the runner's transaction).
--
-- A table that is already called `llm_call_payloads` and is not exactly the table
-- this file creates (same four columns with the same types, nullability and
-- default, the same primary key, the same foreign key to `llm_calls` with ON
-- DELETE CASCADE) must be renamed first, with its index and foreign key, for
-- example:
--
--   ALTER TABLE llm_call_payloads RENAME TO app_llm_call_payloads;
--
-- The first statement below stops the file with an error when such a table
-- exists, rather than let `CREATE TABLE IF NOT EXISTS` skip it and leave the sink
-- writing into a table of another shape.
--
-- Locks: `lock_timeout` makes a statement that cannot get its lock within 3 s
-- fail instead of queueing behind (and blocking) sink writes. Creating the
-- foreign key takes a brief SHARE ROW EXCLUSIVE lock on `llm_calls`; the new
-- table is empty, so nothing is scanned. Re-run the file when it fails.
--
-- Payloads can contain customer data. This library never deletes them on its
-- own: schedule `purgeLlmCallPayloads` and use `deleteLlmCallPayloads`.
--
-- The table names are `llm_calls` and `llm_call_payloads`. If your Drizzle tables
-- use other names, substitute them (including in the catalog check below).

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
DECLARE
  rel regclass := to_regclass('llm_call_payloads');
  id_col smallint;
  parent_id_col smallint;
BEGIN
  IF rel IS NULL THEN
    RETURN;
  END IF;
  SELECT attnum INTO id_col FROM pg_catalog.pg_attribute
   WHERE attrelid = rel AND attname = 'attempt_id' AND NOT attisdropped;
  SELECT attnum INTO parent_id_col FROM pg_catalog.pg_attribute
   WHERE attrelid = to_regclass('llm_calls') AND attname = 'attempt_id' AND NOT attisdropped;
  IF id_col IS NULL OR NOT (
    -- exactly these columns: name, type, nullability and default
    (SELECT array_agg(
              a.attname || ' ' || format_type(a.atttypid, a.atttypmod) ||
              CASE WHEN a.attnotnull THEN ' not null' ELSE '' END ||
              COALESCE(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
              ORDER BY a.attname)
       FROM pg_catalog.pg_attribute a
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = rel AND a.attnum > 0 AND NOT a.attisdropped)
    = ARRAY[
        'attempt_id text not null',
        'created_at timestamp with time zone not null default now()',
        'request jsonb not null',
        'response jsonb not null'
      ]
    -- primary key (attempt_id)
    AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = rel AND contype = 'p' AND conkey = ARRAY[id_col]
    )
    -- foreign key (attempt_id) -> llm_calls (attempt_id) ON DELETE CASCADE
    AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint
       WHERE conrelid = rel AND contype = 'f'
         AND conname = 'llm_call_payloads_attempt_id_llm_calls_attempt_id_fk'
         AND confrelid = to_regclass('llm_calls') AND confdeltype = 'c'
         AND conkey = ARRAY[id_col] AND confkey = ARRAY[parent_id_col]
    )
  ) THEN
    RAISE EXCEPTION 'llm_call_payloads already exists and is not exactly the @gullabs/drizzle payload table (columns, types, primary key and foreign key must match); rename it first (see the header of this file)';
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

COMMIT;
