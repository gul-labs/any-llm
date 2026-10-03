/**
 * Migration tests for the shipped SQL in `packages/drizzle/sql/`.
 *
 * - `install.sql` (fresh install) must produce exactly the table `schema.ts`
 *   describes: same columns, SQL types, nullability, defaults and indexes.
 * - `upgrades/0001-add-error-reason.sql` takes the table shape published in
 *   `@gullabs/drizzle` 0.7.2 forward, keeps existing rows, and is safe to run
 *   twice.
 * - `upgrades/0002-ledger-v2.sql` takes the previously published shape (0.7.2 plus
 *   upgrade 0001, which already has `error_reason`) to the same shape as a fresh
 *   install, keeps existing rows, and is safe to run twice.
 * - `status` and `error_kind` carry CHECK constraints; `error_reason` carries
 *   none, so a reason added to the core union later needs no SQL.
 *
 * Runs on PGlite (in-memory WASM Postgres): offline, no Docker.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { getTableColumns } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
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

async function checkConstraints(
  pg: PGlite,
): Promise<Array<{ conname: string; def: string }>> {
  const res = await pg.query<{ conname: string; def: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'llm_calls'::regclass AND contype = 'c' ORDER BY conname`,
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
    recordSchemaVersion: 2,
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
      'llm_calls_call_site_created_at_idx',
      'llm_calls_created_at_idx',
      'llm_calls_external_id_idx',
      'llm_calls_pkey',
    ])
  })

  it('declares in schema.ts the same indexes and checks install.sql creates', async () => {
    const pg = new PGlite()
    await pg.exec(sqlFile('install.sql'))
    const config = getTableConfig(llmCalls)
    expect(config.indexes.map((i) => i.config.name).sort()).toEqual(
      (await indexNames(pg)).filter((n) => n !== 'llm_calls_pkey'),
    )
    expect(config.checks.map((c) => c.name).sort()).toEqual(
      (await checkConstraints(pg)).map((c) => c.conname),
    )
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

  it('checks status and error_kind but not error_reason, so a new reason needs no SQL', async () => {
    const pg = new PGlite()
    await pg.exec(sqlFile('install.sql'))

    expect(await checkConstraints(pg)).toEqual([
      expect.objectContaining({ conname: 'llm_calls_error_kind_check' }),
      expect.objectContaining({ conname: 'llm_calls_status_check' }),
    ])
    for (const check of await checkConstraints(pg)) {
      expect(check.def, check.conname).not.toContain('error_reason')
    }

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

  it('rejects a status or error_kind outside the core vocabularies', async () => {
    const pg = new PGlite()
    await pg.exec(sqlFile('install.sql'))
    const sink = drizzleUsageSink(drizzle({ client: pg }) as unknown as InsertableDb)
    await expect(
      sink.record(makeRecord({ status: 'weird' as unknown as 'ok' })),
    ).rejects.toThrow()
    await expect(
      sink.record(makeRecord({ errorKind: 'weird' as unknown as 'server' })),
    ).rejects.toThrow()
    await sink.record(
      makeRecord({ status: 'content_filter', errorKind: 'content_filter' }),
    )
    await sink.record(makeRecord({ attemptId: 'ok_row', status: 'ok' }))
    const rows = await pg.query(`SELECT 1 FROM llm_calls`)
    expect(rows.rows).toHaveLength(2)
  })

  it('persists the cost v2 columns the sink writes', async () => {
    const pg = new PGlite()
    await pg.exec(sqlFile('install.sql'))
    const db = drizzle({ client: pg })
    const sink = drizzleUsageSink(db as unknown as InsertableDb)
    await sink.record(
      makeRecord({
        costMicroUsd: 1500,
        costConfidence: 'estimated',
        costDetails: { input: 1000, cached: 100, output: 300, tools: 100 },
      }),
    )
    await sink.record(
      makeRecord({
        attemptId: 'unpriced',
        costMicroUsd: null,
        costConfidence: 'estimated',
        costUnpricedReason: 'Unknown model "x"; no pricing entry found.',
      }),
    )
    const rows = await db.select().from(llmCalls)
    const byId = Object.fromEntries(rows.map((r) => [r.attemptId, r]))
    expect(byId['new_attempt']).toMatchObject({
      recordSchemaVersion: 2,
      costMicroUsd: 1500,
      costConfidence: 'estimated',
      costDetails: { input: 1000, cached: 100, output: 300, tools: 100 },
      costUnpricedReason: null,
    })
    expect(byId['unpriced']).toMatchObject({
      costMicroUsd: null,
      costConfidence: 'estimated',
      costDetails: null,
      costUnpricedReason: 'Unknown model "x"; no pricing entry found.',
    })
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

  it('adds error_reason as a nullable text column and keeps existing rows', async () => {
    const upgraded = new PGlite()
    await upgraded.exec(PUBLISHED_0_7_2_SQL)
    await upgraded.exec(OLD_ROW_SQL)
    await upgraded.exec(sqlFile('upgrades/0001-add-error-reason.sql'))

    const column = (await describeTable(upgraded)).find(
      (c) => c.column_name === 'error_reason',
    )
    expect(column).toMatchObject({ data_type: 'text', is_nullable: 'YES' })

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

  it('the sink writes and reads error_reason on the fully upgraded table', async () => {
    const pg = new PGlite()
    await pg.exec(PUBLISHED_0_7_2_SQL)
    await pg.exec(OLD_ROW_SQL)
    await pg.exec(sqlFile('upgrades/0001-add-error-reason.sql'))
    await pg.exec(sqlFile('upgrades/0002-ledger-v2.sql'))

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

/** The previously published shape: 0.7.2 plus upgrade 0001. */
const AFTER_0001_SQL = `${PUBLISHED_0_7_2_SQL}\n${sqlFile('upgrades/0001-add-error-reason.sql')}`

