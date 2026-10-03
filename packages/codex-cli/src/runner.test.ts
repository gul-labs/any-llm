/**
 * @gullabs/codex-cli — real runner tests.
 *
 * Unlike adapter.test.ts (which always injects a fake `CodexCliRunner`),
 * this file exercises {@link createCodexCliRunner} itself — the one seam
 * that touches `node:child_process`. It is CI-safe with no real `codex`
 * binary on PATH: the pre-aborted-signal case uses an intentionally
 * nonexistent binary path (it must reject WITHOUT calling `spawn`), and every
 * other case uses the current Node executable running a small script.
 *
 * @module
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { MAX_STDERR_CHARS, MAX_STDOUT_BYTES, createCodexCliRunner } from './runner.js'

describe('createCodexCliRunner: pre-aborted signal', () => {
  it('rejects immediately without spawning when the signal is already aborted', async () => {
    const runner = createCodexCliRunner(
      '/nonexistent/path/to/codex-binary-that-does-not-exist',
    )
    const controller = new AbortController()
    controller.abort()

    const start = Date.now()
    await expect(
      runner.run([], '', { cwd: process.cwd(), signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    const elapsedMs = Date.now() - start

    // If `spawn` had actually been called against a nonexistent binary, the
    // rejection would instead surface asynchronously as an ENOENT `'error'`
    // event, which takes a tick (or more, if the OS is slow to resolve the
    // path) and would carry `code: 'ENOENT'`, not an AbortError. Settling
    // near-synchronously with an AbortError is our signal that `spawn` was
    // never reached.
    expect(elapsedMs).toBeLessThan(50)
  })
})

// ---------------------------------------------------------------------------
// Real-process behaviour. The "binary" is the current Node executable running a
// tiny script, so nothing but Node is spawned and no CLI is needed in CI.
// ---------------------------------------------------------------------------

function nodeRunner() {
  return createCodexCliRunner(process.execPath)
}

const run = (script: string, input = '') =>
  nodeRunner().run(['-e', script], input, { cwd: process.cwd() })

describe('createCodexCliRunner: stdout and stdin handling (R4.19)', () => {
  it('echoes stdin to stdout byte-exact, multibyte text included', async () => {
    const input = 'caf\u00e9 \u20ac \u{1F600} '.repeat(5000)
    const result = await run(
      "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(d))",
      input,
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe(input)
  })

  it('does not corrupt a multibyte character split across stdout chunks', async () => {
    // Each byte of three euro signs goes out as its own write, 15 ms apart, so
    // the runner sees every character cut across 'data' events.
    const script = `
      const bytes = Buffer.from('\u20ac\u20ac\u20ac', 'utf8');
      let i = 0;
      const tick = () => {
        if (i === bytes.length) return;
        process.stdout.write(bytes.subarray(i, i + 1));
        i += 1;
        setTimeout(tick, 15);
      };
      tick();
    `
    const result = await run(script)
    expect(result.stdout).toBe('\u20ac\u20ac\u20ac')
    expect(result.stdout).not.toContain('\uFFFD')
  })

  it('does the same for stderr', async () => {
    const script = `
      const bytes = Buffer.from('\u00e9\u00e9', 'utf8');
      let i = 0;
      const tick = () => {
        if (i === bytes.length) return;
        process.stderr.write(bytes.subarray(i, i + 1));
        i += 1;
        setTimeout(tick, 15);
      };
      tick();
    `
    const result = await run(script)
    expect(result.stderr).toBe('\u00e9\u00e9')
  })

  it('survives a process that exits without reading its stdin (EPIPE) and reports its exit code', async () => {
    const unhandled: unknown[] = []
    const onUncaught = (err: unknown): void => {
      unhandled.push(err)
    }
    process.on('uncaughtException', onUncaught)
    try {
      const result = await run(
        "process.stderr.write('bad flag');process.exit(3)",
        'x'.repeat(8 * 1024 * 1024),
      )
      expect(result.exitCode).toBe(3)
      expect(result.stderr).toBe('bad flag')
      // Let any late stream error surface before asserting there was none.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(unhandled).toEqual([])
    } finally {
      process.off('uncaughtException', onUncaught)
    }
  })

  it('kills a process whose stdout passes the cap and rejects with OutputLimitError', async () => {
    const script = `
      const chunk = Buffer.alloc(1024 * 1024, 97);
      const write = () => {
        while (process.stdout.write(chunk)) {}
        process.stdout.once('drain', write);
      };
      write();
    `
    const err = await run(script).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('OutputLimitError')
    expect((err as Error).message).toContain(String(MAX_STDOUT_BYTES))
  }, 30_000)

  it('keeps only the tail of an oversized stderr', async () => {
    const script = `
      process.stderr.write('A'.repeat(3 * 1024 * 1024));
      process.stderr.write('TAIL-MARKER');
    `
    const result = await run(script)
    expect(result.stderr.length).toBeLessThanOrEqual(MAX_STDERR_CHARS)
    expect(result.stderr.endsWith('TAIL-MARKER')).toBe(true)
  }, 30_000)
})

describe('createCodexCliRunner: kill reaches grandchildren (process group)', () => {
  // A child that spawns a grandchild sharing its stdio and living far longer
  // than the call: killing only the child leaves the pipes open, so `close`
  // (and the call) would wait for the grandchild.
  const script = `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' });
    require('node:fs').writeFileSync(process.argv[1], String(g.pid));
    setTimeout(() => {}, 20000);
  `
  // `process.kill(pid, 0)` alone is not a death test: a process that has closed
  // its pipes but is not reaped yet (exiting, or a zombie awaiting its parent)
  // still answers it. The runner settles when the pipes close, so a check made
  // at that instant raced the OS reaper and failed under load. A process counts
  // as dead once it is gone or exiting/zombie, polled until it gets there.
  const isRunning = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
    } catch {
      return false
    }
    try {
      const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf8',
      }).trim()
      return stat !== '' && !/^[ZEX]/.test(stat)
    } catch (e) {
      // `ps` exits 1 when the pid no longer exists; a missing `ps` leaves only
      // the signal probe above, which already said "present".
      return (e as NodeJS.ErrnoException).code === 'ENOENT'
    }
  }
  const waitUntilDead = async (pid: number): Promise<boolean> => {
    const deadline = Date.now() + 5_000
    while (isRunning(pid)) {
      if (Date.now() > deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return true
  }
  const readPid = async (pidFile: string): Promise<number> => {
    const deadline = Date.now() + 15_000
    for (;;) {
      // The file exists before its content is written, so wait for the digits.
      const text = existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : ''
      if (/^\d+$/.test(text)) return Number(text)
      if (Date.now() > deadline) throw new Error('the child never started')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  it('a timeout settles promptly and the grandchild is dead', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-grandchild-'))
    const pidFile = join(dir, 'pid')
    try {
      // Long enough that a loaded machine has started the child (and its
      // grandchild) before the deadline.
      const timeoutMs = 2_000
      const started = Date.now()
      const err = await nodeRunner()
        .run(['-e', script, pidFile], '', { cwd: process.cwd(), timeoutMs })
        .catch((e: unknown) => e)
      expect((err as Error).name).toBe('TimeoutError')
      // Kill latency: how long after the deadline the call settled.
      expect(Date.now() - started - timeoutMs).toBeLessThan(4_000)
      expect(await waitUntilDead(await readPid(pidFile))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('an abort settles promptly too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-grandchild-'))
    const pidFile = join(dir, 'pid')
    try {
      const controller = new AbortController()
      const pending = nodeRunner()
        .run(['-e', script, pidFile], '', {
          cwd: process.cwd(),
          signal: controller.signal,
        })
        .catch((e: unknown) => e)
      // Abort once the grandchild exists, not after a fixed delay: node's own
      // startup time under load is not what this test measures.
      const grandchild = await readPid(pidFile)
      const aborted = Date.now()
      controller.abort()
      const err = await pending
      expect((err as Error).name).toBe('AbortError')
      expect(Date.now() - aborted).toBeLessThan(4_000)
      expect(await waitUntilDead(grandchild)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
