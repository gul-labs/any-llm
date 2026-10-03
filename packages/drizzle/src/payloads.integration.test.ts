/**
 * Payload storage against a real Postgres engine (PGlite, offline): the engine
 * hands a payload to `drizzleUsageSink`, which writes it with the ledger row in
 * one transaction, with the payload insert behind a savepoint.
 *
 * node-postgres: the repo has no Postgres service in CI and `pg` is not a
 * dependency, so the same assertions are not repeated against it. PGlite
 * runs real Postgres transaction semantics (BEGIN, SAVEPOINT, ROLLBACK TO
 * SAVEPOINT) through the same drizzle-orm `PgDatabase.transaction` code the
 * node-postgres driver shares.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { describe, expect, it } from 'vitest'
import {
  LlmError,
  createClient,
  createModelRegistry,
  defineCallSite,
} from '@gullabs/core'
import type { AdapterResult, LlmCallRecord, Usage } from '@gullabs/core'
import { FakeAdapter, RecordingLogger } from '@gullabs/testing'
import { makePermissiveTestDescriptor } from '../../core/src/test-model-descriptor.js'
import {
  assertLlmCallPayloadsSchema,
  deleteLlmCallPayloads,
  drizzleUsageSink,
  llmCallPayloads,
  llmCalls,
  purgeLlmCallPayloads,
} from './index.js'
import type { PostgresDb } from './index.js'

const INSTALL_SQL = readFileSync(
  fileURLToPath(new URL('../sql/install.sql', import.meta.url)),
  'utf8',
)

const USAGE: Usage = { inputTokens: 1, outputTokens: 1, details: {}, raw: null }
const AUTH = { apiKey: 'k' }

function ok(text = 'the answer'): AdapterResult {
  return {
    message: { role: 'assistant', parts: [{ kind: 'text', text }] },
    text,
    usage: USAGE,
    model: 'm',
    warnings: [],
  }
}

async function freshDb(): Promise<{ pg: PGlite; db: ReturnType<typeof drizzle> }> {
  const pg = new PGlite()
  await pg.exec(INSTALL_SQL)
  return { pg, db: drizzle({ client: pg }) }
}

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

function engine(
  sink: ReturnType<typeof drizzleUsageSink>,
  entries: Array<AdapterResult | LlmError>,
  extra: { sinkTimeoutMs?: number } = {},
) {
  const logger = new RecordingLogger()
  const client = createClient({
    adapters: [new FakeAdapter('p', entries as AdapterResult[])],
    modelRegistry: createModelRegistry([
      makePermissiveTestDescriptor({ model: 'm', provider: 'p' }),
    ]),
    sink,
    logger,
    payloads: {},
    ...extra,
  })
  return { client, logger }
}

const request = {
  provider: 'p',
  model: 'm',
  messages: [
    { role: 'user' as const, parts: [{ kind: 'text' as const, text: 'hello' }] },
  ],
}

async function counts(pg: PGlite): Promise<{ calls: number; payloads: number }> {
  const calls = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM llm_calls`)
  const payloads = await pg.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM llm_call_payloads`,
  )
  return { calls: calls.rows[0]!.n, payloads: payloads.rows[0]!.n }
}

describe('engine -> drizzleUsageSink -> llm_call_payloads', () => {
  it('off by default: a client without payloads writes ledger rows and no payload rows', async () => {
    const { pg, db } = await freshDb()
    const client = createClient({
      adapters: [new FakeAdapter('p', [ok()])],
      modelRegistry: createModelRegistry([
        makePermissiveTestDescriptor({ model: 'm', provider: 'p' }),
      ]),
      sink: drizzleUsageSink({ db }),
    })
    await client.generate(request, { auth: AUTH })
    expect(await counts(pg)).toEqual({ calls: 1, payloads: 0 })
  })

  it('on: one payload row per dispatched attempt, errors included, keyed by attempt_id', async () => {
    const { pg, db } = await freshDb()
    const { client } = engine(drizzleUsageSink({ db }), [
      new LlmError('upstream busy', { kind: 'server', retryable: false }),
      ok(),
    ])
    await expect(client.generate(request, { auth: AUTH })).rejects.toThrow(
      'upstream busy',
    )
    await client.generate(request, { auth: AUTH })

    expect(await counts(pg)).toEqual({ calls: 2, payloads: 2 })
    const rows = await pg.query<{
      status: string
      request: unknown
      response: unknown
    }>(
      `SELECT c.status, p.request, p.response
         FROM llm_calls c JOIN llm_call_payloads p USING (attempt_id)
        ORDER BY c.created_at, c.status`,
    )
    expect(rows.rows).toHaveLength(2)
    const byStatus = Object.fromEntries(rows.rows.map((r) => [r.status, r]))
    expect(byStatus['api_error']?.response).toEqual({ errorMessage: 'upstream busy' })
    expect(byStatus['ok']?.response).toEqual({ text: 'the answer' })
    expect(byStatus['ok']?.request).toEqual({
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hello' }] }],
    })
  })

  it('storePayload: false skips on generate and on runStructured', async () => {
    const { pg, db } = await freshDb()
    const { client } = engine(drizzleUsageSink({ db }), [ok(), ok()])
    await client.generate(request, { auth: AUTH, storePayload: false })
    await client.runStructured(
      defineCallSite({ id: 's', provider: 'p', model: 'm', userTemplate: 'hi' }),
      { auth: AUTH, storePayload: false },
    )
    expect(await counts(pg)).toEqual({ calls: 2, payloads: 0 })
  })

  it('a failing payload insert (table not migrated) leaves the ledger row committed and no payload row', async () => {
    const { pg, db } = await freshDb()
    await pg.exec(`DROP TABLE llm_call_payloads`)
    const { client, logger } = engine(drizzleUsageSink({ db }), [ok()])
    await expect(client.generate(request, { auth: AUTH })).resolves.toMatchObject({
      text: 'the answer',
    })
    const calls = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM llm_calls`,
    )
    expect(calls.rows[0]?.n).toBe(1)
    expect(logger.findAll('llm.call.payload.failed')).toHaveLength(1)
    expect(logger.find('llm.call.payload.failed')?.fields).toMatchObject({
      error: expect.stringContaining('llm_call_payloads'),
    })
    // The sink itself succeeded, so the engine logged no sink failure.
    expect(logger.find('llm.call.sink.failed')).toBeUndefined()
  })

  it('a payload row Postgres rejects (a constraint) rolls back to the savepoint: ledger row committed, no payload row', async () => {
    const { pg, db } = await freshDb()
    await pg.exec(
      `ALTER TABLE llm_call_payloads ADD CONSTRAINT never CHECK (attempt_id = 'never')`,
    )
    const { client, logger } = engine(drizzleUsageSink({ db }), [ok(), ok()])
    await client.generate(request, { auth: AUTH })
    // The connection is not left in an aborted transaction: the next call works too.
    await client.generate(request, { auth: AUTH })
    expect(await counts(pg)).toEqual({ calls: 2, payloads: 0 })
    expect(logger.findAll('llm.call.payload.failed')).toHaveLength(2)
    expect(logger.find('llm.call.sink.failed')).toBeUndefined()
  })

  it('the failure log carries the driver error, not the statement and its parameters', async () => {
    const { pg, db } = await freshDb()
    await pg.exec(`ALTER TABLE llm_call_payloads ADD CONSTRAINT never CHECK (false)`)
    const { client, logger } = engine(drizzleUsageSink({ db }), [
      ok('SECRET CUSTOMER TEXT'),
    ])
    await client.generate(
      {
        ...request,
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'PRIVATE PROMPT' }] }],
      },
      { auth: AUTH },
    )
    const logged = JSON.stringify(logger.findAll('llm.call.payload.failed'))
    expect(logged).toContain('never')
    expect(logged).not.toContain('PRIVATE PROMPT')
    expect(logged).not.toContain('SECRET CUSTOMER TEXT')
  })

  it('a failing ledger insert leaves neither row: the transaction aborts, no orphan payload', async () => {
    const { pg, db } = await freshDb()
    const sink = drizzleUsageSink({ db })
    await expect(
      sink.record(makeRecord({ status: 'weird' as unknown as 'ok' }), {
        payload: PAYLOAD,
      }),
    ).rejects.toThrow()
    expect(await counts(pg)).toEqual({ calls: 0, payloads: 0 })

    // Through the engine the failure is logged as a sink failure and the call is unaffected.
    const { client, logger } = engine(
      {
        record: (r, ctx) =>
          sink.record({ ...r, status: 'weird' as unknown as 'ok' }, ctx),
      },
      [ok()],
    )
    await expect(client.generate(request, { auth: AUTH })).resolves.toBeDefined()
    expect(await counts(pg)).toEqual({ calls: 0, payloads: 0 })
    expect(logger.find('llm.call.sink.failed')?.level).toBe('error')
  })

  it('a host transaction helper is used for the write, and its rollback takes both rows', async () => {
    const { pg, db } = await freshDb()
    let opened = 0
    const sink = drizzleUsageSink({
      db,
      transaction: (fn) => {
        opened += 1
        return db.transaction(fn)
      },
    })
    await sink.record(makeRecord(), { payload: PAYLOAD })
    await sink.record(makeRecord({ attemptId: 'attempt_2' }))
    expect(opened).toBe(2)
    expect(await counts(pg)).toEqual({ calls: 2, payloads: 1 })

    // A helper that fails after the callback ran (a failed COMMIT, a lost
    // connection) leaves neither row: both statements were on its transaction.
    const failing = drizzleUsageSink({
      db,
      transaction: async (fn) =>
        db.transaction(async (tx) => {
          await fn(tx)
          throw new Error('commit failed')
        }),
    })
    await expect(
      failing.record(makeRecord({ attemptId: 'attempt_3' }), { payload: PAYLOAD }),
    ).rejects.toThrow('commit failed')
    expect(await counts(pg)).toEqual({ calls: 2, payloads: 1 })
  })

  it('a host helper can run statements of its own on the same handle', async () => {
    const { pg, db } = await freshDb()
    const sink = drizzleUsageSink({
      db,
      transaction: (fn) =>
        db.transaction(async (tx) => {
          // For example a tenant or role context for the transaction.
          await tx.execute(`SELECT set_config('app.tenant', 't1', true)`)
          return fn(tx as unknown as PostgresDb)
        }),
    })
    await sink.record(makeRecord(), { payload: PAYLOAD })
    expect(await counts(pg)).toEqual({ calls: 1, payloads: 1 })
    // The setting was transaction-local.
    const setting = await pg.query<{ v: string | null }>(
      `SELECT current_setting('app.tenant', true) AS v`,
    )
    expect(setting.rows[0]?.v ?? '').toBe('')
  })

  it('the write is bounded by sinkTimeoutMs: a hung transaction does not hold the call', async () => {
    const { db } = await freshDb()
    const sink = drizzleUsageSink({
      db,
      transaction: () => new Promise<never>(() => {}),
    })
    const { client, logger } = engine(sink, [ok()], { sinkTimeoutMs: 20 })
    await expect(client.generate(request, { auth: AUTH })).resolves.toMatchObject({
      text: 'the answer',
    })
    expect(logger.find('llm.call.sink.timeout')?.level).toBe('error')
  })

  it('a retried write of the same attempt stores one ledger row and one payload', async () => {
    const { pg, db } = await freshDb()
    const sink = drizzleUsageSink({ db })
    await sink.record(makeRecord(), { payload: PAYLOAD })
    await sink.record(makeRecord(), {
      payload: { request: { messages: [] }, response: { text: 'second' } },
    })
    expect(await counts(pg)).toEqual({ calls: 1, payloads: 1 })
    const row = await pg.query<{ response: unknown }>(
      `SELECT response FROM llm_call_payloads`,
    )
    expect(row.rows[0]?.response).toEqual({ text: 'hi' })
  })
})

describe('retention and deletion', () => {
  async function seeded() {
    const { pg, db } = await freshDb()
    const sink = drizzleUsageSink({ db })
    const days = (n: number) => new Date(Date.UTC(2026, 9, 1 + n)).toISOString()
    // call_a: two attempts (day 0 and 1), call_b: one (day 2), call_c: one (day 3).
    // call_a and call_b share an externalId, as two tenants' calls may.
    await sink.record(
      makeRecord({
        callId: 'call_a',
        attemptId: 'a1',
        externalId: 'job-1',
        createdAt: days(0),
      }),
      { payload: PAYLOAD },
    )
    await sink.record(
      makeRecord({
        callId: 'call_a',
        attemptId: 'a2',
        attemptNumber: 2,
        externalId: 'job-1',
        createdAt: days(1),
      }),
      { payload: PAYLOAD },
    )
    await sink.record(
      makeRecord({
        callId: 'call_b',
        attemptId: 'b1',
        externalId: 'job-1',
        createdAt: days(2),
      }),
      { payload: PAYLOAD },
    )
    await sink.record(
      makeRecord({ callId: 'call_c', attemptId: 'c1', createdAt: days(3) }),
      { payload: PAYLOAD },
    )
    // A ledger row that never had a payload.
    await sink.record(
      makeRecord({ callId: 'call_d', attemptId: 'd1', createdAt: days(0) }),
    )
    return { pg, db, days: (n: number) => new Date(days(n)) }
  }

  const remaining = async (pg: PGlite) =>
    (
      await pg.query<{ attempt_id: string }>(
        `SELECT attempt_id FROM llm_call_payloads ORDER BY attempt_id`,
      )
    ).rows.map((r) => r.attempt_id)

  it('purgeLlmCallPayloads deletes payloads older than the cutoff and nothing else', async () => {
    const { pg, db, days } = await seeded()
    expect(await purgeLlmCallPayloads(db, { olderThan: days(2) })).toBe(2)
    expect(await remaining(pg)).toEqual(['b1', 'c1'])
    // The ledger is untouched.
    expect((await counts(pg)).calls).toBe(5)
    // Strictly older: the row at the cutoff stays; running again deletes nothing.
    expect(await purgeLlmCallPayloads(db, { olderThan: days(2) })).toBe(0)
    expect(await purgeLlmCallPayloads(db, { olderThan: days(10) })).toBe(2)
    expect(await remaining(pg)).toEqual([])
    expect((await counts(pg)).calls).toBe(5)
  })

  it('purgeLlmCallPayloads rejects an invalid cutoff instead of deleting', async () => {
    const { pg, db } = await seeded()
    await expect(
      purgeLlmCallPayloads(db, { olderThan: new Date('nope') }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    await expect(
      purgeLlmCallPayloads(db, { olderThan: '2026-01-01' as unknown as Date }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(await remaining(pg)).toEqual(['a1', 'a2', 'b1', 'c1'])
  })

  it('deleteLlmCallPayloads deletes every attempt of the given calls and touches no other call', async () => {
    const { pg, db } = await seeded()
    expect(await deleteLlmCallPayloads(db, { callIds: ['call_a'] })).toBe(2)
    // call_b has the same externalId as call_a and keeps its payload.
    expect(await remaining(pg)).toEqual(['b1', 'c1'])
    expect((await counts(pg)).calls).toBe(5)

    // Unknown ids, and an empty list, delete nothing.
    expect(await deleteLlmCallPayloads(db, { callIds: ['nope', 'call_d'] })).toBe(0)
    expect(await deleteLlmCallPayloads(db, { callIds: [] })).toBe(0)
    expect(await remaining(pg)).toEqual(['b1', 'c1'])

    expect(await deleteLlmCallPayloads(db, { callIds: ['call_b', 'call_c'] })).toBe(2)
    expect(await remaining(pg)).toEqual([])
  })

  it('deleteLlmCallPayloads takes only callIds: there is no delete by externalId', async () => {
    const { pg, db } = await seeded()
    await expect(
      deleteLlmCallPayloads(db, { externalId: 'job-1' } as unknown as {
        callIds: string[]
      }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    await expect(deleteLlmCallPayloads(db, { callIds: [''] })).rejects.toMatchObject({
      kind: 'bad_request',
    })
    expect(await remaining(pg)).toEqual(['a1', 'a2', 'b1', 'c1'])
  })

  it('deleteLlmCallPayloads handles a list larger than one statement', async () => {
    const { pg, db } = await seeded()
    const many = [...Array.from({ length: 2500 }, (_, i) => `ghost_${i}`), 'call_a']
    expect(await deleteLlmCallPayloads(db, { callIds: many })).toBe(2)
    expect(await remaining(pg)).toEqual(['b1', 'c1'])
  })

  it('assertLlmCallPayloadsSchema resolves on a fresh install and rejects when the table is missing', async () => {
    const { pg, db } = await freshDb()
    await expect(assertLlmCallPayloadsSchema(db)).resolves.toBeUndefined()
    await pg.exec(`DROP TABLE llm_call_payloads`)
    await expect(assertLlmCallPayloadsSchema(db)).rejects.toThrow(
      /0003-llm-call-payloads\.sql/,
    )
  })

  it('reads a payload back through the Drizzle table', async () => {
    const { db } = await freshDb()
    await drizzleUsageSink({ db }).record(makeRecord(), { payload: PAYLOAD })
    const rows = await db.select().from(llmCallPayloads)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ attemptId: 'attempt_1', response: { text: 'hi' } })
    expect((await db.select().from(llmCalls)).length).toBe(1)
  })
})

describe('a host helper that reuses one transaction handle (P2-2)', () => {
  const GOOD = (id: string) => makeRecord({ attemptId: id, callId: `call_${id}` })

  async function withAmbient(
    db: ReturnType<typeof drizzle>,
    work: (sink: ReturnType<typeof drizzleUsageSink>) => Promise<void>,
    options: { rollback?: boolean } = {},
  ): Promise<void> {
    const outcome = db.transaction(async (ambient) => {
      const sink = drizzleUsageSink({
        db,
        // what an ambient-transaction wrapper does: every call gets the same handle
        transaction: (fn) => fn(ambient as unknown as PostgresDb),
      })
      await work(sink)
      if (options.rollback === true) throw new Error('host rolled back')
    })
    if (options.rollback === true)
      await expect(outcome).rejects.toThrow('host rolled back')
    else await outcome
  }

  it('three concurrent writes on one handle all keep what is storable: two good payloads kept, the bad one rejected alone', async () => {
    const { pg, db } = await freshDb()
    await pg.exec(
      `ALTER TABLE llm_call_payloads ADD CONSTRAINT not_bad CHECK (attempt_id <> 'bad')`,
    )
    const errors: Array<[unknown, string]> = []
    const logger = {
      debug() {},
      info() {},
      warn() {},
      error: (fields: unknown, message: string) => void errors.push([fields, message]),
    }
    await withAmbient(db, async (sink) => {
      await Promise.all([
        sink.record(GOOD('a'), { payload: PAYLOAD, logger }),
        sink.record(GOOD('bad'), { payload: PAYLOAD, logger }),
        sink.record(GOOD('c'), { payload: PAYLOAD, logger }),
      ])
    })
    expect(await counts(pg)).toEqual({ calls: 3, payloads: 2 })
    const kept = await pg.query<{ attempt_id: string }>(
      `SELECT attempt_id FROM llm_call_payloads ORDER BY attempt_id`,
    )
    expect(kept.rows).toEqual([{ attempt_id: 'a' }, { attempt_id: 'c' }])
    expect(errors.map(([, m]) => m)).toEqual(['llm.call.payload.failed'])
    expect(errors[0]?.[0]).toMatchObject({ attemptId: 'bad' })
  })

  it('ten concurrent writes, half without a payload, all land', async () => {
    const { pg, db } = await freshDb()
    await withAmbient(db, async (sink) => {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          sink.record(GOOD(`w${i}`), i % 2 === 0 ? { payload: PAYLOAD } : undefined),
        ),
      )
    })
    expect(await counts(pg)).toEqual({ calls: 10, payloads: 5 })
  })

  it('a rollback of the host transaction takes the ledger rows and payloads with it', async () => {
    const { pg, db } = await freshDb()
    await withAmbient(
      db,
      async (sink) => {
        await sink.record(GOOD('a'), { payload: PAYLOAD })
        await sink.record(GOOD('b'))
      },
      { rollback: true },
    )
    expect(await counts(pg)).toEqual({ calls: 0, payloads: 0 })
  })
})

describe('a database without transaction support (P2-7)', () => {
  function noTransactions(db: ReturnType<typeof drizzle>): PostgresDb {
    return new Proxy(db, {
      get(target, key) {
        if (key === 'transaction') {
          return () => {
            throw new Error('No transactions support in neon-http driver')
          }
        }
        return Reflect.get(target, key, target) as unknown
      },
    }) as unknown as PostgresDb
  }

  it('ledger-only writes work: one INSERT, no transaction', async () => {
    const { pg, db } = await freshDb()
    const sink = drizzleUsageSink({ db: noTransactions(db) })
    await sink.record(makeRecord())
    expect(await counts(pg)).toEqual({ calls: 1, payloads: 0 })
    const { client, logger } = engine(sink, [ok()])
    await client.generate(request, { auth: AUTH, storePayload: false })
    expect(logger.find('llm.call.sink.failed')).toBeUndefined()
    expect(await counts(pg)).toEqual({ calls: 2, payloads: 0 })
  })

  it('a payload cannot be written without transactions: the write fails loudly, nothing is half written', async () => {
    const { pg, db } = await freshDb()
    const sink = drizzleUsageSink({ db: noTransactions(db) })
    const { client, logger } = engine(sink, [ok()])
    await expect(client.generate(request, { auth: AUTH })).resolves.toBeDefined()
    expect(logger.find('llm.call.sink.failed')?.fields).toMatchObject({
      error: expect.stringContaining('No transactions support'),
    })
    expect(await counts(pg)).toEqual({ calls: 0, payloads: 0 })
  })
})

describe('purgeLlmCallPayloads runs in bounded batches (P2-3)', () => {
  async function seed(pg: PGlite, old: number, fresh: number) {
    await pg.exec(`
      INSERT INTO llm_calls (record_schema_version, call_id, attempt_id, provider, model,
        status, token_details, generation_config, attempt_number, metadata)
      SELECT 2, 'c' || g, 'a' || g, 'p', 'm', 'ok', '{}', '{}', 1, '{}'
        FROM generate_series(1, ${old + fresh}) g;
      INSERT INTO llm_call_payloads (attempt_id, request, response, created_at)
      SELECT 'a' || g, '{}', '{}', CASE WHEN g <= ${old} THEN timestamptz '2026-01-01' ELSE now() END
        FROM generate_series(1, ${old + fresh}) g;`)
  }

  it('deletes in batches of batchSize, returns the total, and keeps newer payloads and every ledger row', async () => {
    const pg = new PGlite()
    await pg.exec(INSTALL_SQL)
    const statements: string[] = []
    const db = drizzle({
      client: pg,
      logger: { logQuery: (query) => void statements.push(query) },
    })
    await seed(pg, 12_000, 3)
    const deleted = await purgeLlmCallPayloads(db, {
      olderThan: new Date('2026-06-01T00:00:00Z'),
      batchSize: 5000,
    })
    expect(deleted).toBe(12_000)
    expect(await counts(pg)).toEqual({ calls: 12_003, payloads: 3 })
    // 5000 + 5000 + 2000: three statements, the last one short
    expect(statements.filter((q) => /delete from/i.test(q))).toHaveLength(3)
  })

  it('never selects the deleted ids back: the statement returns one count', async () => {
    const pg = new PGlite()
    await pg.exec(INSTALL_SQL)
    const statements: string[] = []
    const db = drizzle({
      client: pg,
      logger: { logQuery: (query) => void statements.push(query) },
    })
    await seed(pg, 20, 0)
    await purgeLlmCallPayloads(db, { olderThan: new Date('2027-01-01T00:00:00Z') })
    const del = statements.find((q) => /delete from/i.test(q)) ?? ''
    expect(del).toMatch(/returning 1/i)
    expect(del).not.toMatch(/returning "?llm_call_payloads"?\."?attempt_id/i)
    expect(del).toMatch(/limit/i)
  })

  it('an exact multiple of the batch size ends with one empty batch, and zero rows is zero', async () => {
    const pg = new PGlite()
    await pg.exec(INSTALL_SQL)
    const db = drizzle({ client: pg })
    await seed(pg, 10, 0)
    expect(
      await purgeLlmCallPayloads(db, {
        olderThan: new Date('2027-01-01T00:00:00Z'),
        batchSize: 5,
      }),
    ).toBe(10)
    expect(
      await purgeLlmCallPayloads(db, { olderThan: new Date('2027-01-01T00:00:00Z') }),
    ).toBe(0)
  })

  it.each([0, -1, 1.5, Number.NaN, 1_000_001, '5'])(
    'batchSize %s is bad_request and deletes nothing',
    async (batchSize) => {
      const pg = new PGlite()
      await pg.exec(INSTALL_SQL)
      const db = drizzle({ client: pg })
      await seed(pg, 3, 0)
      await expect(
        purgeLlmCallPayloads(db, {
          olderThan: new Date('2027-01-01T00:00:00Z'),
          batchSize: batchSize as number,
        }),
      ).rejects.toMatchObject({ kind: 'bad_request' })
      expect(await counts(pg)).toEqual({ calls: 3, payloads: 3 })
    },
  )
})

describe('deleteLlmCallPayloads validation (P3-11)', () => {
  it('a sparse array is bad_request, not a raw driver error', async () => {
    const { db } = await freshDb()
    await expect(
      deleteLlmCallPayloads(db, { callIds: ['a', , 'c'] as unknown as string[] }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    await expect(
      deleteLlmCallPayloads(db, { callIds: new Array<string>(3) }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })
})