describe('upgrades/0002-ledger-v2.sql (from the 0.7.2 shape plus 0001)', () => {
  it('the previous shape has none of the v2 columns, indexes or checks', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0001_SQL)
    const names = (await describeTable(pg)).map((c) => c.column_name)
    expect(names).toContain('error_reason')
    for (const added of ['cost_confidence', 'cost_details', 'cost_unpriced_reason']) {
      expect(names).not.toContain(added)
    }
    expect(await checkConstraints(pg)).toEqual([])
    expect(await indexNames(pg)).not.toContain('llm_calls_created_at_idx')
  })

  it('yields the same table, indexes and checks as a fresh install, and keeps existing rows', async () => {
    const upgraded = new PGlite()
    await upgraded.exec(AFTER_0001_SQL)
    await upgraded.exec(OLD_ROW_SQL)
    await upgraded.exec(sqlFile('upgrades/0002-ledger-v2.sql'))

    const fresh = new PGlite()
    await fresh.exec(sqlFile('install.sql'))

    expect(await describeTable(upgraded)).toEqual(await describeTable(fresh))
    expect(await indexNames(upgraded)).toEqual(await indexNames(fresh))
    expect(await checkConstraints(upgraded)).toEqual(await checkConstraints(fresh))

    const old = await upgraded.query(
      `SELECT attempt_id, record_schema_version, cost_confidence, cost_details,
              cost_unpriced_reason, error_kind FROM llm_calls`,
    )
    expect(old.rows).toEqual([
      {
        attempt_id: 'old_attempt',
        record_schema_version: 1,
        cost_confidence: null,
        cost_details: null,
        cost_unpriced_reason: null,
        error_kind: 'server',
      },
    ])
  })

  it('is idempotent: a second run changes neither the table, the indexes, the checks nor the rows', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0001_SQL)
    await pg.exec(OLD_ROW_SQL)
    await pg.exec(sqlFile('upgrades/0002-ledger-v2.sql'))
    const table = await describeTable(pg)
    const indexes = await indexNames(pg)
    const checks = await checkConstraints(pg)
    const rows = await pg.query(`SELECT * FROM llm_calls`)

    await pg.exec(sqlFile('upgrades/0002-ledger-v2.sql'))

    expect(await describeTable(pg)).toEqual(table)
    expect(await indexNames(pg)).toEqual(indexes)
    expect(await checkConstraints(pg)).toEqual(checks)
    expect((await pg.query(`SELECT * FROM llm_calls`)).rows).toEqual(rows.rows)
  })

  it('works whether or not an index was created beforehand (a host may build it concurrently)', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0001_SQL)
    await pg.exec(`CREATE INDEX llm_calls_created_at_idx ON llm_calls (created_at)`)
    await pg.exec(sqlFile('upgrades/0002-ledger-v2.sql'))
    expect(await indexNames(pg)).toContain('llm_calls_call_site_created_at_idx')
  })

  it('fails loudly, leaving the table alone, when an existing row violates a CHECK', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0001_SQL)
    await pg.exec(OLD_ROW_SQL.replace("'api_error'", "'weird'"))
    await expect(pg.exec(sqlFile('upgrades/0002-ledger-v2.sql'))).rejects.toThrow()
  })

  it('the sink writes the v2 columns, reads old rows back, and assertLlmCallsSchema passes', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0001_SQL)
    await pg.exec(OLD_ROW_SQL)
    await pg.exec(sqlFile('upgrades/0002-ledger-v2.sql'))
    const db = drizzle({ client: pg })
    await expect(assertLlmCallsSchema(db)).resolves.toBeUndefined()

    const sink = drizzleUsageSink(db as unknown as InsertableDb)
    await sink.record(
      makeRecord({ costMicroUsd: 7, costConfidence: 'exact', costDetails: costLanes }),
    )
    const rows = await db.select().from(llmCalls)
    const byId = Object.fromEntries(rows.map((r) => [r.attemptId, r.costConfidence]))
    expect(byId).toEqual({ old_attempt: null, new_attempt: 'exact' })
  })

  it('without the upgrade, the 0001 shape fails the schema check and every insert', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0001_SQL)
    const db = drizzle({ client: pg })
    await expect(assertLlmCallsSchema(db)).rejects.toThrow(/sql\/upgrades/)
    const sink = drizzleUsageSink(db as unknown as InsertableDb)
    await expect(sink.record(makeRecord())).rejects.toThrow()
  })
})

const costLanes = { input: 3, cached: 0, output: 4, tools: 0 }

describe('a table that was not migrated is detectable, and the engine logs every dropped row loudly', () => {
  const OK = {
    message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
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
    await upgraded.exec(sqlFile('upgrades/0002-ledger-v2.sql'))
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
      error: (ctx, event) =>
        void events.push({ level: 'error', event, ctx: ctx as Record<string, unknown> }),
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
