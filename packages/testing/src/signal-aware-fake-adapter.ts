/**
 * SignalAwareFakeAdapter — a signal-cooperative {@link ProviderAdapter} fake.
 *
 * Unlike {@link FakeAdapter}, this adapter actively listens to `ctx.signal` and
 * rejects with an `AbortError` when the signal fires, simulating a cooperative
 * provider SDK.  Tests use it to verify:
 *
 * 1. Caller abort terminates the call with `kind:'aborted'` and the adapter
 *    observed the signal.
 * 2. Timeout with a synchronously-aborting adapter is still classified
 *    `kind:'timeout'` (not `'aborted'`) — the engine's ordering guarantee.
 * 3. Non-cooperative adapters time out correctly (covered by {@link FakeAdapter}).
 *
 * @module
 */

import type {
  ProviderAdapter,
  ResolvedRequest,
  AdapterCtx,
  AdapterResult,
  Scheduler,
  TimerHandle,
} from '@gullabs/core'

import { PLATFORM_SCHEDULER } from './platform-scheduler.js'
import { classifyEntry } from './fake-adapter.js'
import type { FakeAdapterEntry } from './fake-adapter.js'

// ---------------------------------------------------------------------------
// SignalAwareFakeAdapter
// ---------------------------------------------------------------------------

/**
 * Options for {@link SignalAwareFakeAdapter}.
 */
export interface SignalAwareFakeAdapterOptions {
  /**
   * Artificial per-call delay before resolving the scripted result, in
   * milliseconds on the client's `scheduler`.  The signal is observed during this delay.  Default: `200`.
   */
  delayMs?: number
  /**
   * When `true`, the adapter rejects with `AbortError` **synchronously** within
   * the same microtask as the signal dispatch — before returning control to the
   * event loop.  This stress-tests the engine's ordering guarantee: even in this
   * adversarial mode, a timeout should still surface as `kind:'timeout'` (not
   * `'aborted'`).
   *
   * When `false` (default), the abort rejection is queued asynchronously via
   * a resolved Promise chain.
   */
  abortsSynchronouslyOnSignal?: boolean
}

/**
 * A signal-cooperative {@link ProviderAdapter} for engine integration tests.
 *
 * Listens to `ctx.signal` and rejects with an `AbortError` when the signal
 * fires.  Records whether the abort was observed, regardless of whether the
 * engine terminated the call before the adapter finished.
 *
 * @example
 * ```ts
 * const adapter = new SignalAwareFakeAdapter('google', successResult, {
 *   delayMs: 500,
 *   abortsSynchronouslyOnSignal: true, // stress-test timeout determinism
 * })
 * const ctrl = new AbortController()
 * clock.setTimeout(() => ctrl.abort(), 50) // a FakeClock passed as the client's `scheduler`
 * await expect(
 *   client.generate({
 *     provider: 'google',
 *     model: 'gemini-2.5-pro',
 *     messages,
 *     signal: ctrl.signal,
 *   }),
 * ).rejects.toMatchObject({ kind: 'aborted' })
 * expect(adapter.abortObserved).toBe(true)
 * ```
 */
export class SignalAwareFakeAdapter implements ProviderAdapter {
  /** Provider identifier — must match the routing key used in tests. */
  readonly id: string

  /** All {@link ResolvedRequest} objects received by this adapter, in order. */
  readonly calls: ResolvedRequest[] = []

  /**
   * Set to `true` once the adapter has observed an abort signal on `ctx.signal`.
   * Remains `true` for the lifetime of the instance; reset manually when needed.
   */
  abortObserved = false

  private readonly _entry: FakeAdapterEntry
  private readonly _delayMs: number
  private readonly _abortsSynchronouslyOnSignal: boolean

  /**
   * @param id - Provider ID (e.g. `'google'`).
   * @param entry - The scripted success result or error to return when the call
   *   completes normally (without abort).
   * @param opts - Optional configuration (see {@link SignalAwareFakeAdapterOptions}).
   */
  constructor(id: string, entry: FakeAdapterEntry, opts?: SignalAwareFakeAdapterOptions) {
    this.id = id
    classifyEntry(entry, 'SignalAwareFakeAdapter entry')
    this._entry = entry
    this._delayMs = opts?.delayMs ?? 200
    this._abortsSynchronouslyOnSignal = opts?.abortsSynchronouslyOnSignal ?? false
  }

  /**
   * Execute the scripted call, honouring `ctx.signal` for cooperative
   * cancellation.
   *
   * If the signal fires before `delayMs` elapses, the call rejects with an
   * `AbortError` (name `'AbortError'`).  If `abortsSynchronouslyOnSignal` is
   * `true`, this rejection is scheduled synchronously within the abort handler,
   * before returning to the event loop.
   */
  run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult> {
    this.calls.push(req)
    const signal = ctx.signal
    const scheduler: Scheduler = ctx.scheduler ?? PLATFORM_SCHEDULER
    const abortsSynchronously = this._abortsSynchronouslyOnSignal
    const self = this

    return new Promise<AdapterResult>((resolve, reject) => {
      let settled = false
      let timerId: TimerHandle | undefined

      /** Settle the promise at most once. */
      const settle = (fn: () => void): void => {
        if (!settled) {
          settled = true
          fn()
        }
      }

      /** Called when the abort signal fires. */
      const onAbort = (): void => {
        // Cancel the delay timer to avoid double-settlement.
        if (timerId !== undefined) {
          scheduler.clearTimeout(timerId)
          timerId = undefined
        }
        self.abortObserved = true

        // Build a DOM-compatible AbortError.
        const abortErr = Object.assign(new Error('The operation was aborted'), {
          name: 'AbortError',
        })

        if (abortsSynchronously) {
          // Synchronous path — reject in the same microtask as the signal dispatch.
          // This is the adversarial scenario that tests the engine's ordering guarantee
          // (timeout reject-first strategy must win even against this).
          settle(() => {
            reject(abortErr)
          })
        } else {
          // Async path — queue the rejection via a resolved-promise microtask so
          // the abort is observed but does not race synchronously.
          Promise.resolve()
            .then(() => {
              settle(() => {
                reject(abortErr)
              })
            })
            .catch(() => {
              /* settled flag prevents double-rejection */
            })
        }
      }

      // Attach abort listener (or short-circuit if already aborted).
      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }

      // Schedule the scripted result after delayMs.
      timerId = scheduler.setTimeout(() => {
        timerId = undefined
        // Remove abort listener — the delay elapsed without abort.
        if (signal !== undefined) {
          signal.removeEventListener('abort', onAbort)
        }

        const entry = this._entry
        if (entry instanceof Error) {
          settle(() => {
            reject(entry)
          })
        } else {
          settle(() => {
            resolve(entry)
          })
        }
      }, this._delayMs)
    })
  }
}
