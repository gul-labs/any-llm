/**
 * The sink, the payload helpers and the schema check on every Drizzle Postgres
 * driver the package supports: PGlite (always runs), node-postgres and
 * postgres-js (run only when `ANY_LLM_TEST_POSTGRES_URL` points at a server; a
 * superuser or a role that may create databases). Each driver run creates its own
 * database and drops it afterwards. Locally:
 *
 *   initdb -D /tmp/pg -A trust -U postgres && pg_ctl -D /tmp/pg -o "-p 54417" start
 *   ANY_LLM_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:54417/postgres \
 *     pnpm vitest run drivers.integration
 *
 * Why every driver: drivers differ where it matters here. postgres-js fails a whole
 * transaction when a statement inside it failed, even if the failure was caught
 * (a hand-written `SAVEPOINT` does not save it; Drizzle's nested `transaction()`
 * does), and it does not serialise a raw `Date` bound into a `sql` template.
 * node-postgres checks a client out of a pool per transaction. PGlite is a single
 * connection. Everything below must hold on all three.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { drizzle as drizzlePostgresJs } from 'drizzle-orm/postgres-js'
import pg from 'pg'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  LlmError,
  createClient,
  createModelRegistry,
  type AdapterResult,
  type LlmCallRecord,
  type Logger,
} from '@gullabs/core'
import { FakeAdapter, FakeIds } from '@gullabs/testing'
import { makePermissiveTestDescriptor } from '../../core/src/test-model-descriptor.js'
import {
  assertLlmCallPayloadsSchema,
  assertLlmCallsSchema,
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

interface Harness {
  db: PostgresDb
  /** Runs SQL text (possibly several statements) outside the sink. */
  exec(text: string): Promise<void>
  rows(text: string): Promise<Array<Record<string, unknown>>>
  close(): Promise<void>
}

type Driver = {
  name: string
  skip: boolean
  open(): Promise<Harness>
}

function adminUrl(): { admin: string; dbName: string; url: (db: string) => string } {
  const dbName = `any_llm_test_${Math.random().toString(36).slice(2, 10)}`
  return {
    admin: URL_ENV as string,
    dbName,
    url(db: string) {
      const u = new URL(URL_ENV as string)
      u.pathname = `/${db}`
      return u.toString()
    },
  }
}

const DRIVERS: Driver[] = [
  {
    name: 'PGlite',
    skip: false,
    async open() {
      const client = new PGlite()
      return {
        db: drizzlePglite({ client }) as unknown as PostgresDb,
        exec: async (text) => void (await client.exec(text)),
        rows: async (text) => (await client.query<Record<string, unknown>>(text)).rows,
        close: () => client.close(),
      }
    },
  },
  {
    name: 'node-postgres',
    skip: URL_ENV === undefined,
    async open() {
      const { admin, dbName, url } = adminUrl()
      const adminClient = new pg.Client({ connectionString: admin })
      await adminClient.connect()
      await adminClient.query(`CREATE DATABASE ${dbName}`)
      // Two connections: a transaction holds one, so a statement that escaped it
      // would run on the other and show up as a missing row or a deadlock.
      const pool = new pg.Pool({ connectionString: url(dbName), max: 2 })
      return {
        db: drizzleNodePg(pool) as unknown as PostgresDb,
        exec: async (text) => void (await pool.query(text)),
        rows: async (text) =>
          (await pool.query(text)).rows as Array<Record<string, unknown>>,
        close: async () => {
          await pool.end()
          await adminClient.query(`DROP DATABASE IF EXISTS ${dbName}`)
          await adminClient.end()
        },
      }
    },
  },
  {
    name: 'postgres-js',
    skip: URL_ENV === undefined,
    async open() {
      const { admin, dbName, url } = adminUrl()
      const adminClient = new pg.Client({ connectionString: admin })
      await adminClient.connect()
      await adminClient.query(`CREATE DATABASE ${dbName}`)
      const client = postgres(url(dbName), { max: 2, onnotice: () => {} })
      return {
        db: drizzlePostgresJs(client) as unknown as PostgresDb,
        exec: async (text) => void (await client.unsafe(text)),
        rows: async (text) =>
          [...(await client.unsafe(text))] as Array<Record<string, unknown>>,
        close: async () => {
          await client.end()
          await adminClient.query(`DROP DATABASE IF EXISTS ${dbName}`)
          await adminClient.end()
        },
      }
    },
  },
]

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
/** A payload Postgres rejects: jsonb cannot hold U+0000. */
const BAD_PAYLOAD = {
  request: PAYLOAD.request,
  response: { text: 'a\u0000b' },
}

