-- @gullabs/drizzle upgrade: add `llm_calls.error_reason`.
--
-- Applies to the table shape published in @gullabs/drizzle 0.7.2 (and earlier
-- shapes that already made `raw_usage` nullable). Idempotent: running it twice
-- is a no-op. Existing rows keep `error_reason` NULL, which is correct: they
-- were written before reasons existed.
--
-- No CHECK constraint on purpose: the reason vocabulary is a closed TypeScript
-- union that grows in core releases, and a new member must never need SQL.
--
-- The table name is `llm_calls`. If your Drizzle table uses another name,
-- substitute it.

ALTER TABLE llm_calls ADD COLUMN IF NOT EXISTS error_reason TEXT;
