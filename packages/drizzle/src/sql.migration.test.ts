/**
 * Migration tests for the shipped SQL in `packages/drizzle/sql/`.
 *
 * - `install.sql` (fresh install) must produce exactly the table `schema.ts`
 *   describes: same columns, SQL types, nullability, defaults and indexes.
 * - `upgrades/0001-add-error-reason.sql` must take the table shape published
 *   in `@gullabs/drizzle` 0.7.2 to the same shape as a fresh install, keep
 *   existing rows, and be safe to run twice.
 * - `error_reason` carries no CHECK constraint, so a reason added to the core
 *   union later needs no SQL.
 *
 * Runs on PGlite (in-memory WASM Postgres): offline, no Docker.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { getTableColumns } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { describe, expect, it } from 'vitest'
import { assertLlmCallsSchema, drizzleUsageSink, type InsertableDb } from './sink.js'
import { llmCalls } from './schema.js'
import { LlmError, createClient, createModelRegistry } from '@gullabs/core'
import type { LlmCallRecord, Logger } from '@gullabs/core'
import { FakeAdapter, FakeClock, FakeIds } from '@gullabs/testing'
import { makePermissiveTestDescriptor } from '../../core/src/test-model-descriptor.js'

function sqlFile(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../sql/${relative}`, import.meta.url)),
    'utf8',
  )
}

/**
 * The `llm_calls` shape published in `@gullabs/drizzle` 0.7.2, written out
 * independently of the shipped SQL: `schema.ts` at tag `@gullabs/drizzle@0.7.2`
 * (`raw_usage` already nullable, ADR-027). It is the "from" side of the upgrade.
 */
const PUBLISHED_0_7_2_SQL = /* sql */ `
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
    error_message         TEXT,
    attempt_number        INTEGER      NOT NULL,
    metadata              JSONB        NOT NULL,
    created_at            TIMESTAMPTZ  DEFAULT now()
  );
  CREATE INDEX llm_calls_call_id_idx ON llm_calls (call_id);
  CREATE INDEX llm_calls_external_id_idx ON llm_calls (external_id);
`

const OLD_ROW_SQL = /* sql */ `
  INSERT INTO llm_calls (
    record_schema_version, call_id, attempt_id, provider, model, status,
    token_details, generation_config, attempt_number, metadata, error_kind
  ) VALUES (
    1, 'old_call', 'old_attempt', 'google', 'gemini-2.5-pro', 'api_error',
    '{}', '{}', 1, '{}', 'server'
  );
`

interface ColumnInfo {
  column_name: string
  data_type: string
  is_nullable: string
  column_default: string | null
}

async function describeTable(pg: PGlite): Promise<ColumnInfo[]> {
  const res = await pg.query<ColumnInfo>(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = 'llm_calls'
      ORDER BY column_name`,
  )
  return res.rows
}

async function indexNames(pg: PGlite): Promise<string[]> {
  const res = await pg.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'llm_calls' ORDER BY indexname`,
  )
  return res.rows.map((r) => r.indexname)
}

function makeRecord(overrides: Partial<LlmCallRecord> = {}): LlmCallRecord {
  return {
    recordSchemaVersion: 1,
    callId: 'new_call',
    attemptId: 'new_attempt',
    attemptNumber: 1,
    provider: 'google',
    model: 'gemini-2.5-pro',
    status: 'api_error',
    latencyMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    tokenDetails: {},
    rawUsage: null,
    generationConfig: {},
    metadata: {},
    createdAt: '2026-10-03T00:00:00.000Z',
    errorKind: 'rate_limited',
    errorMessage: 'x',
    ...overrides,
  }
}

