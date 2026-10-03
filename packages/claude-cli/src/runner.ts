/**
 * ClaudeCliRunner — the process-execution seam for @gullabs/claude-cli.
 *
 * Adapters depend on the {@link ClaudeCliRunner} interface only.
 * {@link buildClaudeCliRunner} is the sole factory that touches
 * `node:child_process`; adapter tests inject a hand-written fake, and the
 * runner's own tests spawn only the current Node executable, so no real
 * `claude` subprocess is ever spawned in CI.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/**
 * Most stdout the runner buffers: 32 MiB. A call that prints more is killed and
 * rejected, so a runaway process cannot exhaust the host's memory. stderr is
 * diagnostic only: the runner keeps its last {@link MAX_STDERR_CHARS}.
 */
export const MAX_STDOUT_BYTES = 32 * 1024 * 1024

/** Most stderr text kept (the tail); the adapter only reads its end. */
export const MAX_STDERR_CHARS = 1024 * 1024

/**
 * The result of a single `claude` CLI invocation.
 */
export interface ClaudeCliRunResult {
  stdout: string
  stderr: string
  exitCode: number | null
}

/**
 * Options accepted by {@link ClaudeCliRunner.run}.
 */
export interface ClaudeCliRunOptions {
  /** Working directory for the subprocess (the adapter owns tmpdir lifecycle). */
  cwd: string
  /** Kill the subprocess if it has not exited within this many milliseconds. */
  timeoutMs?: number
  /** Kill the subprocess if this signal fires. */
  signal?: AbortSignal
}

/**
 * The process-execution seam consumed by {@link claudeCliAdapter}.
 *
 * Implementations run the `claude` binary with `args`, write `input` to its
 * stdin (the rendered prompt), and resolve with captured stdout/stderr/exit
 * code. Implementations must never throw for a non-zero exit code — that is
 * the adapter's error-classification job; the one exception is a spawn-time
 * failure (e.g. `ENOENT` when the binary is missing), which should reject.
 */
export interface ClaudeCliRunner {
  run(
    args: string[],
    input: string,
    opts: ClaudeCliRunOptions,
  ): Promise<ClaudeCliRunResult>
}

/**
 * Build the real {@link ClaudeCliRunner}, backed by `node:child_process`.
 *
 * The adapter tests inject a hand-written fake; `runner.test.ts` runs this
 * factory against the current Node executable (no `claude` binary needed).
 *
 * The child leads its own process group, and a timeout, abort or output-cap
 * kill signals the whole group, so a grandchild holding the pipes cannot keep a
 * call hung. A host that is interrupted (Ctrl-C) does not forward the signal to
 * the CLI, which then runs to its own timeout.
 *
 * @param claudePath - Path or bare command name for the `claude` binary.
 *   Defaults to `'claude'`, resolved via `PATH`.
 */
