/**
 * @gullabs/claude-cli: real runner tests.
 *
 * The adapter tests inject a fake runner. This file exercises
 * {@link buildClaudeCliRunner} itself, with the current Node executable as the
 * "binary" so no `claude` CLI is needed and none is spawned.
 *
 * @module
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { MAX_STDERR_CHARS, MAX_STDOUT_BYTES, buildClaudeCliRunner } from './runner.js'

// ---------------------------------------------------------------------------
// Real-process behaviour. The "binary" is the current Node executable running a
// tiny script, so nothing but Node is spawned and no CLI is needed in CI.
// ---------------------------------------------------------------------------

function nodeRunner() {
  return buildClaudeCliRunner(process.execPath)
}

const run = (script: string, input = '') =>
  nodeRunner().run(['-e', script], input, { cwd: process.cwd() })

describe('buildClaudeCliRunner: stdout and stdin handling (R4.19)', () => {
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

describe('buildClaudeCliRunner: kill reaches grandchildren (process group)', () => {
  // A child that spawns a grandchild sharing its stdio and living far longer
  // than the call: killing only the child leaves the pipes open, so `close`
  // (and the call) would wait for the grandchild.
  const script = `
    const { spawn } = require('node:child_process');
    const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' });
    require('node:fs').writeFileSync(process.argv[1], String(g.pid));
    setTimeout(() => {}, 20000);
  `
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('a timeout settles promptly and the grandchild is dead', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-grandchild-'))
    const pidFile = join(dir, 'pid')
    try {
      const started = Date.now()
      const err = await nodeRunner()
        .run(['-e', script, pidFile], '', { cwd: process.cwd(), timeoutMs: 500 })
        .catch((e: unknown) => e)
      expect((err as Error).name).toBe('TimeoutError')
      expect(Date.now() - started).toBeLessThan(4_000)
      const grandchild = Number(readFileSync(pidFile, 'utf8'))
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(alive(grandchild)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('an abort settles promptly too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'runner-grandchild-'))
    const pidFile = join(dir, 'pid')
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 500)
      const started = Date.now()
      const err = await nodeRunner()
        .run(['-e', script, pidFile], '', {
          cwd: process.cwd(),
          signal: controller.signal,
        })
        .catch((e: unknown) => e)
      expect((err as Error).name).toBe('AbortError')
      expect(Date.now() - started).toBeLessThan(4_000)
      expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
