/**
 * FakeCliRunner — a scripted process runner for the CLI providers.
 *
 * Structural: it satisfies both `ClaudeCliRunner` (`@gullabs/claude-cli`) and
 * `CodexCliRunner` (`@gullabs/codex-cli`), whose `run(args, input, opts)` seams
 * are the same, so no process is ever spawned.
 *
 * @module
 */

/** What a run resolves with, as the real runners return it. */
export interface FakeCliRunResult {
  stdout: string
  stderr: string
  /** `null` when the process was killed by a signal. */
  exitCode: number | null
}

/** The options a runner receives. */
export interface FakeCliRunOptions {
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Extra environment variables the adapter asked the runner to pass on. */
  env?: Readonly<Record<string, string>>
}

/** One recorded invocation. */
export interface FakeCliRunCall {
  args: string[]
  input: string
  opts: FakeCliRunOptions
}

/**
 * A scripted answer. `stdout` is required; `stderr` defaults to `''` and
 * `exitCode` to `0`. An `Error` rejects the run, as a spawn-time failure does
 * (`ENOENT`); a non-zero exit is a resolved result, never a rejection, as with
 * the real runners. `{ timeout: true }` rejects as a runner does when its
 * `timeoutMs` expires: an `Error` named `TimeoutError`, which the adapters map to
 * a retryable `timeout`.
 */
export type FakeCliRunEntry =
  | { stdout: string; stderr?: string; exitCode?: number | null }
  | { timeout: true }
  | Error
  | ((call: FakeCliRunCall) => FakeCliRunResult | Promise<FakeCliRunResult>)

/**
 * A scripted CLI runner. Answers come from the script in call order (the last
 * repeats) and every call is recorded on `calls`. A run whose `signal` is
 * already aborted rejects with an `AbortError` without being answered, as the
 * real runners do.
 *
 * ```ts
 * const runner = new FakeCliRunner({ stdout: JSON.stringify(envelope) })
 * const adapter = claudeCliAdapter({ runner })
 * // … run a call …
 * expect(runner.calls[0]?.args).toContain('--output-format')
 * ```
 */
export class FakeCliRunner {
  /** Every invocation, in order. */
  readonly calls: FakeCliRunCall[] = []

  private readonly _script: readonly FakeCliRunEntry[]

  constructor(entries: FakeCliRunEntry | readonly FakeCliRunEntry[]) {
    const list: readonly FakeCliRunEntry[] = Array.isArray(entries)
      ? (entries as readonly FakeCliRunEntry[])
      : [entries as FakeCliRunEntry]
    if (list.length === 0) {
      throw new TypeError('FakeCliRunner needs at least one scripted entry.')
    }
    list.forEach((entry, i) => {
      if (
        !(entry instanceof Error) &&
        typeof entry !== 'function' &&
        (typeof entry !== 'object' ||
          (typeof (entry as { stdout?: unknown }).stdout !== 'string' &&
            (entry as { timeout?: unknown }).timeout !== true))
      ) {
        throw new TypeError(
          `FakeCliRunner entry ${i} must be { stdout: string, stderr?, exitCode? }, { timeout: true }, an Error or a function.`,
        )
      }
    })
    this._script = list
  }

  async run(
    args: string[],
    input: string,
    opts: FakeCliRunOptions,
  ): Promise<FakeCliRunResult> {
    const call: FakeCliRunCall = { args, input, opts }
    this.calls.push(call)
    if (opts.signal?.aborted === true) {
      const err = new Error('cli call aborted')
      err.name = 'AbortError'
      throw err
    }
    const entry = this._script[Math.min(this.calls.length - 1, this._script.length - 1)]
    if (entry === undefined) throw new Error('FakeCliRunner: no entries configured')
    if (entry instanceof Error) throw entry
    if (typeof entry === 'function') return await entry(call)
    if ('timeout' in entry) {
      const err = new Error(`cli call exceeded ${opts.timeoutMs ?? 0}ms timeout`)
      err.name = 'TimeoutError'
      throw err
    }
    return {
      stdout: entry.stdout,
      stderr: entry.stderr ?? '',
      exitCode: entry.exitCode === undefined ? 0 : entry.exitCode,
    }
  }
}
