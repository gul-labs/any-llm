/**
 * FakeAdapter — port-level fake for engine integration tests.
 *
 * Operates at the {@link ProviderAdapter} level (not the SDK level),
 * letting tests drive the engine pipeline without any provider SDK or
 * network dependency.
 *
 * @module
 */

import type {
  ProviderAdapter,
  ResolvedRequest,
  AdapterCtx,
  AdapterResult,
  Scheduler,
} from '@gullabs/core'

import { PLATFORM_SCHEDULER } from './platform-scheduler.js'

// ---------------------------------------------------------------------------
// FakeAdapter script entry
// ---------------------------------------------------------------------------

/**
 * A scripted response entry for {@link FakeAdapter}.
 *
 * - {@link AdapterResult}: the adapter returns this as a success response.
 * - `Error`: the adapter throws it (goes through engine's `classifyError`). Use
 *   the factories in `errors.ts` (`fakeHttpError`, `fakeProviderError`, ...) for
 *   the shapes real SDKs throw.
 *
 * Anything else (a plain object such as `{ status: 429 }`, a result that lacks
 * `model`, `usage` or `message`) is a mistake in the test and is rejected with a
 * `TypeError` when the adapter is built, never turned into a thrown value.
 */
export type FakeAdapterEntry = AdapterResult | Error

/**
 * Internal discriminated-union queue entry.
 */
export type QueueEntry =
  { kind: 'result'; result: AdapterResult } | { kind: 'throw'; error: unknown }

/**
 * Throw when a result-shaped scripted entry lacks the required assistant
 * `message`. Shared with the signal-aware fake; not part of the public surface.
 */
export function assertResultHasMessage(entry: Record<string, unknown>): void {
  const message = entry['message'] as
    { role?: unknown; parts?: unknown } | null | undefined
  if (
    typeof message !== 'object' ||
    message === null ||
    message.role !== 'assistant' ||
    !Array.isArray(message.parts)
  ) {
    throw new TypeError(
      'a scripted result entry needs `message` ({ role: "assistant", parts }); AdapterResult.message is required and is never rebuilt from text.',
    )
  }
}

/**
 * Classify one scripted entry, or throw `TypeError` naming `where`.
 *
 * An entry is an {@link AdapterResult} only when `model` is a non-empty string,
 * `usage` is a non-null object and `message` is an assistant message. An
 * `Error` instance is a scripted throw. Everything else is rejected.
 * Shared with the signal-aware fake; not part of the public surface.
 */
export function classifyEntry(entry: unknown, where: string): QueueEntry {
  if (entry instanceof Error) {
    return { kind: 'throw', error: entry }
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new TypeError(
      `${where} must be an Error or an AdapterResult, got ${entry === null ? 'null' : typeof entry}.`,
    )
  }
  const e = entry as Record<string, unknown>
  const hasModel = typeof e['model'] === 'string' && e['model'].length > 0
  const hasUsage = typeof e['usage'] === 'object' && e['usage'] !== null
  if (!hasModel || !hasUsage) {
    const missing = [
      ...(hasModel ? [] : ['a non-empty `model`']),
      ...(hasUsage ? [] : ['a `usage` object']),
    ].join(' and ')
    throw new TypeError(
      `${where} must be an Error or an AdapterResult (a non-empty \`model\`, a \`usage\` object and an assistant \`message\`); it lacks ${missing}. A plain object is never thrown as an error: build one with a factory from '@gullabs/testing' (fakeHttpError, fakeProviderError, ...) or pass an Error.`,
    )
  }
  assertResultHasMessage(e)
  return { kind: 'result', result: entry as AdapterResult }
}

// ---------------------------------------------------------------------------
// FakeAdapter
// ---------------------------------------------------------------------------

/**
 * A scriptable {@link ProviderAdapter} for engine integration tests.
 *
 * Supply a single response (used for every call) or an array of responses
 * (consumed in order; the last entry is repeated when exhausted).
 *
 * Every received {@link ResolvedRequest} is pushed to `calls` for assertion.
 *
 * @example
 * ```ts
 * const adapter = new FakeAdapter('google', successResult)
 * const client = createClient({ adapters: [adapter] })
 * await client.generate({ provider: 'google', model: 'gemini-2.5-pro', messages })
 *
 * const adapter2 = new FakeAdapter('google', [
 *   successResult,
 *   fakeHttpError(429),  // engine classifies as rate_limited
 * ])
 *
 * // Slow adapter for timeout tests; the delay runs on the client's scheduler,
 * // so a FakeClock passed as `scheduler` makes it instant and deterministic:
 * const slow = new FakeAdapter('google', successResult, { delayMs: 200 })
 * ```
 */
export class FakeAdapter implements ProviderAdapter {
  /** Provider identifier — must match the routing key used in tests. */
  readonly id: string

  /** All {@link ResolvedRequest} objects received by this adapter, in order. */
  readonly calls: ResolvedRequest[] = []

  private readonly _entries: QueueEntry[]

  /**
   * Optional artificial delay before returning/throwing, in milliseconds, on
   * the client's `scheduler`. Use `timeoutMs < delayMs` in the client config to
   * test timeout behaviour.
   */
  private readonly _delayMs: number

  /**
   * @param id - Provider ID (e.g. `'google'`).
   * @param entries - One or more scripted responses consumed sequentially;
   *   the last entry repeats when the list is exhausted.
   * @param opts.delayMs - Artificial per-call delay in milliseconds (default 0).
   */
  constructor(
    id: string,
    entries: FakeAdapterEntry | FakeAdapterEntry[],
    opts?: { delayMs?: number },
  ) {
    this.id = id
    const raw: unknown[] = Array.isArray(entries) ? entries : [entries]
    if (raw.length === 0) {
      throw new TypeError('FakeAdapter needs at least one scripted entry.')
    }
    this._entries = raw.map((entry, i) => classifyEntry(entry, `FakeAdapter entry ${i}`))
    this._delayMs = opts?.delayMs ?? 0
  }

  async run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult> {
    this.calls.push(req)

    if (this._delayMs > 0) {
      // The client's scheduler (a FakeClock in a deterministic test); real
      // timers only when the adapter is called outside the engine.
      const scheduler: Scheduler = ctx.scheduler ?? PLATFORM_SCHEDULER
      await new Promise<void>((resolve) => {
        scheduler.setTimeout(resolve, this._delayMs)
      })
    }

    // Pick entry: sequential, clamped to last when exhausted.
    const idx = Math.min(this.calls.length - 1, this._entries.length - 1)
    const entry: QueueEntry | undefined = this._entries[idx]

    if (entry === undefined) {
      // Should never happen since _entries is guaranteed non-empty.
      throw new Error('FakeAdapter: no entries configured')
    }

    if (entry.kind === 'result') {
      return entry.result
    }

    throw entry.error
  }
}
