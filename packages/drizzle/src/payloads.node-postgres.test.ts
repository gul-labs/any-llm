/**
 * Payload storage against node-postgres and a real server.
 *
 * CI has no Postgres service, so this suite runs only when
 * `ANY_LLM_TEST_POSTGRES_URL` points at a server (a superuser, or a role that may
 * create databases); it is skipped otherwise, and `payloads.integration.test.ts`
 * covers the same behaviour on PGlite. Each run creates its own database and
 * drops it afterwards. Locally:
 *
 *   initdb -D /tmp/pg -A trust -U postgres && pg_ctl -D /tmp/pg -o "-p 54329" start
 *   ANY_LLM_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54329/postgres pnpm vitest run payloads.node-postgres
 *
 * It exists because node-postgres checks a client out of a pool per transaction:
 * the sink must keep every statement (ledger insert, savepoint, payload insert)
 * on that one client, and a payload failure must roll back to the savepoint and
 * not poison the connection for the next call.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LlmCallRecord } from '@gullabs/core'
import {
  deleteLlmCallPayloads,
  drizzleUsageSink,
  purgeLlmCallPayloads,
  type PostgresDb,
} from './index.js'

const URL_ENV = process.env['ANY_LLM_TEST_POSTGRES_URL']
const INSTALL_SQL = readFileSync(
  fileURLToPath(new URL('../sql/install.sql', import.meta.url)),
  'utf8',
)

function makeRecord(overrides: Partial<LlmCallRecord> = {}): LlmCallRecord {
  return {
    recordSchemaVersion: 2,
    callId: 'call_1',
    attemptId: 'attempt_1',
    attemptNumber: 1,
    provider: 'p',
    model: 'm',
    status: 'ok',
    latencyMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    tokenDetails: {},
    rawUsage: null,
    generationConfig: {},
    metadata: {},
    createdAt: '2026-10-03T00:00:00.000Z',
    ...overrides,
  }
}

const PAYLOAD = {
  request: { messages: [{ role: 'user' as const, parts: [] }] },
  response: { text: 'hi' },
}

describe.skipIf(URL_ENV === undefined)('payload storage on node-postgres', () => {
  const dbName = `any_llm_test_${Math.random().toString(36).slice(2, 10)}`
  let admin: pg.Client
  let pool: pg.Pool
  let db: PostgresDb

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: URL_ENV })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${dbName}`)
    const url = new URL(URL_ENV as string)
    url.pathname = `/${dbName}`
    // Two connections: a transaction holds one, so a statement that escaped it
    // would run on the other and show up as a missing row or a deadlock.
    pool = new pg.Pool({ connectionString: url.toString(), max: 2 })
    await pool.query(INSTALL_SQL)
    db = drizzle(pool) as unknown as PostgresDb
  })

  afterAll(async () => {
    await pool?.end()
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName}`)
    await admin?.end()
  })

  async function reset(): Promise<void> {
    await pool.query(`TRUNCATE llm_calls CASCADE`)
  }

  async function counts(): Promise<{ calls: number; payloads: number }> {
    const calls = await pool.query(`SELECT count(*)::int AS n FROM llm_calls`)
    const payloads = await pool.query(`SELECT count(*)::int AS n FROM llm_call_payloads`)
    return {
      calls: (calls.rows[0] as { n: number }).n,
      payloads: (payloads.rows[0] as { n: number }).n,
    }
  }

  it('writes the ledger row and the payload row', async () => {
    await reset()
    await drizzleUsageSink({ db }).record(makeRecord(), { payload: PAYLOAD })
    expect(await counts()).toEqual({ calls: 1, payloads: 1 })
  })

  it('a payload insert Postgres rejects rolls back to the savepoint: the ledger row commits and the pooled connection stays usable', async () => {
    await reset()
    await pool.query(
      `ALTER TABLE llm_call_payloads ADD CONSTRAINT never CHECK (attempt_id = 'never')`,
    )
    try {
      const errors: string[] = []
      const sink = drizzleUsageSink({ db })
      const logger = {
        debug() {},
        info() {},
        warn() {},
        error: (_fields: unknown, message: string) => void errors.push(message),
      }
      await sink.record(makeRecord(), { payload: PAYLOAD, logger })
      await sink.record(makeRecord({ callId: 'c2', attemptId: 'a2' }), {
        payload: PAYLOAD,
        logger,
      })
      expect(await counts()).toEqual({ calls: 2, payloads: 0 })
      expect(errors).toEqual(['llm.call.payload.failed', 'llm.call.payload.failed'])
    } finally {
      await pool.query(`ALTER TABLE llm_call_payloads DROP CONSTRAINT never`)
    }
  })

  it('a failing ledger insert leaves neither row', async () => {
    await reset()
    await expect(
      drizzleUsageSink({ db }).record(
        makeRecord({ status: 'weird' as unknown as 'ok' }),
        {
          payload: PAYLOAD,
        },
      ),
    ).rejects.toThrow()
    expect(await counts()).toEqual({ calls: 0, payloads: 0 })
  })

  it('a host transaction helper is used, and a failure after the callback rolls both rows back', async () => {
    await reset()
    let opened = 0
    await drizzleUsageSink({
      db,
      transaction: (fn) => {
        opened += 1
        return db.transaction(fn)
      },
    }).record(makeRecord(), { payload: PAYLOAD })
    expect(opened).toBe(1)
    expect(await counts()).toEqual({ calls: 1, payloads: 1 })

    await expect(
      drizzleUsageSink({
        db,
        transaction: (fn) =>
          db.transaction(async (tx) => {
            await fn(tx as unknown as PostgresDb)
            throw new Error('commit failed')
          }),
      }).record(makeRecord({ callId: 'c2', attemptId: 'a2' }), { payload: PAYLOAD }),
    ).rejects.toThrow('commit failed')
    expect(await counts()).toEqual({ calls: 1, payloads: 1 })
  })

  it('purges by age and deletes by callIds without touching another call', async () => {
    await reset()
    const sink = drizzleUsageSink({ db })
    await sink.record(
      makeRecord({
        callId: 'c1',
        attemptId: 'a1',
        createdAt: '2026-10-01T00:00:00.000Z',
      }),
      { payload: PAYLOAD },
    )
    await sink.record(
      makeRecord({
        callId: 'c2',
        attemptId: 'a2',
        externalId: 'same',
        createdAt: '2026-10-02T00:00:00.000Z',
      }),
      { payload: PAYLOAD },
    )
    await sink.record(
      makeRecord({
        callId: 'c3',
        attemptId: 'a3',
        externalId: 'same',
        createdAt: '2026-10-03T00:00:00.000Z',
      }),
      { payload: PAYLOAD },
    )
    expect(
      await purgeLlmCallPayloads(db, { olderThan: new Date('2026-10-02T00:00:00Z') }),
    ).toBe(1)
    expect(await deleteLlmCallPayloads(db, { callIds: ['c2'] })).toBe(1)
    const left = await pool.query(`SELECT attempt_id FROM llm_call_payloads`)
    expect(left.rows).toEqual([{ attempt_id: 'a3' }])
    expect((await counts()).calls).toBe(3)
  })

  it('a host helper that reuses one transaction handle: three concurrent writes keep their good payloads, and a rollback takes the ledger rows too', async () => {
    await reset()
    await pool.query(
      `ALTER TABLE llm_call_payloads ADD CONSTRAINT not_bad CHECK (attempt_id <> 'bad')`,
    )
    try {
      const errors: string[] = []
      const logger = {
        debug() {},
        info() {},
        warn() {},
        error: (_fields: unknown, message: string) => void errors.push(message),
      }
      await db.transaction(async (ambient) => {
        const sink = drizzleUsageSink({
          db,
          transaction: (fn) => fn(ambient as unknown as PostgresDb),
        })
        await Promise.all(
          ['a', 'bad', 'c'].map((id) =>
            sink.record(makeRecord({ callId: `c_${id}`, attemptId: id }), {
              payload: PAYLOAD,
              logger,
            }),
          ),
        )
      })
      expect(await counts()).toEqual({ calls: 3, payloads: 2 })
      expect(errors).toEqual(['llm.call.payload.failed'])

      await reset()
      await expect(
        db.transaction(async (ambient) => {
          await drizzleUsageSink({
            db,
            transaction: (fn) => fn(ambient as unknown as PostgresDb),
          }).record(makeRecord(), { payload: PAYLOAD })
          throw new Error('host rolled back')
        }),
      ).rejects.toThrow('host rolled back')
      expect(await counts()).toEqual({ calls: 0, payloads: 0 })
    } finally {
      await pool.query(`ALTER TABLE llm_call_payloads DROP CONSTRAINT not_bad`)
    }
  })

  it('a ledger-only record is a single INSERT with no transaction', async () => {
    await reset()
    const queries: string[] = []
    const logged = drizzle(pool, {
      logger: { logQuery: (query) => void queries.push(query) },
    }) as unknown as PostgresDb
    await drizzleUsageSink({ db: logged }).record(makeRecord())
    expect(queries).toHaveLength(1)
    expect(queries[0]).toMatch(/^insert into "llm_calls"/i)
    expect(await counts()).toEqual({ calls: 1, payloads: 0 })
  })

  it('purges a backlog in bounded batches and returns the count', async () => {
    await reset()
    await pool.query(`
      INSERT INTO llm_calls (record_schema_version, call_id, attempt_id, provider, model,
        status, token_details, generation_config, attempt_number, metadata)
      SELECT 2, 'c' || g, 'a' || g, 'p', 'm', 'ok', '{}', '{}', 1, '{}'
        FROM generate_series(1, 12000) g;
      INSERT INTO llm_call_payloads (attempt_id, request, response, created_at)
      SELECT 'a' || g, '{}', '{}', timestamptz '2026-01-01'
        FROM generate_series(1, 12000) g;`)
    const queries: string[] = []
    const logged = drizzle(pool, {
      logger: { logQuery: (query) => void queries.push(query) },
    }) as unknown as PostgresDb
    expect(
      await purgeLlmCallPayloads(logged, {
        olderThan: new Date('2026-06-01T00:00:00Z'),
        batchSize: 5000,
      }),
    ).toBe(12_000)
    expect(queries.filter((q) => /delete from/i.test(q))).toHaveLength(3)
    expect(await counts()).toEqual({ calls: 12_000, payloads: 0 })
  })
})