describe('install.sql (fresh install)', () => {
  it('creates exactly the columns, nullability and indexes that schema.ts declares', async () => {
    const pg = new PGlite()
    await pg.exec(sqlFile('install.sql'))

    const columns = await describeTable(pg)
    const declared = Object.values(getTableColumns(llmCalls)).map((c) => c.name)
    expect(columns.map((c) => c.column_name).sort()).toEqual([...declared].sort())

    const notNull = Object.values(getTableColumns(llmCalls))
      .filter((c) => c.notNull)
      .map((c) => c.name)
      .sort()
    expect(
      columns
        .filter((c) => c.is_nullable === 'NO')
        .map((c) => c.column_name)
        .sort(),
    ).toEqual(notNull)

    expect(await indexNames(pg)).toEqual([
      'llm_calls_call_id_idx',
      'llm_calls_external_id_idx',
      'llm_calls_pkey',
    ])
  })

  it('has the SQL type and default schema.ts declares for every column', async () => {
    const pg = new PGlite()
    await pg.exec(sqlFile('install.sql'))
    const byName = new Map((await describeTable(pg)).map((c) => [c.column_name, c]))

    for (const column of Object.values(getTableColumns(llmCalls))) {
      const actual = byName.get(column.name)
      // `timestamp (6) with time zone` -> information_schema's `timestamp with time zone`.
      const declaredType = column.getSQLType().replace(/\s*\(\d+\)/, '')
      expect(actual?.data_type, `type of ${column.name}`).toBe(declaredType)
      expect(actual?.column_default !== null, `default of ${column.name}`).toBe(
        column.hasDefault,
      )
    }
    expect(byName.get('created_at')?.column_default).toBe('now()')
  })

  it('has no CHECK constraint, so a new reason needs no SQL', async () => {
    const pg = new PGlite()
    await pg.exec(sqlFile('install.sql'))

    const checks = await pg.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'llm_calls'::regclass AND contype = 'c'`,
    )
    expect(checks.rows).toEqual([])

    const db = drizzle({ client: pg })
    const sink = drizzleUsageSink(db as unknown as InsertableDb)
    await sink.record(
      makeRecord({ errorReason: 'a_future_member' as unknown as 'quota_window' }),
    )
    const stored = await pg.query<{ error_reason: string }>(
      `SELECT error_reason FROM llm_calls`,
    )
    expect(stored.rows[0]?.error_reason).toBe('a_future_member')
  })
})

describe('upgrades/0001-add-error-reason.sql (from the 0.7.2 shape)', () => {
  it('the 0.7.2 fixture has no error_reason column before the upgrade', async () => {
    const pg = new PGlite()
    await pg.exec(PUBLISHED_0_7_2_SQL)
    expect((await describeTable(pg)).map((c) => c.column_name)).not.toContain(
      'error_reason',
    )
  })

  it('yields the same table as a fresh install and keeps existing rows', async () => {
    const upgraded = new PGlite()
    await upgraded.exec(PUBLISHED_0_7_2_SQL)
    await upgraded.exec(OLD_ROW_SQL)
    await upgraded.exec(sqlFile('upgrades/0001-add-error-reason.sql'))

    const fresh = new PGlite()
    await fresh.exec(sqlFile('install.sql'))

    expect(await describeTable(upgraded)).toEqual(await describeTable(fresh))
    expect(await indexNames(upgraded)).toEqual(await indexNames(fresh))

    const old = await upgraded.query<{ attempt_id: string; error_reason: string | null }>(
      `SELECT attempt_id, error_reason FROM llm_calls`,
    )
    expect(old.rows).toEqual([{ attempt_id: 'old_attempt', error_reason: null }])
  })

  it('is idempotent: a second run changes neither the table, the indexes nor the rows', async () => {
    const pg = new PGlite()
    await pg.exec(PUBLISHED_0_7_2_SQL)
    await pg.exec(OLD_ROW_SQL)
    await pg.exec(sqlFile('upgrades/0001-add-error-reason.sql'))
    const table = await describeTable(pg)
    const indexes = await indexNames(pg)
    const rows = await pg.query(`SELECT * FROM llm_calls`)

    await pg.exec(sqlFile('upgrades/0001-add-error-reason.sql'))

    expect(await describeTable(pg)).toEqual(table)
    expect(await indexNames(pg)).toEqual(indexes)
    expect((await pg.query(`SELECT * FROM llm_calls`)).rows).toEqual(rows.rows)
  })

  it('the sink writes and reads error_reason on the upgraded table', async () => {
    const pg = new PGlite()
    await pg.exec(PUBLISHED_0_7_2_SQL)
    await pg.exec(OLD_ROW_SQL)
    await pg.exec(sqlFile('upgrades/0001-add-error-reason.sql'))

    const db = drizzle({ client: pg })
    const sink = drizzleUsageSink(db as unknown as InsertableDb)
    await sink.record(makeRecord({ errorReason: 'quota_window' }))

    const rows = await db.select().from(llmCalls)
    const byId = Object.fromEntries(rows.map((r) => [r.attemptId, r.errorReason]))
    expect(byId).toEqual({ old_attempt: null, new_attempt: 'quota_window' })
  })

  it('without the upgrade sink.record itself rejects on the old shape (the engine, not the sink, swallows it)', async () => {
    const pg = new PGlite()
    await pg.exec(PUBLISHED_0_7_2_SQL)
    const db = drizzle({ client: pg })
    const sink = drizzleUsageSink(db as unknown as InsertableDb)
    await expect(sink.record(makeRecord())).rejects.toThrow()
  })
})

describe('a table that was not migrated is detectable, and the engine logs every dropped row loudly', () => {
  const OK = {
    text: 'ok',
    usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
    model: 'm',
    warnings: [],
  }

  it('assertLlmCallsSchema resolves on a fresh install and after the upgrade', async () => {
    const fresh = new PGlite()
    await fresh.exec(sqlFile('install.sql'))
    await expect(
      assertLlmCallsSchema(drizzle({ client: fresh })),
    ).resolves.toBeUndefined()

    const upgraded = new PGlite()
    await upgraded.exec(PUBLISHED_0_7_2_SQL)
    await upgraded.exec(sqlFile('upgrades/0001-add-error-reason.sql'))
    await expect(
      assertLlmCallsSchema(drizzle({ client: upgraded })),
    ).resolves.toBeUndefined()
  })

  it('assertLlmCallsSchema rejects on the old shape and points at the upgrade SQL', async () => {
    const pg = new PGlite()
    await pg.exec(PUBLISHED_0_7_2_SQL)
    const err = (await assertLlmCallsSchema(drizzle({ client: pg })).catch(
      (e: unknown) => e,
    )) as Error

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('sql/upgrades')
    expect(err.cause).toBeDefined()
  })

  it('through the engine, every row (success, attempt failure, refusal) is dropped with an error-level llm.call.sink.failed and the call is unaffected', async () => {
    const pg = new PGlite()
    await pg.exec(PUBLISHED_0_7_2_SQL)
    const events: Array<{ level: string; event: string; ctx: Record<string, unknown> }> =
      []
    const logger: Logger = {
      debug() {},
      info() {},
      warn() {},
      error: (ctx, event) => void events.push({ level: 'error', event, ctx }),
    }
    let seen = 0
    const adapter = new FakeAdapter('google', [
      OK,
      new LlmError('provider down', { kind: 'server', retryable: false }),
    ])
    const client = createClient({
      adapters: [adapter],
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ provider: 'google', model: 'm' }),
      ]),
      sink: drizzleUsageSink(drizzle({ client: pg }) as unknown as InsertableDb),
      clock: new FakeClock(),
      ids: new FakeIds(),
      logger,
      middleware: [
        {
          id: 'refuser',
          async intercept(req, ctx, next) {
            if (++seen === 3) {
              throw new LlmError('refused', { kind: 'rate_limited', retryable: false })
            }
            return next(req, ctx)
          },
        },
      ],
    })
    const request = {
      provider: 'google',
      model: 'm',
      messages: [
        { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] },
      ],
    }

    const call = () => client.generate(request, { auth: { apiKey: 'k' } })
    await expect(call()).resolves.toMatchObject({ text: 'ok' }) // success row
    await expect(call()).rejects.toMatchObject({ kind: 'server' }) // attempt failure row
    await expect(call()).rejects.toMatchObject({ kind: 'rate_limited' }) // refusal row

    const sinkFailures = events.filter((e) => e.event === 'llm.call.sink.failed')
    expect(sinkFailures).toHaveLength(3)
    expect(sinkFailures.every((e) => e.level === 'error')).toBe(true)
    expect(sinkFailures.every((e) => typeof e.ctx['callId'] === 'string')).toBe(true)
    expect(sinkFailures.every((e) => typeof e.ctx['attemptId'] === 'string')).toBe(true)
    expect((await pg.query('SELECT 1 FROM llm_calls')).rows).toEqual([])
  })
})
