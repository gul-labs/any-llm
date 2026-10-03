/**
 * CodexCliRunner — subprocess seam for shelling out to the `codex` CLI.
 *
 * This module defines the structural interface the adapter depends on.  The
 * real `node:child_process`-backed implementation is isolated in
 * {@link createCodexCliRunner} so committed tests can inject a fake runner
 * and NEVER spawn the real `codex` binary.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

// ---------------------------------------------------------------------------
// CodexCliRunner — structural interface
// ---------------------------------------------------------------------------

/**
 * Most stdout the runner buffers: 32 MiB. A call that prints more is killed and
 * rejected, so a runaway process cannot exhaust the host's memory. stderr is
 * diagnostic only: the runner keeps its last {@link MAX_STDERR_CHARS}.
 */
export const MAX_STDOUT_BYTES = 32 * 1024 * 1024

/** Most stderr text kept (the tail); the adapter only reads its end. */
export const MAX_STDERR_CHARS = 1024 * 1024

/** Result of a single `codex` CLI invocation. */
export interface CodexCliRunResult {
  /** Captured stdout (the JSONL event stream). */
  stdout: string
  /** Captured stderr. */
  stderr: string
  /** Process exit code, or `null` if the process was killed by a signal. */
  exitCode: number | null
}

/**
 * Structural seam over a `codex` CLI subprocess invocation.
 *
 * Satisfied by the real implementation returned from
 * {@link createCodexCliRunner}, or by a hand-rolled fake in tests.
 */
export interface CodexCliRunner {
  /**
   * Run the `codex` binary with the given argv and stdin, resolving with the
   * captured stdout/stderr/exitCode once the process exits.
   *
   * @param args - Full argv (excluding the binary path itself).
   * @param input - Data written to stdin, then the stream is closed. The
   *   codex-cli adapter passes the rendered prompt here and `-` as the
   *   positional argument, so a large prompt is never an argv entry (Linux
   *   caps one argument at 128 KiB).
   * @param opts.cwd - Working directory for the subprocess (also the
   *   directory passed as `-C` in the adapter's argv).
   * @param opts.timeoutMs - Optional wall-clock ceiling; the runner sends
   *   `SIGTERM` on expiry and follows up with `SIGKILL` if the process has
   *   not exited shortly after.
   * @param opts.signal - Optional caller abort signal; same
   *   SIGTERM→SIGKILL semantics as a timeout expiry.
   */
  run(
    args: string[],
    input: string,
    opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<CodexCliRunResult>
}

// ---------------------------------------------------------------------------
// Real implementation (exercised by runner.test.ts against the Node executable)
// ---------------------------------------------------------------------------

/** Grace period between SIGTERM and the SIGKILL follow-up, in milliseconds. */
const SIGKILL_GRACE_MS = 5_000

/**
 * Build the real {@link CodexCliRunner}, backed by `node:child_process.spawn`.
 *
 * @param codexPath - Path (or bare command name resolved via `PATH`) to the
 *   `codex` binary. Defaults to `'codex'`.
 */
export function createCodexCliRunner(codexPath = 'codex'): CodexCliRunner {
  return {
    run(
      args: string[],
      input: string,
      opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
    ): Promise<CodexCliRunResult> {
      return new Promise((resolve, reject) => {
        // Mirror claude-cli's runner: never spawn a subprocess for a call
        // whose signal is already aborted.
        if (opts.signal?.aborted === true) {
          const err = new Error('codex-cli call aborted')
          err.name = 'AbortError'
          reject(err)
          return
        }

        // `detached` makes the child the leader of its own process group, so a
        // kill reaches every process it started (a grandchild that inherited
        // the pipes would otherwise hold `close` open past the timeout or the
        // output cap). Not on Windows, which has no process groups. A host that
        // is interrupted (Ctrl-C) does not forward the signal to the CLI, which
        // then runs to its own timeout.
        const child = spawn(codexPath, args, {
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
        let killTimer: ReturnType<typeof setTimeout> | undefined
        let hardKillTimer: ReturnType<typeof setTimeout> | undefined

        const cleanupTimers = (): void => {
          if (killTimer !== undefined) clearTimeout(killTimer)
          if (hardKillTimer !== undefined) clearTimeout(hardKillTimer)
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

        const terminate = (): void => {
          if (settled) return
          signalTree('SIGTERM')
          hardKillTimer = setTimeout(() => {
            if (settled) return
            signalTree('SIGKILL')
            // A process that left the group can still hold the pipes: closing
            // our ends lets `close` fire without waiting for it.
            child.stdout.destroy()
            child.stderr.destroy()
          }, SIGKILL_GRACE_MS)
        }

        const beginReject = (err: Error): void => {
          if (settled || pendingError !== undefined) return
          pendingError = err
          cleanupTimers()
          terminate()
        }

        if (opts.timeoutMs !== undefined) {
          killTimer = setTimeout(() => {
            const err = new Error(`codex-cli call exceeded ${opts.timeoutMs}ms timeout`)
            err.name = 'TimeoutError'
            beginReject(err)
          }, opts.timeoutMs)
        }

        const onAbort = (): void => {
          const err = new Error('codex-cli call aborted')
          err.name = 'AbortError'
          beginReject(err)
        }
        if (opts.signal !== undefined) {
          opts.signal.addEventListener('abort', onAbort, { once: true })
        }

        child.stdout.on('data', (chunk: Buffer) => {
          // Once a kill is under way the output no longer matters.
          if (pendingError !== undefined) return
          stdoutBytes += chunk.length
          if (stdoutBytes > MAX_STDOUT_BYTES) {
            const err = new Error(
              `codex-cli stdout exceeded ${MAX_STDOUT_BYTES} bytes; the process was killed`,
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

        child.on('error', (err) => {
          if (settled) return
          settled = true
          cleanupTimers()
          if (opts.signal !== undefined) {
            opts.signal.removeEventListener('abort', onAbort)
          }
          reject(pendingError ?? err)
        })

        child.on('close', (code) => {
          if (settled) return
          settled = true
          cleanupTimers()
          if (opts.signal !== undefined) {
            opts.signal.removeEventListener('abort', onAbort)
          }
          if (pendingError !== undefined) {
            reject(pendingError)
          } else {
            stdout += stdoutDecoder.end()
            stderr = (stderr + stderrDecoder.end()).slice(-MAX_STDERR_CHARS)
            resolve({ stdout, stderr, exitCode: code })
          }
        })

        child.stdin.end(input, 'utf8')
      })
    },
  }
}
