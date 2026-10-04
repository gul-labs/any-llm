import { describe, expect, it } from 'vitest'
import { guardHostCall, isThenable, makeSafeLogger } from './host-guard.js'
import type { Logger } from './ports.js'

const wait = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('guardHostCall', () => {
  it('returns the result and never reports a clean call', () => {
    const failures: unknown[] = []
    expect(
      guardHostCall(
        () => 42,
        (e) => failures.push(e),
      ),
    ).toBe(42)
    expect(failures).toEqual([])
  })

  it('reports a synchronous throw and returns undefined', () => {
    const failures: unknown[] = []
    const out = guardHostCall(
      () => {
        throw new Error('sync')
      },
      (e) => failures.push(e),
    )
    expect(out).toBeUndefined()
    expect(failures).toHaveLength(1)
  })

  it('reports the rejection of a returned promise and hands the promise back', async () => {
    const failures: unknown[] = []
    const promise = Promise.reject(new Error('async'))
    const out = guardHostCall(
      () => promise,
      (e) => failures.push(e),
    )
    expect(out).toBe(promise)
    await wait(5)
    expect(failures).toHaveLength(1)
  })

  it('handles a thenable whose then throws', async () => {
    const failures: unknown[] = []
    const thenable = {
      then() {
        throw new Error('then boom')
      },
    }
    expect(isThenable(thenable)).toBe(true)
    guardHostCall(
      () => thenable,
      (e) => failures.push(e),
    )
    await wait(5)
    expect(failures).toHaveLength(1)
  })

  it('a result whose then getter throws never escapes the guard', async () => {
    const failures: unknown[] = []
    const hostile = {
      get then(): never {
        throw new Error('getter boom')
      },
    }
    expect(isThenable(hostile)).toBe(true)
    let out: unknown
    expect(() => {
      out = guardHostCall(
        () => hostile,
        (e) => failures.push(e),
      )
    }).not.toThrow()
    expect(out).toBe(hostile)
    await wait(5)
    expect(failures).toHaveLength(1)

    const trapped = new Proxy(
      {},
      {
        get() {
          throw new Error('trap boom')
        },
      },
    )
    expect(isThenable(trapped)).toBe(true)
    expect(() =>
      guardHostCall(
        () => trapped,
        () => {},
      ),
    ).not.toThrow()
    // A reporter that returns such an object is absorbed too.
    expect(() =>
      guardHostCall(
        () => {
          throw new Error('x')
        },
        () => hostile,
      ),
    ).not.toThrow()
  })

  it('a logger method that returns a throwing-getter object does not break the logger', async () => {
    const hostile = {
      get then(): never {
        throw new Error('getter boom')
      },
    }
    const logger = {
      info: () => hostile,
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as Logger
    expect(() => makeSafeLogger(logger).info({}, 'event')).not.toThrow()
  })

  it('a reporter that throws or rejects is never an unhandled rejection', async () => {
    const seen: unknown[] = []
    const on = (reason: unknown): void => {
      seen.push(reason)
    }
    process.on('unhandledRejection', on)
    try {
      guardHostCall(
        () => Promise.reject(new Error('a')),
        () => {
          throw new Error('reporter')
        },
      )
      guardHostCall(
        () => {
          throw new Error('b')
        },
        () => Promise.reject(new Error('reporter')) as never,
      )
      await wait(30)
    } finally {
      process.off('unhandledRejection', on)
    }
    expect(seen).toEqual([])
  })
})

describe('makeSafeLogger', () => {
  it('forwards to the host logger with the same arguments', () => {
    const seen: Array<[string, object, string]> = []
    const logger: Logger = {
      info: (o, m) => seen.push(['info', o, m]),
      warn: (o, m) => seen.push(['warn', o, m]),
      error: (o, m) => seen.push(['error', o, m]),
      debug: (o, m) => seen.push(['debug', o, m]),
    }
    const safe = makeSafeLogger(logger)
    safe.info({ a: 1 }, 'x')
    safe.error({ b: 2 }, 'y')
    expect(seen).toEqual([
      ['info', { a: 1 }, 'x'],
      ['error', { b: 2 }, 'y'],
    ])
  })

  it('a failing method is reported once at debug as llm.hook.failed', async () => {
    const events: Array<[string, Record<string, unknown>, string]> = []
    const logger: Logger = {
      info: () => Promise.reject(new Error('nope')) as never,
      warn: () => {},
      error: () => {},
      debug: (o, m) => events.push(['debug', o as Record<string, unknown>, m]),
    }
    makeSafeLogger(logger).info({}, 'x')
    await wait(5)
    expect(events).toHaveLength(1)
    expect(events[0]?.[2]).toBe('llm.hook.failed')
    expect(events[0]?.[1]['phase']).toBe('logger.info')
  })

  it('a logger that always fails does not recurse', async () => {
    let calls = 0
    const logger: Logger = {
      info: () => {
        calls += 1
        throw new Error('x')
      },
      warn: () => {
        calls += 1
        throw new Error('x')
      },
      error: () => {
        calls += 1
        throw new Error('x')
      },
      debug: () => {
        calls += 1
        return Promise.reject(new Error('x')) as never
      },
    }
    const safe = makeSafeLogger(logger)
    safe.info({}, 'a')
    safe.debug({}, 'b')
    await wait(10)
    expect(calls).toBeLessThanOrEqual(4)
  })
})
