/**
 * Every SQL fence of `docs/ledger.md` is executed on PGlite against a fresh
 * install holding rows of record version 1 and 2, so the documented queries
 * cannot rot, and the spend classification is checked against rows whose class
 * is known.
 *
 * Runs on PGlite (in-memory WASM Postgres): offline, no Docker.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

/** The ```sql fences of a markdown file, in order. */
function sqlFences(markdown: string): string[] {
  return [...markdown.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => (m[1] ?? '').trim())
}

const fences = sqlFences(read('../../../docs/ledger.md'))

interface SeedRow {
  attempt: string
  call: string
  version: 1 | 2
  attemptNumber?: number
  status?: string
  errorKind?: string | null
  cost?: number | null
  confidence?: string | null
  details?: string | null
  reason?: string | null
}

const SEED: SeedRow[] = [
  // version 1: confidence and reason never stored
  { attempt: 'v1_priced', call: 'c_v1', version: 1, cost: 50 },
  { attempt: 'v1_nocost_ok', call: 'c_v1', version: 1, attemptNumber: 2 },
  {
    attempt: 'v1_nocost_fail',
    call: 'c_v1b',
    version: 1,
    status: 'timeout',
    errorKind: 'timeout',
  },
  // version 2
  {
    attempt: 'v2_exact',
    call: 'c_v2',
    version: 2,
    cost: 100,
    confidence: 'exact',
    details: '{"input":40,"cached":0,"output":50,"tools":10}',
  },
  {
    attempt: 'v2_estimated',
    call: 'c_v2',
    version: 2,
    attemptNumber: 2,
    cost: 30,
    confidence: 'estimated',
    details: '{"input":10,"cached":0,"output":10,"tools":10}',
  },
  {
    attempt: 'v2_no_usage',
    call: 'c_v2b',
    version: 2,
    status: 'timeout',
    errorKind: 'timeout',
    reason: 'no_usage_reported',
  },
  {
    attempt: 'v2_unknown_model',
    call: 'c_v2b',
    version: 2,
    attemptNumber: 2,
    confidence: 'estimated',
    reason: 'Unknown model "m"; no pricing entry found.',
    details: '{"input":0,"cached":0,"output":0,"tools":0}',
  },
  {
    attempt: 'v2_free_failure',
    call: 'c_v2c',
    version: 2,
    status: 'api_error',
    errorKind: 'bad_request',
  },
  {
    attempt: 'v2_refusal',
    call: 'c_v2c',
    version: 2,
    attemptNumber: 0,
    status: 'api_error',
    errorKind: 'rate_limited',
  },
]

const q = (value: string | number | null | undefined): string =>
  value === undefined || value === null
    ? 'NULL'
    : typeof value === 'number'
      ? String(value)
      : `'${value.replaceAll("'", "''")}'`

function seedSql(row: SeedRow): string {
  return `INSERT INTO llm_calls (
      record_schema_version, call_id, attempt_id, provider, model, status, token_details,
      generation_config, attempt_number, metadata, error_kind, cost_micro_usd,
      cost_confidence, cost_details, cost_unpriced_reason, error_reason, auth_key_id,
      provider_metadata, call_site_id
    ) VALUES (
      ${row.version}, ${q(row.call)}, ${q(row.attempt)}, 'google', 'm',
      ${q(row.status ?? 'ok')}, '{}', '{}', ${row.attemptNumber ?? 1}, '{}',
      ${q(row.errorKind)}, ${q(row.cost)}, ${q(row.confidence)},
      ${row.details === undefined || row.details === null ? 'NULL' : `${q(row.details)}::jsonb`},
      ${q(row.reason)}, ${row.attempt === 'v2_refusal' ? "'quota_window'" : 'NULL'},
      ${row.version === 2 ? "'key1'" : 'NULL'},
      ${row.attempt === 'v2_exact' ? `'{"groundingMetadata":{}}'::jsonb` : 'NULL'}, 'site'
    )`
}

