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
} from '@gullabs/core'

// ---------------------------------------------------------------------------
// FakeAdapter script entry
// ---------------------------------------------------------------------------

/**
 * A scripted response entry for {@link FakeAdapter}.
 *
 * - {@link AdapterResult}: the adapter returns this as a success response.
 * - `Error`: the adapter throws it (goes through engine's `classifyError`).
 * - Plain object (e.g. `{ status: 429 }`): thrown as-is; `classifyError`
 *   extracts the HTTP status for classification.
 */
export type FakeAdapterEntry = AdapterResult | Error | Record<string, unknown>

/**
 * Internal discriminated-union queue entry.
 * Normalised at enqueue time so `run()` never mis-classifies a plain-object
 * error that happens to carry a `usage` key (e.g. `{ status: 429, usage: null }`).
 */
type QueueEntry =
  { kind: 'result'; result: AdapterResult } | { kind: 'throw'; error: unknown }

/**
 * Normalise a public {@link FakeAdapterEntry} into an internal {@link QueueEntry}.
 *
 * An entry is a genuine {@link AdapterResult} only when **both**:
 * - `model` is a non-empty string, and
 * - `usage` is a non-null object.
 *
 * Such an entry must also carry the required `message` (an assistant message,
 * as every adapter returns); one without it is a mistake in the test and is
 * rejected with a `TypeError` instead of being completed.
 *
 * Everything else (including `Error` instances and plain HTTP-style objects
 * such as `{ status: 429, usage: null }`) is treated as a throw.
 */
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

function normalizeEntry(entry: FakeAdapterEntry): QueueEntry {
  if (entry instanceof Error) {
    return { kind: 'throw', error: entry }
  }
  const e = entry as Record<string, unknown>
  if (
    typeof e['model'] === 'string' &&
    typeof e['usage'] === 'object' &&
    e['usage'] !== null
  ) {
    assertResultHasMessage(e)
    return { kind: 'result', result: entry as AdapterResult }
  }
  return { kind: 'throw', error: entry }
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
 *   { status: 429 },  // engine classifies as rate_limited
 * ])
 *
 * // Slow adapter for timeout tests:
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
   * Optional artificial delay before returning/throwing, in milliseconds.
   * Use `timeoutMs < delayMs` in the client config to test timeout behaviour.
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
    const raw = Array.isArray(entries) ? entries : [entries]
    this._entries = raw.map(normalizeEntry)
    this._delayMs = opts?.delayMs ?? 0
  }

  async run(req: ResolvedRequest, _ctx: AdapterCtx): Promise<AdapterResult> {
    this.calls.push(req)

    if (this._delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this._delayMs))
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
