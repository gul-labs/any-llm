import { describe, expect, it } from 'vitest'
import { FakeCliRunner } from './fake-cli-runner.js'

const OPTS = { cwd: '/tmp/work' }

describe('FakeCliRunner', () => {
  it('returns the scripted output with stderr and exitCode defaulted, and records the call', async () => {
    const runner = new FakeCliRunner({ stdout: '{"ok":true}' })

    const result = await runner.run(['--print'], 'prompt text', {
      cwd: '/tmp/x',
      timeoutMs: 5_000,
    })

    expect(result).toEqual({ stdout: '{"ok":true}', stderr: '', exitCode: 0 })
    expect(runner.calls).toEqual([
      {
        args: ['--print'],
        input: 'prompt text',
        opts: { cwd: '/tmp/x', timeoutMs: 5_000 },
      },
    ])
  })

  it('a non-zero exit is a resolved result, never a rejection', async () => {
    const runner = new FakeCliRunner({ stdout: '', stderr: 'boom', exitCode: 2 })
    await expect(runner.run([], '', OPTS)).resolves.toEqual({
      stdout: '',
      stderr: 'boom',
      exitCode: 2,
    })
  })

  it('a null exit code means killed by a signal', async () => {
    const runner = new FakeCliRunner({ stdout: '', exitCode: null })
    expect((await runner.run([], '', OPTS)).exitCode).toBeNull()
  })

  it('an Error entry rejects, as a spawn-time failure (ENOENT) does', async () => {
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
    const runner = new FakeCliRunner(enoent)
    await expect(runner.run([], '', OPTS)).rejects.toBe(enoent)
    expect(runner.calls).toHaveLength(1)
  })

  it('consumes a list in order, repeating the last, and a function sees the call', async () => {
    const runner = new FakeCliRunner([
      { stdout: 'one' },
      (call) => ({ stdout: `echo:${call.input}`, stderr: '', exitCode: 0 }),
      { stdout: 'last' },
    ])

    expect((await runner.run([], 'a', OPTS)).stdout).toBe('one')
    expect((await runner.run([], 'b', OPTS)).stdout).toBe('echo:b')
    expect((await runner.run([], 'c', OPTS)).stdout).toBe('last')
    expect((await runner.run([], 'd', OPTS)).stdout).toBe('last')
  })

  it('an async function entry is awaited', async () => {
    const runner = new FakeCliRunner(() =>
      Promise.resolve({ stdout: 'late', stderr: '', exitCode: 0 }),
    )
    expect((await runner.run([], '', OPTS)).stdout).toBe('late')
  })

  it('a signal that is already aborted rejects with an AbortError and does not consume the script', async () => {
    const runner = new FakeCliRunner([{ stdout: 'first' }])
    const controller = new AbortController()
    controller.abort()

    const error = await runner
      .run([], '', { ...OPTS, signal: controller.signal })
      .catch((e: unknown) => e)

    expect(error).toMatchObject({ name: 'AbortError' })
    expect(runner.calls).toHaveLength(1) // recorded, as the call was made
  })

  it('rejects a bad script: a missing stdout, a wrong type, an empty list', () => {
    expect(() => new FakeCliRunner({ stderr: 'x' } as never)).toThrow(/entry 0 must be/)
    expect(() => new FakeCliRunner('out' as never)).toThrow(TypeError)
    expect(() => new FakeCliRunner([])).toThrow(/at least one scripted entry/)
  })

  it('satisfies the structural run(args, input, opts) seam of both CLI runners', () => {
    interface Seam {
      run(
        args: string[],
        input: string,
        opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
      ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>
    }
    const seam: Seam = new FakeCliRunner({ stdout: '' })
    expect(typeof seam.run).toBe('function')
  })
})
