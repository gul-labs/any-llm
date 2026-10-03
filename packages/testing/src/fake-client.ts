/**
 * FakeClient — a scripted {@link Client} for host tests that need no engine.
 *
 * Use it where host code takes a `Client`: it records every request the host
 * sends and answers from a script. To exercise the engine itself (retry,
 * timeout, ledger rows) use `createClient` with a `FakeAdapter` instead.
 *
 * @module
 */

import {
  classifyError,
  LlmError,
  type CallSite,
  type Client,
  type CountTokensOptions,
  type GenerateOptions,
  type LlmRequest,
  type LlmResult,
  type RunStructuredOptions,
  type TokenCount,
  type TokenCountRequest,
} from '@gullabs/core'

import { classifyAsAdapter } from './provider-errors.js'

/** A scripted answer: a result, or an `Error` to throw. */
export type FakeClientEntry = LlmResult | Error

/** One call the client received. */
export type FakeClientCall =
  | { method: 'generate'; request: LlmRequest; opts: GenerateOptions }
  | {
      method: 'runStructured'
      request: CallSite
      vars?: Record<string, string>
      opts: RunStructuredOptions
    }
  | { method: 'countTokens'; request: TokenCountRequest; opts: CountTokensOptions }

export interface FakeClientOptions {
  /**
   * Answers for `countTokens`, consumed in order (the last repeats). Without
   * it, `countTokens` throws a `TypeError`: a test that counts tokens says what
   * the count is.
   */
  countTokens?: TokenCount | Error | readonly (TokenCount | Error)[]
}

/** The `LlmResult` fields that are always present on a real result. */
const REQUIRED_RESULT_KEYS = [
  'message',
  'continuation',
  'usage',
  'model',
  'latencyMs',
  'warnings',
  'callId',
  'attemptId',
] as const

function assertEntry(entry: unknown, where: string): void {
  if (entry instanceof Error) return
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new TypeError(`${where} must be an Error or an LlmResult.`)
  }
  const missing = REQUIRED_RESULT_KEYS.filter(
    (key) => (entry as Record<string, unknown>)[key] === undefined,
  )
  if (missing.length > 0) {
    throw new TypeError(
      `${where} is not a complete LlmResult (missing ${missing.join(', ')}); build it with fakeLlmResult().`,
    )
  }
}

/** True when every field of `expected` is matched by `actual`, recursively (arrays element by element). */
function matchesSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((item, i) => matchesSubset(actual[i], item))
    )
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null) return false
    return Object.entries(expected).every(([key, value]) =>
      matchesSubset((actual as Record<string, unknown>)[key], value),
    )
  }
  return Object.is(actual, expected)
}

function pick<T>(entries: readonly T[], index: number): T {
  const entry = entries[Math.min(index, entries.length - 1)]
  if (entry === undefined) throw new Error('FakeClient: no entries configured')
  return entry
}

/**
 * A scripted {@link Client}. `generate` and `runStructured` answer from one
 * script, in call order (the last entry repeats); every call is recorded on
 * `calls`.
 *
 * Like a real `Client` it rejects only with `LlmError`: an `Error` entry is
 * classified the way the engine classifies it (`classifyError`, with the
 * original as `cause`), and one from `fakeProviderError` goes through the real
 * provider classifier first. An `LlmError` entry is thrown unchanged.
 *
 * ```ts
 * const client = new FakeClient([fakeLlmResult({ text: 'a' }), fakeHttpError(503)])
 * await hostCode(client)
 * client.expectRequest({ provider: 'google', messages: [{ role: 'user' }] })
 * ```
 */
export class FakeClient implements Client {
  /** Every call, in order, with the request exactly as the host sent it (by reference). */
  readonly calls: FakeClientCall[] = []

  private readonly _script: readonly FakeClientEntry[]
  private readonly _countTokens: readonly (TokenCount | Error)[] | undefined
  private _generated = 0
  private _counted = 0