export function buildClaudeCliRunner(claudePath = 'claude'): ClaudeCliRunner {
  return {
    run(args, input, opts) {
      return new Promise((resolve, reject) => {
        if (opts.signal?.aborted === true) {
          const err = new Error('claude-cli call aborted')
          err.name = 'AbortError'
          reject(err)
          return
        }

        // NOTE: the argv itself (including the `--safe-mode` vs `--bare`
        // choice) is owned by the adapter (see adapter.ts) — this runner is
        // a dumb pipe. We repeat the rule here only as a pointer: never pass
        // `--bare`, it disables OAuth/keychain auth.
        // `detached` makes the child the leader of its own process group, so a
        // kill reaches every process it started (a grandchild that inherited
        // the pipes would otherwise hold `close` open past the timeout or the
        // output cap). Not on Windows, which has no process groups.
        const child = spawn(claudePath, args, {
          cwd: opts.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        })

        // Chunks can split a multibyte UTF-8 character, so each stream keeps
        // a decoder that holds the partial bytes until the rest arrives.
        const stdoutDecoder = new StringDecoder('utf8')
        const stderrDecoder = new StringDecoder('utf8')
        let stdout = ''
        let stdoutBytes = 0
        let stderr = ''
        let settled = false
        // Set once a timeout/abort has begun killing the child. The
        // returned promise is NOT rejected with this until the child's
        // 'close' event actually fires — the caller (the adapter) must
        // never observe settlement while the OS process may still be
        // alive and writing to its scratch cwd.
        let pendingError: Error | undefined
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined
        let killTimeoutHandle: ReturnType<typeof setTimeout> | undefined

        const cleanupTimers = (): void => {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
          if (killTimeoutHandle !== undefined) clearTimeout(killTimeoutHandle)
        }

        const cleanup = (): void => {
          cleanupTimers()
          if (opts.signal !== undefined) {
            opts.signal.removeEventListener('abort', onAbort)
          }
        }

        // Signals the whole process group (`-pid`), falling back to the child
        // alone where that is not possible.
        const signalTree = (signal: 'SIGTERM' | 'SIGKILL'): void => {
          if (process.platform !== 'win32' && child.pid !== undefined) {
            try {
              process.kill(-child.pid, signal)
              return
            } catch {
              // The group is gone or was never made; signal the child below.
            }
          }
          child.kill(signal)
        }

        const killChild = (): void => {
          signalTree('SIGTERM')
          killTimeoutHandle = setTimeout(() => {
            signalTree('SIGKILL')
            // A process that left the group can still hold the pipes: closing
            // our ends lets `close` fire without waiting for it.
            child.stdout.destroy()
            child.stderr.destroy()
          }, 5_000)
        }

        const beginReject = (err: Error): void => {
          if (settled || pendingError !== undefined) return
          pendingError = err
          cleanupTimers()
          killChild()
        }

        const onAbort = (): void => {
          const err = new Error('claude-cli call aborted')
          err.name = 'AbortError'
          beginReject(err)
        }

        // The pre-aborted case is handled above, before `spawn` — by this
        // point `opts.signal`, if present, is guaranteed not yet aborted.
        if (opts.signal !== undefined) {
          opts.signal.addEventListener('abort', onAbort, { once: true })
        }

        if (opts.timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            const err = new Error(`claude-cli call exceeded ${opts.timeoutMs}ms timeout`)
            err.name = 'TimeoutError'
            beginReject(err)
          }, opts.timeoutMs)
        }

        child.stdout.on('data', (chunk: Buffer) => {
          // Once a kill is under way the output no longer matters.
          if (pendingError !== undefined) return
          stdoutBytes += chunk.length
          if (stdoutBytes > MAX_STDOUT_BYTES) {
            const err = new Error(
              `claude-cli stdout exceeded ${MAX_STDOUT_BYTES} bytes; the process was killed`,
            )
            err.name = 'OutputLimitError'
            beginReject(err)
            return
          }
          stdout += stdoutDecoder.write(chunk)
        })
        child.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + stderrDecoder.write(chunk)).slice(-MAX_STDERR_CHARS)
        })

        // A CLI that exits before reading its stdin (a bad flag, expired auth)
        // makes the write fail with EPIPE. Without a listener that stream
        // error is unhandled and crashes the host process; the exit code and
        // stderr already carry the real failure.
        child.stdin.on('error', () => {})

        child.once('error', (err) => {
          if (settled) return
          settled = true
          cleanup()
          reject(pendingError ?? err)
        })

        child.once('close', (exitCode) => {
          if (settled) return
          settled = true
          cleanup()
          if (pendingError !== undefined) {
            reject(pendingError)
          } else {
            stdout += stdoutDecoder.end()
            stderr = (stderr + stderrDecoder.end()).slice(-MAX_STDERR_CHARS)
            resolve({ stdout, stderr, exitCode })
          }
        })

        child.stdin.end(input, 'utf8')
      })
    },
  }
}
