/**
 * Migration tests for the shipped SQL in `packages/drizzle/sql/`.
 *
 * - `install.sql` (fresh install) must produce exactly the table `schema.ts`
 *   describes: same columns, SQL types, nullability, defaults and indexes.
 * - `upgrades/0001-add-error-reason.sql` takes the table shape published in
 *   `@gullabs/drizzle` 0.7.2 forward, keeps existing rows, and is safe to run
 *   twice.
 * - `upgrades/0002-ledger-v2.sql` takes the previously published shape (0.7.2 plus
 *   upgrade 0001, which already has `error_reason`) to the same column, index and
 *   CHECK definitions as a fresh install (the CHECKs NOT VALID until
 *   `upgrades/0002-validate-checks.sql` runs), keeps existing rows, and is safe to
 *   run twice, statement by statement and not only as one transaction.
 * - `upgrades/0003-llm-call-payloads.sql` takes the previous shape (0.7.2 plus 0001 and
 *   0002) to the same tables, columns, index and foreign key as a fresh install,
 *   leaves `llm_calls` and its rows alone, is idempotent statement by statement,
 *   and refuses to run over a table of the same name that is not ours.
 * - Definitions (types, defaults, index and CHECK expressions as Postgres
 *   reports them) are compared, never just names: `schema.ts` against
 *   `install.sql`, and the upgraded table against a fresh install.
 * - The declared `drizzle-orm` peer floor (0.36) is declared, not tested: only the
 *   dev dependency version is installed.
 * - `status` and `error_kind` carry CHECK constraints; `error_reason` carries
 *   none, so a reason added to the core union later needs no SQL.
 *
 * Runs on PGlite (in-memory WASM Postgres): offline, no Docker.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { getTableColumns } from 'drizzle-orm'
import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core'
import { drizzle } from 'drizzle-orm/pglite'
import { describe, expect, it } from 'vitest'
import { assertLlmCallsSchema, drizzleUsageSink } from './sink.js'
import { llmCallPayloads, llmCalls } from './schema.js'
import { assertLlmCallPayloadsSchema } from './payloads.js'
import { LlmError, createClient, createModelRegistry } from '@gullabs/core'
import type { AdapterResult, LlmCallRecord, Logger } from '@gullabs/core'
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
  udt_name: string
  datetime_precision: number | null
  is_nullable: string
  column_default: string | null
}

async function describeTable(pg: PGlite, table = 'llm_calls'): Promise<ColumnInfo[]> {
  const res = await pg.query<ColumnInfo>(
    `SELECT column_name, data_type, udt_name, datetime_precision, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_name = $1
      ORDER BY column_name`,
    [table],
  )
  return res.rows
}

interface ConstraintInfo {
  conname: string
  def: string
  convalidated: boolean
}

async function checkConstraints(pg: PGlite): Promise<ConstraintInfo[]> {
  const res = await pg.query<ConstraintInfo>(
    `SELECT conname, pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
      WHERE conrelid = 'llm_calls'::regclass AND contype = 'c' ORDER BY conname`,
  )
  return res.rows
}

async function indexNames(pg: PGlite, table = 'llm_calls'): Promise<string[]> {
  const res = await pg.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`,
    [table],
  )
  return res.rows.map((r) => r.indexname)
}

/** `CREATE INDEX ...` text exactly as Postgres reports it, by index name. */
async function indexDefs(
  pg: PGlite,
  table = 'llm_calls',
): Promise<Array<{ indexname: string; indexdef: string }>> {
  const res = await pg.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`,
    [table],
  )
  return res.rows
}

/** Whether every index on `llm_calls` is valid and ready (no failed concurrent build). */
async function invalidIndexes(pg: PGlite): Promise<string[]> {
  const res = await pg.query<{ name: string }>(
    `SELECT indexrelid::regclass::text AS name FROM pg_index
      WHERE indrelid = 'llm_calls'::regclass AND NOT (indisvalid AND indisready)`,
  )
  return res.rows.map((r) => r.name)
}

/**
 * Splits a SQL file into its statements the way `psql -f` (without `-1`) runs them:
 * comment lines are dropped, a statement ends at a `;` outside a dollar-quoted
 * body.
 */
function splitStatements(source: string): string[] {
  const statements: string[] = []
  let current: string[] = []
  let inDollar = false
  for (const line of source.split('\n')) {
    if (!inDollar && line.trimStart().startsWith('--')) continue
    if (current.length === 0 && line.trim() === '') continue
    current.push(line)
    if ((line.match(/\$\$/g) ?? []).length % 2 === 1) inDollar = !inDollar
    if (!inDollar && line.trimEnd().endsWith(';')) {
      statements.push(current.join('\n'))
      current = []
    }
  }
  if (current.length > 0) statements.push(current.join('\n'))
  return statements
}

/**
 * Runs a file one statement at a time, each in its own implicit transaction
 * (PGlite wraps a multi-statement `exec` in a single transaction, which would
 * hide a statement that left the table half migrated). Returns the errors.
 */
async function runStatementwise(pg: PGlite, source: string): Promise<string[]> {
  const errors: string[] = []
  for (const statement of splitStatements(source)) {
    try {
      await pg.exec(statement)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  return errors
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

  it('declares in schema.ts the same index and CHECK definitions install.sql creates', async () => {
    const pg = new PGlite()
    await pg.exec(sqlFile('install.sql'))
    const config = getTableConfig(llmCalls)

    // Indexes: rebuild each declared index from its columns and compare Postgres's
    // own rendering, so a wrong column list or order fails (names alone would not).
    const declaredIndexes = config.indexes
      .map((i) => ({
        indexname: i.config.name ?? '',
        indexdef: `CREATE ${i.config.unique ? 'UNIQUE ' : ''}INDEX ${i.config.name ?? ''} ON public.llm_calls USING btree (${i.config.columns
          .map((c) => (c as { name: string }).name)
          .join(', ')})`,
      }))
      .sort((x, y) => x.indexname.localeCompare(y.indexname))
    expect((await indexDefs(pg)).filter((i) => i.indexname !== 'llm_calls_pkey')).toEqual(
      declaredIndexes,
    )

    // CHECKs: render each declared expression, create it on a scratch table with
    // the same two columns and compare `pg_get_constraintdef` with install.sql's.
    const dialect = new PgDialect()
    const scratch = new PGlite()
    await scratch.exec(`CREATE TABLE llm_calls (status TEXT NOT NULL, error_kind TEXT)`)
    for (const check of config.checks) {
      const rendered = dialect.sqlToQuery(check.value)
      expect(rendered.params).toEqual([])
      const expression = rendered.sql.replaceAll('"llm_calls".', '')
      await scratch.exec(
        `ALTER TABLE llm_calls ADD CONSTRAINT ${check.name} CHECK (${expression})`,
      )
    }
    const installed = (await checkConstraints(pg)).map(({ conname, def }) => ({
      conname,
      def,
    }))
    const declared = (await checkConstraints(scratch)).map(({ conname, def }) => ({
      conname,
      def,
    }))
    expect(declared).toEqual(installed)
    expect(declared).toHaveLength(2)
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
    const sink = drizzleUsageSink({ db })
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
    const sink = drizzleUsageSink({ db: drizzle({ client: pg }) })
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
    const sink = drizzleUsageSink({ db })
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
    const sink = drizzleUsageSink({ db })
    await sink.record(makeRecord({ errorReason: 'quota_window' }))

    const rows = await db.select().from(llmCalls)
    const byId = Object.fromEntries(rows.map((r) => [r.attemptId, r.errorReason]))
    expect(byId).toEqual({ old_attempt: null, new_attempt: 'quota_window' })
  })

  it('without the upgrade sink.record itself rejects on the old shape (the engine, not the sink, swallows it)', async () => {
    const pg = new PGlite()
    await pg.exec(PUBLISHED_0_7_2_SQL)
    const db = drizzle({ client: pg })
    const sink = drizzleUsageSink({ db })
    await expect(sink.record(makeRecord())).rejects.toThrow()
  })
})

/** The previously published shape: 0.7.2 plus upgrade 0001. */
const AFTER_0001_SQL = `${PUBLISHED_0_7_2_SQL}\n${sqlFile('upgrades/0001-add-error-reason.sql')}`

const UPGRADE_0002 = 'upgrades/0002-ledger-v2.sql'
const VALIDATE_0002 = 'upgrades/0002-validate-checks.sql'

/** Strips the NOT VALID suffix Postgres appends to an unvalidated CHECK's definition. */
function withoutNotValid(def: string): string {
  return def.replace(/ NOT VALID$/, '')
}

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

  it('yields the same column, index and CHECK definitions as a fresh install, and keeps existing rows', async () => {
    const upgraded = new PGlite()
    await upgraded.exec(AFTER_0001_SQL)
    await upgraded.exec(OLD_ROW_SQL)
    await upgraded.exec(sqlFile(UPGRADE_0002))

    const fresh = new PGlite()
    await fresh.exec(sqlFile('install.sql'))

    // Columns: type, precision, nullability and default, not just names.
    expect(await describeTable(upgraded)).toEqual(await describeTable(fresh))
    // Indexes: the CREATE INDEX text Postgres reports.
    expect(await indexDefs(upgraded)).toEqual(await indexDefs(fresh))
    expect(await invalidIndexes(upgraded)).toEqual([])

    // CHECKs: same expressions; the upgrade leaves them NOT VALID until validated.
    const freshChecks = await checkConstraints(fresh)
    const upgradedChecks = await checkConstraints(upgraded)
    expect(upgradedChecks.map((c) => c.conname)).toEqual(
      freshChecks.map((c) => c.conname),
    )
    expect(upgradedChecks.map((c) => withoutNotValid(c.def))).toEqual(
      freshChecks.map((c) => c.def),
    )
    expect(
      upgradedChecks.every((c) => !c.convalidated && c.def.endsWith(' NOT VALID')),
    ).toBe(true)
    expect(freshChecks.every((c) => c.convalidated)).toBe(true)

    await upgraded.exec(sqlFile(VALIDATE_0002))
    expect(await checkConstraints(upgraded)).toEqual(freshChecks)

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

  it('sets lock_timeout before it touches the table, so a blocked statement fails instead of stalling sink writes', () => {
    const statements = splitStatements(sqlFile(UPGRADE_0002))
    expect(statements[0]).toMatch(/^SET lock_timeout = '\d+s?';$/)
    expect(statements[statements.length - 1]).toBe('RESET lock_timeout;')
    expect(splitStatements(sqlFile(VALIDATE_0002))[0]).toMatch(/^SET lock_timeout/)
  })

  it('runs each statement on its own twice with the same result (idempotent per statement, not as one transaction)', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0001_SQL)
    await pg.exec(OLD_ROW_SQL)

    expect(await runStatementwise(pg, sqlFile(UPGRADE_0002))).toEqual([])
    const table = await describeTable(pg)
    const indexes = await indexDefs(pg)
    const checks = await checkConstraints(pg)
    const rows = await pg.query(`SELECT * FROM llm_calls`)

    expect(await runStatementwise(pg, sqlFile(UPGRADE_0002))).toEqual([])

    expect(await describeTable(pg)).toEqual(table)
    expect(await indexDefs(pg)).toEqual(indexes)
    // The CHECKs are neither dropped nor re-added: same definitions, same state.
    expect(await checkConstraints(pg)).toEqual(checks)
    expect((await pg.query(`SELECT * FROM llm_calls`)).rows).toEqual(rows.rows)
  })

  it('does not drop or re-add an existing CHECK on a re-run (the constraint keeps its oid)', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0001_SQL)
    await runStatementwise(pg, sqlFile(UPGRADE_0002))
    const oids = async () =>
      (
        await pg.query<{ conname: string; oid: number }>(
          `SELECT conname, oid FROM pg_constraint
            WHERE conrelid = 'llm_calls'::regclass AND contype = 'c' ORDER BY conname`,
        )
      ).rows
    const before = await oids()
    expect(before).toHaveLength(2)
    await runStatementwise(pg, sqlFile(UPGRADE_0002))
    expect(await oids()).toEqual(before)
    // Validation then leaves the same constraints in place, only validated.
    await runStatementwise(pg, sqlFile(VALIDATE_0002))
    expect(await oids()).toEqual(before)
  })

  it('works whether or not an index was created beforehand (a host may build it concurrently)', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0001_SQL)
    await pg.exec(`CREATE INDEX llm_calls_created_at_idx ON llm_calls (created_at)`)
    await pg.exec(sqlFile(UPGRADE_0002))
    expect(await indexNames(pg)).toContain('llm_calls_call_site_created_at_idx')
    expect(await indexNames(pg)).toContain('llm_calls_created_at_idx')
  })

  describe('with legacy rows that violate the new vocabularies (core 0.2.0 wrote parse_error)', () => {
    const LEGACY_SQL = /* sql */ `
      INSERT INTO llm_calls (
        record_schema_version, call_id, attempt_id, provider, model, status,
        token_details, generation_config, attempt_number, metadata, error_kind
      ) VALUES
        (1, 'legacy_1', 'legacy_attempt_1', 'google', 'm', 'parse_error', '{}', '{}', 1, '{}', 'parse_error'),
        (1, 'legacy_2', 'legacy_attempt_2', 'google', 'm', 'api_error', '{}', '{}', 1, '{"keep":1}', 'parse_error');
    `

    async function legacyTable(): Promise<PGlite> {
      const pg = new PGlite()
      await pg.exec(AFTER_0001_SQL)
      await pg.exec(OLD_ROW_SQL)
      await pg.exec(LEGACY_SQL)
      return pg
    }

    it('the upgrade itself succeeds, statement by statement and twice, and finishes the whole file', async () => {
      const pg = await legacyTable()
      expect(await runStatementwise(pg, sqlFile(UPGRADE_0002))).toEqual([])
      const table = await describeTable(pg)
      const indexes = await indexDefs(pg)
      const checks = await checkConstraints(pg)
      expect((await describeTable(pg)).map((c) => c.column_name)).toContain(
        'cost_details',
      )
      expect(checks.map((c) => c.conname)).toEqual([
        'llm_calls_error_kind_check',
        'llm_calls_status_check',
      ])
      expect(checks.every((c) => !c.convalidated)).toBe(true)

      expect(await runStatementwise(pg, sqlFile(UPGRADE_0002))).toEqual([])
      expect(await describeTable(pg)).toEqual(table)
      expect(await indexDefs(pg)).toEqual(indexes)
      expect(await checkConstraints(pg)).toEqual(checks)
      // History is untouched: the legacy values are still there.
      const legacy = await pg.query<{ status: string; error_kind: string }>(
        `SELECT status, error_kind FROM llm_calls WHERE attempt_id LIKE 'legacy%' ORDER BY attempt_id`,
      )
      expect(legacy.rows).toEqual([
        { status: 'parse_error', error_kind: 'parse_error' },
        { status: 'api_error', error_kind: 'parse_error' },
      ])
    })

    it('new rows are enforced at once even though the legacy rows are not validated', async () => {
      const pg = await legacyTable()
      await runStatementwise(pg, sqlFile(UPGRADE_0002))
      const sink = drizzleUsageSink({ db: drizzle({ client: pg }) })
      await expect(
        sink.record(makeRecord({ status: 'weird' as unknown as 'ok' })),
      ).rejects.toThrow()
      await expect(
        sink.record(
          makeRecord({
            attemptId: 'bad_kind',
            errorKind: 'parse_error' as unknown as 'server',
          }),
        ),
      ).rejects.toThrow()
      await sink.record(makeRecord({ attemptId: 'fine', errorKind: 'server' }))
      // Updating a legacy row to a bad value is rejected too; to a good one is fine.
      await expect(
        pg.exec(`UPDATE llm_calls SET model = 'x' WHERE attempt_id = 'legacy_attempt_1'`),
      ).rejects.toThrow()
    })

    it('validation fails, changing nothing, until the legacy rows are fixed with the documented query', async () => {
      const pg = await legacyTable()
      await runStatementwise(pg, sqlFile(UPGRADE_0002))

      const errors = await runStatementwise(pg, sqlFile(VALIDATE_0002))
      expect(errors.length).toBeGreaterThan(0)
      expect(errors.join('\n')).toMatch(/violated by some row|check constraint/)
      expect((await checkConstraints(pg)).every((c) => !c.convalidated)).toBe(true)

      // The query the validate file documents finds exactly the legacy rows ...
      const doc = sqlFile(VALIDATE_0002)
      const find = documentedStatement(doc, 'SELECT status, error_kind, count(*)')
      const found = await pg.query<{ status: string; error_kind: string; rows: string }>(
        find,
      )
      expect(found.rows.map((r) => [r.status, r.error_kind, Number(r.rows)])).toEqual([
        ['api_error', 'parse_error', 1],
        ['parse_error', 'parse_error', 1],
      ])

      // ... and the documented fix, run by the host, makes validation succeed
      // while keeping the original values in metadata.
      await pg.exec(documentedStatement(doc, 'UPDATE llm_calls'))
      expect(await runStatementwise(pg, sqlFile(VALIDATE_0002))).toEqual([])
      expect((await checkConstraints(pg)).every((c) => c.convalidated)).toBe(true)
      const fixed = await pg.query<{
        status: string
        error_kind: string
        metadata: unknown
      }>(
        `SELECT status, error_kind, metadata FROM llm_calls
          WHERE attempt_id LIKE 'legacy%' ORDER BY attempt_id`,
      )
      expect(fixed.rows).toEqual([
        {
          status: 'api_error',
          error_kind: 'bad_request',
          metadata: { legacy_status: 'parse_error', legacy_error_kind: 'parse_error' },
        },
        {
          status: 'api_error',
          error_kind: 'bad_request',
          metadata: {
            keep: 1,
            legacy_status: 'api_error',
            legacy_error_kind: 'parse_error',
          },
        },
      ])
      // Validating twice is a no-op.
      expect(await runStatementwise(pg, sqlFile(VALIDATE_0002))).toEqual([])

      // The result equals a fresh install's definitions.
      const fresh = new PGlite()
      await fresh.exec(sqlFile('install.sql'))
      expect(await checkConstraints(pg)).toEqual(await checkConstraints(fresh))
    })
  })

  it('the sink writes the v2 columns, reads old rows back, and assertLlmCallsSchema passes', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0001_SQL)
    await pg.exec(OLD_ROW_SQL)
    await pg.exec(sqlFile(UPGRADE_0002))
    const db = drizzle({ client: pg })
    await expect(assertLlmCallsSchema(db)).resolves.toBeUndefined()

    const sink = drizzleUsageSink({ db })
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
    const sink = drizzleUsageSink({ db })
    await expect(sink.record(makeRecord())).rejects.toThrow()
  })
})

/**
 * The SQL statement a SQL file documents in its comments (a `--   ` indented
 * block that starts with `startsWith` and ends at the `;`), de-commented.
 */
function documentedStatement(source: string, startsWith: string): string {
  const lines = source.split('\n').map((l) => l.replace(/^--\s?/, ''))
  const start = lines.findIndex((l) => l.trimStart().startsWith(startsWith))
  expect(start, `documented statement "${startsWith}"`).toBeGreaterThanOrEqual(0)
  const out: string[] = []
  for (let i = start; i < lines.length; i += 1) {
    out.push(lines[i] ?? '')
    if ((lines[i] ?? '').trimEnd().endsWith(';')) break
  }
  return out.join('\n')
}

const costLanes = { input: 3, cached: 0, output: 4, tools: 0 }

describe('a table that was not migrated is detectable, and the engine logs every dropped row loudly', () => {
  const OK: AdapterResult = {
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
      sink: drizzleUsageSink({ db: drizzle({ client: pg }) }),
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

// ---------------------------------------------------------------------------
// llm_call_payloads: fresh install and upgrade 0003
// ---------------------------------------------------------------------------

const PAYLOADS = 'llm_call_payloads'
const UPGRADE_0003 = 'upgrades/0003-llm-call-payloads.sql'

/** The previously published shape of the whole schema: 0.7.2 plus upgrades 0001 and 0002. */
const AFTER_0002_SQL = `${AFTER_0001_SQL}\n${sqlFile(UPGRADE_0002)}`

/** Every constraint on `table`, as Postgres reports it (primary key, foreign key, check). */
async function constraintDefs(
  pg: PGlite,
  table: string,
): Promise<
  Array<{ conname: string; contype: string; def: string; convalidated: boolean }>
> {
  const res = await pg.query<{
    conname: string
    contype: string
    def: string
    convalidated: boolean
  }>(
    `SELECT conname, contype, pg_get_constraintdef(oid) AS def, convalidated
       FROM pg_constraint WHERE conrelid = $1::regclass ORDER BY conname`,
    [table],
  )
  return res.rows
}

describe('install.sql: llm_call_payloads', () => {
  it('has exactly the columns, types, nullability and defaults schema.ts declares', async () => {
    const pg = new PGlite()
    await pg.exec(sqlFile('install.sql'))
    const columns = await describeTable(pg, PAYLOADS)
    const declared = getTableColumns(llmCallPayloads)

    expect(columns.map((c) => c.column_name).sort()).toEqual(
      Object.values(declared)
        .map((c) => c.name)
        .sort(),
    )
    for (const column of Object.values(declared)) {
      const actual = columns.find((c) => c.column_name === column.name)
      expect(actual?.data_type, `type of ${column.name}`).toBe(
        column.getSQLType().replace(/\s*\(\d+\)/, ''),
      )
      expect(actual?.is_nullable === 'NO', `not null of ${column.name}`).toBe(
        column.notNull,
      )
      expect(actual?.column_default !== null, `default of ${column.name}`).toBe(
        column.hasDefault,
      )
    }
    expect(columns.find((c) => c.column_name === 'created_at')?.column_default).toBe(
      'now()',
    )
  })

  it('declares in schema.ts the same primary key, foreign key and index install.sql creates', async () => {
    const pg = new PGlite()
    await pg.exec(sqlFile('install.sql'))
    const config = getTableConfig(llmCallPayloads)

    const index = config.indexes[0]
    expect(config.indexes).toHaveLength(1)
    expect(await indexDefs(pg, PAYLOADS)).toEqual([
      {
        indexname: index?.config.name,
        indexdef: `CREATE INDEX ${index?.config.name} ON public.${PAYLOADS} USING btree (${index?.config.columns
          .map((c) => (c as { name: string }).name)
          .join(', ')})`,
      },
      expect.objectContaining({ indexname: 'llm_call_payloads_pkey' }),
    ])

    const fk = config.foreignKeys[0]?.reference()
    expect(config.foreignKeys).toHaveLength(1)
    const declaredForeignKey = {
      conname: config.foreignKeys[0]?.getName(),
      def: `FOREIGN KEY (${fk?.columns.map((c) => c.name).join(', ')}) REFERENCES ${getTableConfig(fk!.foreignTable).name}(${fk?.foreignColumns
        .map((c) => c.name)
        .join(', ')}) ON DELETE ${config.foreignKeys[0]?.onDelete?.toUpperCase()}`,
    }
    const installed = (await constraintDefs(pg, PAYLOADS)).filter(
      (c) => c.contype === 'f',
    )
    expect(installed.map(({ conname, def }) => ({ conname, def }))).toEqual([
      declaredForeignKey,
    ])
    expect(declaredForeignKey.def).toBe(
      'FOREIGN KEY (attempt_id) REFERENCES llm_calls(attempt_id) ON DELETE CASCADE',
    )
  })

  it('a payload cannot exist without its ledger row, and deleting the ledger row deletes it', async () => {
    const pg = new PGlite()
    await pg.exec(sqlFile('install.sql'))
    await expect(
      pg.exec(
        `INSERT INTO llm_call_payloads (attempt_id, request, response) VALUES ('orphan', '{}', '{}')`,
      ),
    ).rejects.toThrow(/foreign key|violates/)

    const sink = drizzleUsageSink({ db: drizzle({ client: pg }) })
    await sink.record(makeRecord(), {
      payload: { request: { messages: [] }, response: { text: 'hi' } },
    })
    expect((await pg.query(`SELECT 1 FROM llm_call_payloads`)).rows).toHaveLength(1)
    await pg.exec(`DELETE FROM llm_calls WHERE attempt_id = 'new_attempt'`)
    expect((await pg.query(`SELECT 1 FROM llm_call_payloads`)).rows).toHaveLength(0)
  })
})

describe('upgrades/0003-llm-call-payloads.sql (from the 0.7.2 shape plus 0001 and 0002)', () => {
  it('the previous shape has no payload table', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0002_SQL)
    expect(await describeTable(pg, PAYLOADS)).toEqual([])
  })

  it('yields the same tables, columns, indexes and constraints as a fresh install, and keeps existing rows', async () => {
    const upgraded = new PGlite()
    await upgraded.exec(AFTER_0002_SQL)
    await upgraded.exec(OLD_ROW_SQL)
    const callsBefore = {
      table: await describeTable(upgraded),
      indexes: await indexDefs(upgraded),
      checks: await checkConstraints(upgraded),
    }
    await upgraded.exec(sqlFile(UPGRADE_0003))

    const fresh = new PGlite()
    await fresh.exec(sqlFile('install.sql'))

    // The new table: type, precision, nullability, default; index text; every constraint.
    expect(await describeTable(upgraded, PAYLOADS)).toEqual(
      await describeTable(fresh, PAYLOADS),
    )
    expect(await indexDefs(upgraded, PAYLOADS)).toEqual(await indexDefs(fresh, PAYLOADS))
    expect(await constraintDefs(upgraded, PAYLOADS)).toEqual(
      await constraintDefs(fresh, PAYLOADS),
    )
    expect(await invalidIndexes(upgraded)).toEqual([])

    // llm_calls is untouched: shape and rows.
    expect({
      table: await describeTable(upgraded),
      indexes: await indexDefs(upgraded),
      checks: await checkConstraints(upgraded),
    }).toEqual(callsBefore)
    const old = await upgraded.query<{ attempt_id: string }>(
      `SELECT attempt_id FROM llm_calls`,
    )
    expect(old.rows).toEqual([{ attempt_id: 'old_attempt' }])
    expect((await upgraded.query(`SELECT 1 FROM llm_call_payloads`)).rows).toEqual([])
  })

  it('sets lock_timeout before it touches a table and resets it after', () => {
    const statements = splitStatements(sqlFile(UPGRADE_0003))
    expect(statements[0]).toMatch(/^SET lock_timeout = '\d+s?';$/)
    expect(statements[statements.length - 1]).toBe('RESET lock_timeout;')
  })

  it('runs each statement on its own twice with the same result (idempotent per statement)', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0002_SQL)
    await pg.exec(OLD_ROW_SQL)

    expect(await runStatementwise(pg, sqlFile(UPGRADE_0003))).toEqual([])
    const table = await describeTable(pg, PAYLOADS)
    const indexes = await indexDefs(pg, PAYLOADS)
    const constraints = await constraintDefs(pg, PAYLOADS)
    const oids = async () =>
      (
        await pg.query(
          `SELECT oid FROM pg_constraint WHERE conrelid = 'llm_call_payloads'::regclass ORDER BY conname`,
        )
      ).rows

    const before = await oids()
    expect(await runStatementwise(pg, sqlFile(UPGRADE_0003))).toEqual([])
    expect(await describeTable(pg, PAYLOADS)).toEqual(table)
    expect(await indexDefs(pg, PAYLOADS)).toEqual(indexes)
    expect(await constraintDefs(pg, PAYLOADS)).toEqual(constraints)
    // Nothing was dropped and re-added.
    expect(await oids()).toEqual(before)
  })

  it('keeps the rows already in the payload table on a re-run', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0002_SQL)
    await runStatementwise(pg, sqlFile(UPGRADE_0003))
    await pg.exec(OLD_ROW_SQL)
    await pg.exec(
      `INSERT INTO llm_call_payloads (attempt_id, request, response) VALUES ('old_attempt', '{"messages":[]}', '{"text":"x"}')`,
    )
    expect(await runStatementwise(pg, sqlFile(UPGRADE_0003))).toEqual([])
    const rows = await pg.query<{ attempt_id: string }>(
      `SELECT attempt_id FROM llm_call_payloads`,
    )
    expect(rows.rows).toEqual([{ attempt_id: 'old_attempt' }])
  })

  it('works whether or not the index was created beforehand (a host may build it concurrently)', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0002_SQL)
    await pg.exec(
      `CREATE TABLE llm_call_payloads (
         attempt_id TEXT PRIMARY KEY, request JSONB NOT NULL, response JSONB NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
         CONSTRAINT llm_call_payloads_attempt_id_llm_calls_attempt_id_fk
           FOREIGN KEY (attempt_id) REFERENCES llm_calls (attempt_id) ON DELETE CASCADE)`,
    )
    expect(await runStatementwise(pg, sqlFile(UPGRADE_0003))).toEqual([])
    expect(await indexNames(pg, PAYLOADS)).toEqual([
      'llm_call_payloads_created_at_idx',
      'llm_call_payloads_pkey',
    ])
  })

  it('stops with an error, changing nothing, when a different table already has the name', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0002_SQL)
    await pg.exec(
      `CREATE TABLE llm_call_payloads (id BIGSERIAL PRIMARY KEY, call_id TEXT, body TEXT)`,
    )
    await pg.exec(`INSERT INTO llm_call_payloads (call_id, body) VALUES ('c', 'kept')`)
    const before = await describeTable(pg, PAYLOADS)

    const errors = await runStatementwise(pg, sqlFile(UPGRADE_0003))
    expect(errors.join('\n')).toMatch(/rename it first/)
    expect(await describeTable(pg, PAYLOADS)).toEqual(before)
    expect(
      (await pg.query<{ body: string }>(`SELECT body FROM llm_call_payloads`)).rows,
    ).toEqual([{ body: 'kept' }])

    // After the documented rename the upgrade goes through.
    await pg.exec(`ALTER TABLE llm_call_payloads RENAME TO app_llm_call_payloads`)
    expect(await runStatementwise(pg, sqlFile(UPGRADE_0003))).toEqual([])
    expect((await describeTable(pg, PAYLOADS)).map((c) => c.column_name).sort()).toEqual([
      'attempt_id',
      'created_at',
      'request',
      'response',
    ])
    expect(
      (await pg.query<{ body: string }>(`SELECT body FROM app_llm_call_payloads`)).rows,
    ).toEqual([{ body: 'kept' }])
  })

  it('the sink writes a payload on the upgraded table and assertLlmCallPayloadsSchema passes', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0002_SQL)
    await pg.exec(sqlFile(UPGRADE_0003))
    const db = drizzle({ client: pg })
    await expect(assertLlmCallPayloadsSchema(db)).resolves.toBeUndefined()
    await drizzleUsageSink({ db }).record(makeRecord(), {
      payload: { request: { messages: [] }, response: { text: 'hi' } },
    })
    const rows = await db.select().from(llmCallPayloads)
    expect(rows).toEqual([
      expect.objectContaining({
        attemptId: 'new_attempt',
        response: { text: 'hi' },
        createdAt: new Date('2026-10-03T00:00:00.000Z'),
      }),
    ])
  })

  it('without the upgrade the schema check rejects and points at 0003; the ledger row still commits', async () => {
    const pg = new PGlite()
    await pg.exec(AFTER_0002_SQL)
    const db = drizzle({ client: pg })
    await expect(assertLlmCallPayloadsSchema(db)).rejects.toThrow(
      /0003-llm-call-payloads\.sql/,
    )
    const errors: Array<[unknown, string]> = []
    await drizzleUsageSink({ db }).record(makeRecord(), {
      payload: { request: { messages: [] }, response: {} },
      logger: {
        debug() {},
        info() {},
        warn() {},
        error: (fields, message) => void errors.push([fields, message]),
      },
    })
    expect((await pg.query(`SELECT 1 FROM llm_calls`)).rows).toHaveLength(1)
    expect(errors.map(([, message]) => message)).toEqual(['llm.call.payload.failed'])
  })
})