describe('docs/ledger.md SQL runs on a table holding rows of both record versions', () => {
  let pg: PGlite

  beforeAll(async () => {
    pg = new PGlite()
    await pg.exec(read('../sql/install.sql'))
    // The host-owned sidecar the guide's join example reads.
    await pg.exec(`CREATE TABLE llm_call_context (
      attempt_id TEXT PRIMARY KEY REFERENCES llm_calls (attempt_id),
      job_id TEXT NOT NULL
    )`)
    for (const row of SEED) await pg.exec(seedSql(row))
    await pg.exec(
      `INSERT INTO llm_call_context VALUES ('v2_exact', 'job1'), ('v1_priced', 'job1')`,
    )
    await pg.exec(
      `INSERT INTO llm_call_payloads (attempt_id, request, response) VALUES ('v2_exact', '{}', '{}')`,
    )
  })

  it('the guide has SQL fences to check', () => {
    expect(fences.length).toBeGreaterThanOrEqual(8)
  })

  it.each(fences.map((text, index) => [index, text] as const))(
    'fence %i executes without error',
    async (_index, text) => {
      const statements = text.split(/;\s*(?:\n|$)/).filter((s) => s.trim() !== '')
      for (const statement of statements) {
        const params = statement.includes('$1') ? ['job1'] : []
        await expect(pg.query(statement, params), statement).resolves.toBeDefined()
      }
    },
  )

  it('the classification query puts every row in the class its record version supports', async () => {
    const fence = fences.find((f) => f.includes('as spend_class'))
    expect(fence).toBeDefined()
    const { rows } = await pg.query<{
      spend_class: string
      attempts: string | number
      spend_micro_usd: number
    }>((fence as string).replace(/;\s*$/, ''))
    const byClass = Object.fromEntries(
      rows.map((r) => [r.spend_class, [Number(r.attempts), r.spend_micro_usd]]),
    )
    expect(byClass).toEqual({
      'known free': [2, 0],
      'priced, confidence not recorded': [1, 50],
      'priced, estimated': [1, 30],
      'priced, exact': [1, 100],
      unknown: [2, 0],
      // both the no_usage_reported failure and the unknown-model attempt
      'unpriced, may have billed': [2, 0],
    })
    // every row is in exactly one class
    expect(rows.reduce((n, r) => n + Number(r.attempts), 0)).toBe(SEED.length)
  })

  it('a version 1 row without a cost is never "known free"', async () => {
    const { rows } = await pg.query<{ attempt_id: string }>(
      `select attempt_id from llm_calls
        where record_schema_version = 2 and cost_micro_usd is null and cost_unpriced_reason is null
        order by attempt_id`,
    )
    expect(rows.map((r) => r.attempt_id)).toEqual(['v2_free_failure', 'v2_refusal'])
  })

  it('the reconciliation query: COALESCE gives 0 for an all-NULL call, and unpriced and unknown attempts are counted', async () => {
    const fence = fences.find((f) => f.includes('unknown_attempts'))
    expect(fence).toBeDefined()
    const run = async (call: string) =>
      (
        await pg.query<{
          micro_usd: number
          unpriced_attempts: string | number
          unknown_attempts: string | number
        }>((fence as string).replace(/;\s*$/, ''), [call])
      ).rows[0]
    expect(await run('c_v2')).toMatchObject({ micro_usd: 130, unpriced_attempts: 0 })
    // all attempts NULL: 0, not NULL
    expect(await run('c_v2b')).toMatchObject({ micro_usd: 0 })
    expect(Number((await run('c_v2b'))?.unpriced_attempts)).toBe(2)
    expect(Number((await run('c_v1'))?.unknown_attempts)).toBe(1)
    expect(Number((await run('c_v1b'))?.unknown_attempts)).toBe(1)
    expect((await run('c_v1b'))?.micro_usd).toBe(0)
  })

  it('the per-key spend of a key whose attempts are all unpriced is 0, not NULL', async () => {
    await pg.exec(
      `INSERT INTO llm_calls (record_schema_version, call_id, attempt_id, provider, model,
         status, token_details, generation_config, attempt_number, metadata, auth_key_id,
         cost_unpriced_reason, created_at)
       VALUES (2, 'c_k', 'k1', 'google', 'm', 'timeout', '{}', '{}', 1, '{}', 'key_unpriced',
         'no_usage_reported', now())`,
    )
    const fence = fences.find(
      (f) => f.includes('group by 1;') && f.includes('auth_key_id'),
    )
    expect(fence).toBeDefined()
    const statement = (fence as string)
      .split(/;\s*(?:\n|$)/)
      .find((s) => s.includes('sum(cost_micro_usd)'))
    const { rows } = await pg.query<{ auth_key_id: string; spend_micro_usd: number }>(
      statement as string,
    )
    const byKey = Object.fromEntries(rows.map((r) => [r.auth_key_id, r.spend_micro_usd]))
    expect(byKey['key_unpriced']).toBe(0)
    expect(byKey['key1']).toBe(130)
  })
})
