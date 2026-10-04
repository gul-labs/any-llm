/**
 * @gullabs/claude-cli: real runner tests.
 *
 * The adapter tests inject a fake runner. This file exercises
 * {@link buildClaudeCliRunner} itself, with the current Node executable as the
 * "binary" so no `claude` CLI is needed and none is spawned.
 *
 * @module
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

  it('a timeout rejects with TimeoutError', async () => {
    // The deadline is short on purpose and nothing here depends on the child
    // having started by then: the call settles with the same error either way.
    // The kill path itself (group signal, grandchild death) is the abort test below;
    // timeout and abort share it.
    const err = await nodeRunner()
      .run(['-e', 'setTimeout(() => {}, 20000)'], '', {
        cwd: process.cwd(),
        timeoutMs: 20,
      })
      .catch((e: unknown) => e)
    expect((err as Error).name).toBe('TimeoutError')
  }, 15_000)

  it('an abort rejects with AbortError and the grandchild is dead', async () => {
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
      controller.abort()
      const err = await pending
      expect((err as Error).name).toBe('AbortError')
      expect(await waitUntilDead(grandchild)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('a group member that ignores SIGTERM and holds no pipe is killed once the leader has closed', async () => {
    // The leader dies on SIGTERM and closes its pipes at once; the grandchild
    // ignores SIGTERM and has its stdio detached, so nothing but the runner's own
    // final SIGKILL can end it (its idle timer runs for 20 s).
    const leader = `
      const { spawn } = require('node:child_process');
      const grandchild = \`
        process.on('SIGTERM', () => {});
        require('node:fs').writeFileSync(process.argv[1], String(process.pid));
        setTimeout(() => {}, 20000);
      \`;
      spawn(process.execPath, ['-e', grandchild, process.argv[1]], { stdio: 'ignore' });
      setTimeout(() => {}, 20000);
    `
    const dir = mkdtempSync(join(tmpdir(), 'runner-sweep-'))
    const pidFile = join(dir, 'pid')
    try {
      const controller = new AbortController()
      const pending = nodeRunner()
        .run(['-e', leader, pidFile], '', {
          cwd: process.cwd(),
          signal: controller.signal,
        })
        .catch((e: unknown) => e)
      const grandchild = await readPid(pidFile)
      controller.abort()
      expect(((await pending) as Error).name).toBe('AbortError')
      expect(await waitUntilDead(grandchild)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('buildClaudeCliRunner: the child environment', () => {
  const printEnv = 'process.stdout.write(JSON.stringify(process.env))'
  const withEnv = async <T>(
    vars: Record<string, string>,
    body: () => Promise<T>,
  ): Promise<T> => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
    Object.assign(process.env, vars)
    try {
      return await body()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }
  const childEnv = async (
    extra?: Readonly<Record<string, string>>,
  ): Promise<Record<string, string>> => {
    const result = await nodeRunner().run(['-e', printEnv], '', {
      cwd: process.cwd(),
      ...(extra !== undefined ? { env: extra } : {}),
    })
    return JSON.parse(result.stdout) as Record<string, string>
  }

  it('does not hand the host API key or provider routing to the CLI', async () => {
    const env = await withEnv(
      {
        ANTHROPIC_API_KEY: 'host-api-key',
        ANTHROPIC_AUTH_TOKEN: 'host-auth-token',
        ANTHROPIC_BASE_URL: 'https://gateway.invalid',
        CLAUDE_CODE_USE_BEDROCK: '1',
        OPENAI_API_KEY: 'host-openai-key',
        MY_UNRELATED_SECRET: 'x',
      },
      childEnv,
    )
    for (const name of [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'ANTHROPIC_BASE_URL',
      'CLAUDE_CODE_USE_BEDROCK',
      'OPENAI_API_KEY',
      'MY_UNRELATED_SECRET',
    ]) {
      expect(env).not.toHaveProperty(name)
    }
  })

  it('keeps what the CLI needs to find its subscription login', async () => {
    const env = await withEnv(
      {
        CLAUDE_CONFIG_DIR: '/config/dir',
        CLAUDE_CODE_OAUTH_TOKEN: 'subscription-token',
        HTTPS_PROXY: 'http://proxy.invalid:3128',
        LC_ALL: 'C',
        XDG_CONFIG_HOME: '/xdg',
      },
      childEnv,
    )
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/config/dir')
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('subscription-token')
    expect(env['HTTPS_PROXY']).toBe('http://proxy.invalid:3128')
    expect(env['LC_ALL']).toBe('C')
    expect(env['XDG_CONFIG_HOME']).toBe('/xdg')
    expect(env['PATH']).toBe(process.env['PATH'])
    expect(env['HOME']).toBe(process.env['HOME'])
  })

  it("opts.env is added on top and wins over the host's own value", async () => {
    const env = await withEnv({ CLAUDE_CONFIG_DIR: '/host' }, () =>
      childEnv({ CLAUDE_CONFIG_DIR: '/explicit', ANTHROPIC_API_KEY: 'explicit-key' }),
    )
    expect(env['CLAUDE_CONFIG_DIR']).toBe('/explicit')
    expect(env['ANTHROPIC_API_KEY']).toBe('explicit-key')
  })
})
