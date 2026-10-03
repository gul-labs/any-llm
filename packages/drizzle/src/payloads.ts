import { inArray, sql } from 'drizzle-orm'
import { LlmError } from '@gullabs/core'
import { llmCallPayloads, llmCalls } from './schema.js'
import type { PostgresDb } from './sink.js'
import type { SelectableDb } from './sink.js'

/** Rows per `DELETE` statement of {@link purgeLlmCallPayloads}. */
const DEFAULT_PURGE_BATCH = 5000

/** Rows of a statement result, whichever shape the driver returns. */
function resultRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>
  return ((result as { rows?: unknown }).rows ?? []) as Array<Record<string, unknown>>
}

/**
 * Deletes every stored payload written before `olderThan`, in bounded batches,
 * and returns how many rows it deleted. The `llm_calls` rows are not touched.
 *
 * The library never deletes on its own: payloads can hold customer data, and how
 * long to keep them is the host's decision. Run this on a schedule (a daily job
 * with `olderThan` of now minus your retention is typical). Each statement
 * deletes at most `batchSize` rows (default 5,000; the `created_at` index finds
 * them, the primary key deletes them) and returns a count, never the ids, so a
 * large backlog neither holds a long lock nor loads rows into memory. The loop
 * stops when a batch comes back short. Rerun after a failure; deleting is
 * idempotent.
 *
 * @throws LlmError `bad_request` when `olderThan` is not a valid `Date` or
 *   `batchSize` is not a positive integer.
 */
export async function purgeLlmCallPayloads(
  db: PostgresDb,
  options: { olderThan: Date; batchSize?: number },
): Promise<number> {
  const { olderThan, batchSize = DEFAULT_PURGE_BATCH } = options
  if (!(olderThan instanceof Date) || Number.isNaN(olderThan.getTime())) {
    throw new LlmError('purgeLlmCallPayloads: olderThan must be a valid Date.', {
      kind: 'bad_request',
      retryable: false,
      issues: [{ path: 'olderThan', message: 'must be a valid Date.' }],
    })
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000_000) {
    throw new LlmError(
      'purgeLlmCallPayloads: batchSize must be an integer from 1 to 1,000,000.',
      {
        kind: 'bad_request',
        retryable: false,
        issues: [
          { path: 'batchSize', message: 'must be an integer from 1 to 1,000,000.' },
        ],
      },
    )
  }
  let deleted = 0
  for (;;) {
    const result = await db.execute(sql`
      WITH batch AS (
        SELECT ${llmCallPayloads.attemptId} AS attempt_id
          FROM ${llmCallPayloads}
         WHERE ${llmCallPayloads.createdAt} < ${olderThan}
         LIMIT ${batchSize}
      ), gone AS (
        DELETE FROM ${llmCallPayloads}
         WHERE ${llmCallPayloads.attemptId} IN (SELECT attempt_id FROM batch)
        RETURNING 1
      )
      SELECT count(*)::int AS n FROM gone`)
    const n = Number(resultRows(result)[0]?.['n'] ?? 0)
    deleted += n
    if (n < batchSize) return deleted
  }
}

/** Call ids per statement: well under any driver's bind-parameter limit. */
const DELETE_CHUNK = 1000

/**
 * Deletes the stored payloads of the given calls, and returns how many rows it
 * deleted. The `llm_calls` rows are not touched.
 *
 * There is deliberately no delete by `externalId`: it is host-supplied, not
 * unique, and can repeat across tenants. Resolve a tenant's calls through your
 * own scoping (for example the tenant id you put in `metadata`), select their
 * `call_id`s, and pass them here. A `callId` is minted by the engine and is
 * globally unique, so this cannot touch another call. An unknown id deletes
 * nothing.
 *
 * Large lists run as several statements of up to 1000 ids; rerun the same list
 * after a failure, deleting is idempotent.
 *
 * @throws LlmError `bad_request` when `callIds` is not an array of non-empty strings.
 */
export async function deleteLlmCallPayloads(
  db: PostgresDb,
  options: { callIds: readonly string[] },
): Promise<number> {
  const { callIds } = options
  // An index loop, not `.some`: `some` skips the holes of a sparse array.
  let valid = Array.isArray(callIds)
  for (let i = 0; valid && i < callIds.length; i += 1) {
    const id: unknown = callIds[i]
    valid = typeof id === 'string' && id.length > 0
  }
  if (!valid) {
    throw new LlmError(
      'deleteLlmCallPayloads: callIds must be an array of non-empty strings.',
      {
        kind: 'bad_request',
        retryable: false,
        issues: [{ path: 'callIds', message: 'must be an array of non-empty strings.' }],
      },
    )
  }
  let deleted = 0
  for (let i = 0; i < callIds.length; i += DELETE_CHUNK) {
    const chunk = callIds.slice(i, i + DELETE_CHUNK)
    const rows = await db
      .delete(llmCallPayloads)
      .where(
        inArray(
          llmCallPayloads.attemptId,
          db
            .select({ attemptId: llmCalls.attemptId })
            .from(llmCalls)
            .where(inArray(llmCalls.callId, chunk)),
        ),
      )
      .returning({ attemptId: llmCallPayloads.attemptId })
    deleted += rows.length
  }
  return deleted
}

/**
 * Checks that `llm_call_payloads` exists with every column the sink writes,
 * without writing anything (a `SELECT ... LIMIT 0`). Like
 * `assertLlmCallsSchema`, it is the explicit way to find out before a payload
 * insert starts failing: a missing table makes every payload insert fail (the
 * ledger rows still commit, and each failure is logged as
 * `llm.call.payload.failed`). Call it at deploy, in CI, or at boot when you set
 * `ClientConfig.payloads`.
 *
 * @throws Error when the select fails; the message points at `sql/upgrades/`.
 */
export async function assertLlmCallPayloadsSchema(db: SelectableDb): Promise<void> {
  try {
    await db.select().from(llmCallPayloads).limit(0)
  } catch (cause) {
    throw new Error(
      'llm_call_payloads could not be read with every column @gullabs/drizzle writes. ' +
        'Apply @gullabs/drizzle/sql/upgrades/0003-llm-call-payloads.sql (or sql/install.sql on a ' +
        `fresh database) before enabling ClientConfig.payloads. Driver error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }
}