function recordingLogger(): { logger: Logger; calls: Array<[string, unknown, string]> } {
  const calls: Array<[string, unknown, string]> = []
  const at =
    (level: string) =>
    (fields: unknown, message: string): void => {
      calls.push([level, fields, message])
    }
  return {
    calls,
    logger: {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
    },
  }
}

for (const driver of DRIVERS) {
  describe.skipIf(driver.skip)(`${driver.name}`, () => {
    let h: Harness

    beforeAll(async () => {
      h = await driver.open()
    })
    afterAll(async () => {
      await h?.close()
    })
    beforeEach(async () => {
      await h.exec(
        `DROP TABLE IF EXISTS llm_call_payloads; DROP TABLE IF EXISTS llm_calls;`,
      )
      await h.exec(INSTALL_SQL)
    })

    async function counts(): Promise<{ calls: number; payloads: number }> {
      const c = await h.rows(`SELECT count(*)::int AS n FROM llm_calls`)
      const p = await h.rows(`SELECT count(*)::int AS n FROM llm_call_payloads`)
      return { calls: Number(c[0]?.['n']), payloads: Number(p[0]?.['n']) }
    }

    describe('a payload that cannot be written never costs the ledger row (P1-1)', () => {
      it('a payload Postgres rejects: record() resolves, the ledger row commits, the failure is logged', async () => {
        const { logger, calls } = recordingLogger()
        const sink = drizzleUsageSink({ db: h.db })
        await expect(
          sink.record(makeRecord(), { payload: BAD_PAYLOAD, logger }),
        ).resolves.toBeUndefined()
        expect(await counts()).toEqual({ calls: 1, payloads: 0 })
        expect(calls.map((c) => [c[0], c[2]])).toEqual([
          ['error', 'llm.call.payload.failed'],
        ])
        // The connection is usable afterwards and a good payload still lands.
        await sink.record(makeRecord({ callId: 'c2', attemptId: 'a2' }), {
          payload: PAYLOAD,
          logger,
        })
        expect(await counts()).toEqual({ calls: 2, payloads: 1 })
      })

      it('a missing payload table (payloads enabled before the upgrade): the ledger row commits and record() resolves', async () => {
        await h.exec(`DROP TABLE llm_call_payloads`)
        const { logger, calls } = recordingLogger()
        await expect(
          drizzleUsageSink({ db: h.db }).record(makeRecord(), {
            payload: PAYLOAD,
            logger,
          }),
        ).resolves.toBeUndefined()
        expect((await h.rows(`SELECT count(*)::int AS n FROM llm_calls`))[0]).toEqual({
          n: 1,
        })
        expect(calls).toHaveLength(1)
        expect(String((calls[0]?.[1] as { error: string }).error)).toMatch(
          /llm_call_payloads/,
        )
      })

      it('20 concurrent records, 4 with a bad payload: all resolve, 20 ledger rows, 16 payload rows', async () => {
        const sink = drizzleUsageSink({ db: h.db })
        const { logger, calls } = recordingLogger()
        const results = await Promise.allSettled(
          Array.from({ length: 20 }, (_, i) =>
            sink.record(makeRecord({ callId: `c${i}`, attemptId: `a${i}` }), {
              payload: i % 5 === 0 ? BAD_PAYLOAD : PAYLOAD,
              logger,
            }),
          ),
        )
        expect(results.filter((r) => r.status === 'rejected')).toEqual([])
        expect(await counts()).toEqual({ calls: 20, payloads: 16 })
        expect(calls).toHaveLength(4)
      })

      it('a failing ledger insert leaves neither row and rejects', async () => {
        await expect(
          drizzleUsageSink({ db: h.db }).record(
            makeRecord({ status: 'weird' as unknown as 'ok' }),
            { payload: PAYLOAD },
          ),
        ).rejects.toThrow(/llm_calls_status_check/)
        expect(await counts()).toEqual({ calls: 0, payloads: 0 })
      })
    })

    describe('retention helpers run on this driver (P1-2)', () => {
      it('purgeLlmCallPayloads takes a Date, deletes only older payloads and returns the count', async () => {
        const sink = drizzleUsageSink({ db: h.db })
        for (const [i, day] of ['01', '02', '03'].entries()) {
          await sink.record(
            makeRecord({
              callId: `c${i}`,
              attemptId: `a${i}`,
              createdAt: `2026-10-${day}T00:00:00.000Z`,
            }),
            { payload: PAYLOAD },
          )
        }
        expect(
          await purgeLlmCallPayloads(h.db, {
            olderThan: new Date('2026-10-02T00:00:00Z'),
          }),
        ).toBe(1)
        expect(
          await h.rows(`SELECT attempt_id FROM llm_call_payloads ORDER BY 1`),
        ).toEqual([{ attempt_id: 'a1' }, { attempt_id: 'a2' }])
        expect((await counts()).calls).toBe(3)
      })

      it('purges a backlog in bounded batches', async () => {
        await h.exec(`
          INSERT INTO llm_calls (record_schema_version, call_id, attempt_id, provider, model,
            status, token_details, generation_config, attempt_number, metadata)
          SELECT 2, 'c' || g, 'a' || g, 'p', 'm', 'ok', '{}', '{}', 1, '{}'
            FROM generate_series(1, 2500) g;
          INSERT INTO llm_call_payloads (attempt_id, request, response, created_at)
          SELECT 'a' || g, '{}', '{}', timestamptz '2026-01-01'
            FROM generate_series(1, 2500) g;`)
        expect(
          await purgeLlmCallPayloads(h.db, {
            olderThan: new Date('2026-06-01T00:00:00Z'),
            batchSize: 1000,
          }),
        ).toBe(2500)
        expect(await counts()).toEqual({ calls: 2500, payloads: 0 })
      })

      it('deleteLlmCallPayloads deletes by call id and nothing else; the schema checks pass', async () => {
        const sink = drizzleUsageSink({ db: h.db })
        await sink.record(makeRecord({ callId: 'c1', attemptId: 'a1' }), {
          payload: PAYLOAD,
        })
        await sink.record(makeRecord({ callId: 'c2', attemptId: 'a2' }), {
          payload: PAYLOAD,
        })
        expect(await deleteLlmCallPayloads(h.db, { callIds: ['c1', 'unknown'] })).toBe(1)
        expect(await h.rows(`SELECT attempt_id FROM llm_call_payloads`)).toEqual([
          { attempt_id: 'a2' },
        ])
        await expect(assertLlmCallsSchema(h.db)).resolves.toBeUndefined()
        await expect(assertLlmCallPayloadsSchema(h.db)).resolves.toBeUndefined()
      })
    })

    describe('db is a host transaction handle (P2-1)', () => {
      it('twelve concurrent records with payloads (two bad) all succeed and the host transaction stays usable and commits', async () => {
        const { logger } = recordingLogger()
        await h.db.transaction(async (ambient) => {
          const sink = drizzleUsageSink({ db: ambient as unknown as PostgresDb })
          const results = await Promise.allSettled(
            Array.from({ length: 12 }, (_, i) =>
              sink.record(makeRecord({ callId: `c${i}`, attemptId: `a${i}` }), {
                payload: i === 3 || i === 7 ? BAD_PAYLOAD : PAYLOAD,
                logger,
              }),
            ),
          )
          expect(results.filter((r) => r.status === 'rejected')).toEqual([])
          // The host's own next statement still works on its transaction.
          await ambient.execute(`SELECT 1`)
        })
        expect(await counts()).toEqual({ calls: 12, payloads: 10 })
      })

      it('a failing ledger insert on the host handle rejects only that record: the host transaction is not aborted and commits its other rows', async () => {
        await h.db.transaction(async (ambient) => {
          const sink = drizzleUsageSink({ db: ambient as unknown as PostgresDb })
          const results = await Promise.allSettled([
            sink.record(makeRecord({ callId: 'c1', attemptId: 'a1' })),
            sink.record(
              makeRecord({ callId: 'cx', attemptId: 'ax', status: 'weird' as 'ok' }),
            ),
            sink.record(makeRecord({ callId: 'c2', attemptId: 'a2' }), {
              payload: PAYLOAD,
            }),
          ])
          expect(results.map((r) => r.status)).toEqual([
            'fulfilled',
            'rejected',
            'fulfilled',
          ])
        })
        expect(await counts()).toEqual({ calls: 2, payloads: 1 })
      })

      it('the host owns the commit: a rollback takes the sink rows with it', async () => {
        await expect(
          h.db.transaction(async (ambient) => {
            await drizzleUsageSink({ db: ambient as unknown as PostgresDb }).record(
              makeRecord(),
              { payload: PAYLOAD },
            )
            throw new Error('host rolled back')
          }),
        ).rejects.toThrow('host rolled back')
        expect(await counts()).toEqual({ calls: 0, payloads: 0 })
      })

      it('a helper that hands every call one ambient transaction: concurrent records all succeed', async () => {
        await h.db.transaction(async (ambient) => {
          const sink = drizzleUsageSink({
            db: h.db,
            transaction: (fn) => fn(ambient as unknown as PostgresDb),
          })
          const results = await Promise.allSettled(
            Array.from({ length: 8 }, (_, i) =>
              sink.record(makeRecord({ callId: `c${i}`, attemptId: `a${i}` }), {
                payload: i === 2 ? BAD_PAYLOAD : PAYLOAD,
              }),
            ),
          )
          expect(results.filter((r) => r.status === 'rejected')).toEqual([])
        })
        expect(await counts()).toEqual({ calls: 8, payloads: 7 })
      })
    })

    describe('the ledger-failure error never carries the row (P2-2)', () => {
      const SECRET = 'CUSTOMER-REASONING-TEXT-T9'

      it('a CHECK violation rejects with the driver message and no parameters, no row values, no cause', async () => {
        const error = await drizzleUsageSink({ db: h.db })
          .record(
            makeRecord({
              status: 'weird' as unknown as 'ok',
              reasoningText: SECRET,
              metadata: { tenant: SECRET },
            }),
          )
          .catch((e: unknown) => e as Error)
        const text = `${String(error)} ${JSON.stringify(Object.entries(error as Error))}`
        expect(text).toContain('llm_calls_status_check')
        expect(text).toContain('SQLSTATE 23514')
        expect(text).not.toContain(SECRET)
        expect(text).not.toMatch(/params|Failed query|Failing row/)
        expect((error as Error).cause).toBeUndefined()
      })

      it('through the engine: a table missing a column logs llm.call.sink.failed with the cause and a pointer, and no log call contains the secret', async () => {
        await h.exec(`ALTER TABLE llm_calls DROP COLUMN error_reason`)
        const { logger, calls } = recordingLogger()
        const OK: AdapterResult = {
          message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
          text: 'ok',
          reasoningText: SECRET,
          usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
          model: 'm',
          warnings: [],
        }
        const client = createClient({
          adapters: [new FakeAdapter('google', [OK])],
          modelRegistry: createModelRegistry([
            makePermissiveTestDescriptor({ provider: 'google', model: 'm' }),
          ]),
          sink: drizzleUsageSink({ db: h.db }),
          ids: new FakeIds(),
          logger,
        })
        await client.generate(
          {
            provider: 'google',
            model: 'm',
            messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
          },
          { auth: { apiKey: 'k' } },
        )
        const failed = calls.filter((c) => c[2] === 'llm.call.sink.failed')
        expect(failed).toHaveLength(1)
        const logged = JSON.stringify(calls)
        expect(logged).toContain('error_reason')
        expect(logged).toContain('SQLSTATE 42703')
        expect(logged).toContain('assertLlmCallsSchema')
        expect(logged).not.toContain(SECRET)
        expect(logged).not.toMatch(/params:|Failed query/)
      })
    })

    describe('a client Clock with fractional milliseconds (P2-3)', () => {
      it('every row is written with whole-millisecond latency and queue delay', async () => {
        let t = 0
        const OK: AdapterResult = {
          message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
          text: 'ok',
          usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
          model: 'm',
          warnings: [],
        }
        const { logger, calls } = recordingLogger()
        const client = createClient({
          adapters: [
            new FakeAdapter('google', [
              OK,
              new LlmError('provider down', { kind: 'server', retryable: false }),
            ]),
          ],
          modelRegistry: createModelRegistry([
            makePermissiveTestDescriptor({ provider: 'google', model: 'm' }),
          ]),
          sink: drizzleUsageSink({ db: h.db }),
          clock: { now: () => (t += 3.7) },
          ids: new FakeIds(),
          logger,
        })
        const request = {
          provider: 'google',
          model: 'm',
          messages: [
            { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hi' }] },
          ],
        }
        await client.generate(request, { auth: { apiKey: 'k' } })
        await client.generate(request, { auth: { apiKey: 'k' } }).catch(() => undefined)
        expect(calls.filter((c) => c[2] === 'llm.call.sink.failed')).toEqual([])
        const rows = await h.rows(`SELECT latency_ms, queue_delay_ms FROM llm_calls`)
        expect(rows).toHaveLength(2)
        for (const row of rows) {
          expect(Number.isInteger(row['latency_ms'])).toBe(true)
          expect(row['latency_ms']).toBeGreaterThan(0)
        }
      })
    })

    describe('cost_micro_usd is BIGINT (P3-4)', () => {
      it('stores a cost above the INTEGER range and reads sums back as strings or numbers the docs describe', async () => {
        await drizzleUsageSink({ db: h.db }).record(
          makeRecord({ costMicroUsd: 5_000_000_000 }),
        )
        const rows = await h.rows(`SELECT cost_micro_usd, sum(cost_micro_usd)::float8 AS f
                                     FROM llm_calls GROUP BY 1`)
        expect(Number(rows[0]?.['cost_micro_usd'])).toBe(5_000_000_000)
        expect(rows[0]?.['f']).toBe(5_000_000_000)
      })
    })

    describe('assertLlmCallsSchema reports a column that would block every insert (P2-4)', () => {
      it('passes on a fresh install', async () => {
        await expect(assertLlmCallsSchema(h.db)).resolves.toBeUndefined()
      })

      it('names raw_usage NOT NULL (a 0.1.1 to 0.4.0 table) with the one-line fix', async () => {
        await h.exec(`ALTER TABLE llm_calls ALTER COLUMN raw_usage SET NOT NULL`)
        const error = await assertLlmCallsSchema(h.db).catch((e: unknown) => e as Error)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain('"raw_usage"')
        expect((error as Error).message).toContain(
          'ALTER TABLE llm_calls ALTER COLUMN "raw_usage" DROP NOT NULL',
        )
        // ... and that is exactly what the sink would hit on an error row.
        await expect(
          drizzleUsageSink({ db: h.db }).record(makeRecord({ rawUsage: null })),
        ).rejects.toThrow(/raw_usage/)
      })

      it('names an extra NOT NULL column without a default, and accepts one with a default', async () => {
        await h.exec(
          `ALTER TABLE llm_calls ADD COLUMN extra_col TEXT NOT NULL DEFAULT 'x'`,
        )
        await expect(assertLlmCallsSchema(h.db)).resolves.toBeUndefined()
        await h.exec(`ALTER TABLE llm_calls ALTER COLUMN extra_col DROP DEFAULT`)
        const error = await assertLlmCallsSchema(h.db).catch((e: unknown) => e as Error)
        expect((error as Error).message).toContain('"extra_col"')
        await h.exec(`ALTER TABLE llm_calls ALTER COLUMN extra_col DROP NOT NULL`)
        await expect(assertLlmCallsSchema(h.db)).resolves.toBeUndefined()
      })
    })
  })
}
