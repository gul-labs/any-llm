-- @gullabs/drizzle: fresh install of the `llm_calls` ledger table.
--
-- Matches `llmCalls` in `src/schema.ts` of this release. Use it on a database
-- that has no `llm_calls` table. To move an existing table forward, apply the
-- files in `sql/upgrades/` instead.
--
-- `error_reason` has no CHECK constraint on purpose: the reason vocabulary is a
-- closed TypeScript union that grows in core releases, and a new member must
-- never need SQL.
--
-- The table name is `llm_calls`. If your Drizzle table uses another name,
-- substitute it throughout.

CREATE TABLE llm_calls (
  record_schema_version INTEGER      NOT NULL,
  call_id               TEXT         NOT NULL,
  attempt_id            TEXT         PRIMARY KEY,
  call_site_id          TEXT,
  external_id           TEXT,
  auth_key_id           TEXT,
  provider              TEXT         NOT NULL,
  model                 TEXT         NOT NULL,
  model_version         TEXT,
  response_id           TEXT,
  service_tier          TEXT,
  served_service_tier   TEXT,
  status                TEXT         NOT NULL,
  finish_reason         TEXT,
  output_parsed         BOOLEAN,
  latency_ms            INTEGER,
  queue_delay_ms        INTEGER,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cached_input_tokens   INTEGER,
  thinking_tokens       INTEGER,
  total_tokens          INTEGER,
  cost_micro_usd        INTEGER,
  pricing_version       TEXT,
  token_details         JSONB        NOT NULL,
  raw_usage             JSONB,
  provider_metadata     JSONB,
  citations             JSONB,
  tool_calls            JSONB,
  tool_names            JSONB,
  tool_count            INTEGER,
  warnings              JSONB,
  generation_config     JSONB        NOT NULL,
  reasoning_text        TEXT,
  error_kind            TEXT,
  error_reason          TEXT,
  error_message         TEXT,
  attempt_number        INTEGER      NOT NULL,
  metadata              JSONB        NOT NULL,
  created_at            TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX llm_calls_call_id_idx ON llm_calls (call_id);
CREATE INDEX llm_calls_external_id_idx ON llm_calls (external_id);
