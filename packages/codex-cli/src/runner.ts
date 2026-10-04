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

import { buildChildEnv } from './env.js'

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

/** Options accepted by {@link CodexCliRunner.run}. */
export interface CodexCliRunOptions {
  /**
   * Working directory for the subprocess (also the directory passed as `-C` in the
   * adapter's argv).
   */
  cwd: string
  /**
   * Wall-clock ceiling; the runner sends `SIGTERM` on expiry and follows up with
   * `SIGKILL` if the process has not exited shortly after.
   */
  timeoutMs?: number
  /** Caller abort signal; same SIGTERM then SIGKILL semantics as a timeout expiry. */
  signal?: AbortSignal
  /**
   * Variables added to (and winning over) the allowlisted environment the child
   * gets. The host's own environment is not passed on whole; see `env.ts`.
   */
  env?: Readonly<Record<string, string>>
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
   * @param opts - See {@link CodexCliRunOptions}.
   */
  run(args: string[], input: string, opts: CodexCliRunOptions): Promise<CodexCliRunResult>
}

// ---------------------------------------------------------------------------
// Real implementation (exercised by runner.test.ts against the Node executable)
// ---------------------------------------------------------------------------

/** Grace period between SIGTERM and the SIGKILL follow-up, in milliseconds. */
const SIGKILL_GRACE_MS = 5_000

/**
 * Build the real {@link CodexCliRunner}, backed by `node:child_process.spawn`.
 *
 * The child's environment is an allowlisted copy of `process.env` plus
 * `opts.env` (see `env.ts`): `CODEX_API_KEY`, `OPENAI_API_KEY` and the
 * provider-routing variables are not passed on, so the saved login is what the CLI
 * uses. When the leader closes after a timeout, abort or output-cap kill, the group
 * gets one more SIGKILL, so a member that ignored SIGTERM and holds no pipe does
 * not outlive the call.
 *
 * @param codexPath - Path (or bare command name resolved via `PATH`) to the
 *   `codex` binary. Defaults to `'codex'`.
 */
export function createCodexCliRunner(codexPath = 'codex'): CodexCliRunner {
  return {
    run(args, input, opts) {
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
          env: buildChildEnv(process.env, opts.env, process.platform === 'win32'),
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

        // One SIGKILL for the group, after the leader has closed. The grace timer is
        // cancelled by `close`, so without this a group member that ignores SIGTERM
        // and holds none of our pipes would never be killed. ESRCH (the group is
        // already empty) is the normal outcome.
        const sweepGroup = (): void => {
          if (process.platform === 'win32' || child.pid === undefined) return
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            // Nothing left in the group.
          }
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
            sweepGroup()
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