  /**
   * @param entries - One entry for every call, or a list consumed in order
   *   (the last repeats). Each is an `Error` or a complete `LlmResult` (build
   *   it with `fakeLlmResult`); anything else is a `TypeError` here.
   */
  constructor(
    entries: FakeClientEntry | readonly FakeClientEntry[],
    opts: FakeClientOptions = {},
  ) {
    const list: readonly FakeClientEntry[] = Array.isArray(entries)
      ? (entries as readonly FakeClientEntry[])
      : [entries as FakeClientEntry]
    if (list.length === 0) {
      throw new TypeError('FakeClient needs at least one scripted entry.')
    }
    list.forEach((entry, i) => {
      assertEntry(entry, `FakeClient entry ${i}`)
    })
    this._script = list
    if (opts.countTokens !== undefined) {
      const counts: readonly (TokenCount | Error)[] = Array.isArray(opts.countTokens)
        ? (opts.countTokens as readonly (TokenCount | Error)[])
        : [opts.countTokens as TokenCount | Error]
      this._countTokens = counts
    }
  }

  generate(request: LlmRequest, opts: GenerateOptions): Promise<LlmResult> {
    this.calls.push({ method: 'generate', request, opts })
    return this._answer(opts.signal)
  }

  runStructured(callSite: CallSite, opts: RunStructuredOptions): Promise<LlmResult>
  runStructured(
    callSite: CallSite,
    vars: Record<string, string>,
    opts: RunStructuredOptions,
  ): Promise<LlmResult>
  runStructured(
    callSite: CallSite,
    varsOrOpts: Record<string, string> | RunStructuredOptions,
    maybeOpts?: RunStructuredOptions,
  ): Promise<LlmResult> {
    if (maybeOpts === undefined) {
      const opts = varsOrOpts as RunStructuredOptions
      this.calls.push({ method: 'runStructured', request: callSite, opts })
      return this._answer(opts.signal)
    }
    this.calls.push({
      method: 'runStructured',
      request: callSite,
      vars: varsOrOpts as Record<string, string>,
      opts: maybeOpts,
    })
    return this._answer(maybeOpts.signal)
  }

  countTokens(request: TokenCountRequest, opts: CountTokensOptions): Promise<TokenCount> {
    this.calls.push({ method: 'countTokens', request, opts })
    if (this._countTokens === undefined) {
      return Promise.reject(
        new TypeError(
          'FakeClient: countTokens was called but no `countTokens` answer was scripted.',
        ),
      )
    }
    const entry = pick(this._countTokens, this._counted++)
    return entry instanceof Error ? rejectClassified(entry) : Promise.resolve(entry)
  }

  /**
   * Asserts that a recorded request matches `expected`: every field in
   * `expected` must equal the request's, recursively (objects by subset, arrays
   * element by element and of equal length). Checks the most recent call unless
   * `opts.call` gives a 0-based index. Throws an `Error` showing both when it
   * does not match, or when there is no such call.
   *
   * ```ts
   * client.expectRequest({ model: 'gemini-2.5-pro', config: { temperature: 0 } })
   * client.expectRequest({ messages: [{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }] }, { call: 0 })
   * ```
   */
  expectRequest(expected: Record<string, unknown>, opts: { call?: number } = {}): void {
    const index = opts.call ?? this.calls.length - 1
    const call = this.calls[index]
    if (call === undefined) {
      throw new Error(
        `FakeClient.expectRequest: there is no call ${index} (the client received ${this.calls.length}).`,
      )
    }
    if (!matchesSubset(call.request, expected)) {
      throw new Error(
        `FakeClient.expectRequest: call ${index} (${call.method}) does not match.\nExpected (subset): ${JSON.stringify(expected, null, 2)}\nReceived: ${JSON.stringify(call.request, null, 2)}`,
      )
    }
  }

  private _answer(signal: AbortSignal | undefined): Promise<LlmResult> {
    if (signal?.aborted === true) {
      return Promise.reject(
        new LlmError('Request aborted by caller', { kind: 'aborted', retryable: false }),
      )
    }
    const entry = pick(this._script, this._generated++)
    return entry instanceof Error ? rejectClassified(entry) : Promise.resolve(entry)
  }
}

/** Rejects with what a real client rejects with for `error`: an `LlmError`. */
async function rejectClassified(error: Error): Promise<never> {
  throw classifyError(await classifyAsAdapter(error))
}
