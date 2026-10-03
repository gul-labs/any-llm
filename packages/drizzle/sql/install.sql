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
-- `status` and `error_kind` carry CHECK constraints over the closed core
-- vocabularies; a new member of either is a core release that ships SQL.
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
  cost_confidence       TEXT,
  cost_details          JSONB,
  cost_unpriced_reason  TEXT,
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
  created_at            TIMESTAMPTZ  DEFAULT now(),
  CONSTRAINT llm_calls_status_check
    CHECK (status IN ('ok', 'api_error', 'timeout', 'aborted', 'content_filter')),
  CONSTRAINT llm_calls_error_kind_check
    CHECK (error_kind IN ('invalid_auth', 'rate_limited', 'server', 'timeout', 'aborted',
                          'bad_request', 'content_filter', 'unknown'))
);

CREATE INDEX llm_calls_call_id_idx ON llm_calls (call_id);
CREATE INDEX llm_calls_external_id_idx ON llm_calls (external_id);
CREATE INDEX llm_calls_created_at_idx ON llm_calls (created_at);
CREATE INDEX llm_calls_call_site_created_at_idx ON llm_calls (call_site_id, created_at);
