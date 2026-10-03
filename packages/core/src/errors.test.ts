/**
 * Unit tests for errors.ts — classifyHttpStatus and classifyError.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyHttpStatus,
  classifyError,
  causeChain,
  isTransportError,
  parseRetryAfter,
  LlmError,
  normalizeSchemaIssues,
  toErrorIssues,
} from './errors.js'
import type { LlmErrorKind } from './errors.js'
import type { StandardSchemaV1 } from './standard-schema.js'

// ---------------------------------------------------------------------------
// classifyHttpStatus — table-driven
// ---------------------------------------------------------------------------

describe('classifyHttpStatus', () => {
  interface Row {
    status: number
    retryAfterMs?: number
    expectedKind: LlmErrorKind
    expectedRetryable: boolean
    expectedRetryAfterMs?: number
  }

  const table: Row[] = [
    // Auth
    { status: 401, expectedKind: 'invalid_auth', expectedRetryable: false },
    { status: 403, expectedKind: 'invalid_auth', expectedRetryable: false },
    // Timeout
    { status: 408, expectedKind: 'timeout', expectedRetryable: true },
    // Rate limit — without retryAfterMs
    { status: 429, expectedKind: 'rate_limited', expectedRetryable: true },
    // Rate limit — with retryAfterMs propagated
    {
      status: 429,
      retryAfterMs: 5000,
      expectedKind: 'rate_limited',
      expectedRetryable: true,
      expectedRetryAfterMs: 5000,
    },
    // The provider's delay travels with every retryable status
    {
      status: 503,
      retryAfterMs: 20_000,
      expectedKind: 'server',
      expectedRetryable: true,
      expectedRetryAfterMs: 20_000,
    },
    {
      status: 408,
      retryAfterMs: 3_000,
      expectedKind: 'timeout',
      expectedRetryable: true,
      expectedRetryAfterMs: 3_000,
    },
    // ...and never with a status a retry cannot fix
    {
      status: 400,
      retryAfterMs: 5_000,
      expectedKind: 'bad_request',
      expectedRetryable: false,
    },
    {
      status: 401,
      retryAfterMs: 5_000,
      expectedKind: 'invalid_auth',
      expectedRetryable: false,
    },
    // Bad request
    { status: 400, expectedKind: 'bad_request', expectedRetryable: false },
    { status: 422, expectedKind: 'bad_request', expectedRetryable: false },
    // Server errors
    { status: 500, expectedKind: 'server', expectedRetryable: true },
    { status: 502, expectedKind: 'server', expectedRetryable: true },
    { status: 503, expectedKind: 'server', expectedRetryable: true },
    { status: 504, expectedKind: 'server', expectedRetryable: true },
    // Unknown / redirect / info
    { status: 200, expectedKind: 'unknown', expectedRetryable: false },
    { status: 301, expectedKind: 'unknown', expectedRetryable: false },
    { status: 404, expectedKind: 'bad_request', expectedRetryable: false },
    { status: 413, expectedKind: 'bad_request', expectedRetryable: false },
    { status: 409, expectedKind: 'unknown', expectedRetryable: false },
  ]

  for (const row of table) {
    const label =
      row.retryAfterMs !== undefined
        ? `status=${row.status} retryAfterMs=${row.retryAfterMs}`
        : `status=${row.status}`

    it(label, () => {
      const result = classifyHttpStatus(row.status, row.retryAfterMs)

      expect(result.kind).toBe(row.expectedKind)
      expect(result.retryable).toBe(row.expectedRetryable)

      if (row.expectedRetryAfterMs !== undefined) {
        expect(result.retryAfterMs).toBe(row.expectedRetryAfterMs)
      } else {
        expect(result.retryAfterMs).toBeUndefined()
      }
    })
  }
})

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

describe('classifyError', () => {
  it('passes through an existing LlmError unchanged', () => {
    const original = new LlmError('already classified', {
      kind: 'bad_request',
      retryable: false,
    })
    const result = classifyError(original)
    expect(result).toBe(original)
  })

  it('classifies AbortError as aborted (not retryable)', () => {
    const e = new Error('The user aborted a request.')
    e.name = 'AbortError'

    const result = classifyError(e)

    expect(result).toBeInstanceOf(LlmError)
    expect(result.kind).toBe('aborted')
    expect(result.retryable).toBe(false)
    expect(result.retryAfterMs).toBeUndefined()
    expect(result.cause).toBe(e)
  })

  it('classifies TimeoutError by name as timeout (retryable)', () => {
    const e = new Error('The operation timed out.')
    e.name = 'TimeoutError'

    const result = classifyError(e)

    expect(result).toBeInstanceOf(LlmError)
    expect(result.kind).toBe('timeout')
    expect(result.retryable).toBe(true)
    expect(result.retryAfterMs).toBeUndefined()
    expect(result.cause).toBe(e)
  })

  it('classifies errors with "timeout" in message as timeout (retryable)', () => {
    const e = new Error('Request timeout after 30000ms')

    const result = classifyError(e)

    expect(result.kind).toBe('timeout')
    expect(result.retryable).toBe(true)
  })

  it('classifies errors with "timed out" in message as timeout (retryable)', () => {
    const e = new Error('Connection timed out')

    const result = classifyError(e)

    expect(result.kind).toBe('timeout')
    expect(result.retryable).toBe(true)
  })

  it('classifies unknown Error as unknown (not retryable)', () => {
    const e = new Error('something went wrong')

    const result = classifyError(e)

    expect(result).toBeInstanceOf(LlmError)
    expect(result.kind).toBe('unknown')
    expect(result.retryable).toBe(false)
    expect(result.retryAfterMs).toBeUndefined()
    expect(result.cause).toBe(e)
  })

  it('classifies a thrown string as unknown', () => {
    const result = classifyError('plain string error')

    expect(result.kind).toBe('unknown')
    expect(result.retryable).toBe(false)
    expect(result.message).toBe('plain string error')
  })

  it('classifies a thrown plain object with a transport errno code as a retryable server error', () => {
    const obj = { code: 'ECONNREFUSED' }
    const result = classifyError(obj)

    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
    expect(result.cause).toBe(obj)
  })

  it('classifies a thrown plain object with no recognisable field as unknown', () => {
    const obj = { code: 'SOMETHING_ELSE' }
    const result = classifyError(obj)

    expect(result.kind).toBe('unknown')
    expect(result.retryable).toBe(false)
    expect(result.cause).toBe(obj)
  })

  it('classifies null as unknown', () => {
    const result = classifyError(null)
    expect(result.kind).toBe('unknown')
    expect(result.retryable).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Plain-object provider errors
  // ---------------------------------------------------------------------------

  it('classifies {status:429, retryAfterMs:5000} as rate_limited + retryable + retryAfterMs', () => {
    const result = classifyError({ status: 429, retryAfterMs: 5000 })
    expect(result.kind).toBe('rate_limited')
    expect(result.retryable).toBe(true)
    expect(result.httpStatus).toBe(429)
    expect(result.retryAfterMs).toBe(5000)
    expect(result.cause).toEqual({ status: 429, retryAfterMs: 5000 })
  })

  it('classifies {status:401} as invalid_auth + non-retryable', () => {
    const result = classifyError({ status: 401 })
    expect(result.kind).toBe('invalid_auth')
    expect(result.retryable).toBe(false)
    expect(result.httpStatus).toBe(401)
    expect(result.retryAfterMs).toBeUndefined()
  })

  it('classifies {code:503} (numeric code) as server + retryable', () => {
    const result = classifyError({ code: 503 })
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
    expect(result.httpStatus).toBe(503)
  })

  it('classifies {response:{status:429}} (nested) as rate_limited + retryable', () => {
    const result = classifyError({ response: { status: 429 } })
    expect(result.kind).toBe('rate_limited')
    expect(result.retryable).toBe(true)
    expect(result.httpStatus).toBe(429)
  })

  it('classifies an unknown plain object (no numeric status/code) as unknown', () => {
    const result = classifyError({ message: 'something failed', foo: 'bar' })
    expect(result.kind).toBe('unknown')
    expect(result.retryable).toBe(false)
  })

  it('extracts retryAfterMs from retryAfter (seconds → ms)', () => {
    const result = classifyError({ status: 429, retryAfter: 30 })
    expect(result.kind).toBe('rate_limited')
    expect(result.retryAfterMs).toBe(30_000)
  })

  it('extracts retryAfterMs from headers retry-after string', () => {
    const result = classifyError({ status: 429, headers: { 'retry-after': '60' } })
    expect(result.kind).toBe('rate_limited')
    expect(result.retryAfterMs).toBe(60_000)
  })

  it('extracts retryAfterMs from Headers.get() interface', () => {
    const headers = {
      get: (key: string) => (key === 'retry-after' ? '10' : null),
    }
    const result = classifyError({ status: 429, headers })
    expect(result.kind).toBe('rate_limited')
    expect(result.retryAfterMs).toBe(10_000)
  })

  it('classifies Error subclass with .status property via HTTP routing', () => {
    class SdkError extends Error {
      status: number
      constructor(msg: string, status: number) {
        super(msg)
        this.name = 'SdkError'
        this.status = status
      }
    }
    const err = new SdkError('Unauthorized', 403)
    const result = classifyError(err)
    expect(result.kind).toBe('invalid_auth')
    expect(result.retryable).toBe(false)
    expect(result.httpStatus).toBe(403)
    expect(result.cause).toBe(err)
  })
})

// ---------------------------------------------------------------------------
// LlmError constructor
// ---------------------------------------------------------------------------

describe('LlmError', () => {
  it('sets required fields', () => {
    const e = new LlmError('test error', { kind: 'server', retryable: true })

    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(LlmError)
    expect(e.name).toBe('LlmError')
    expect(e.message).toBe('test error')
    expect(e.kind).toBe('server')
    expect(e.retryable).toBe(true)
  })

  it('sets optional fields when provided', () => {
    const cause = new Error('root cause')
    const e = new LlmError('rate limit hit', {
      kind: 'rate_limited',
      retryable: true,
      httpStatus: 429,
      retryAfterMs: 3000,
      provider: 'google',
      cause,
    })

    expect(e.httpStatus).toBe(429)
    expect(e.retryAfterMs).toBe(3000)
    expect(e.provider).toBe('google')
    expect(e.cause).toBe(cause)
  })

  it('leaves optional fields absent when not provided', () => {
    const e = new LlmError('auth failed', { kind: 'invalid_auth', retryable: false })

    expect(e.httpStatus).toBeUndefined()
    expect(e.retryAfterMs).toBeUndefined()
    expect(e.provider).toBeUndefined()
    expect(e.cause).toBeUndefined()
    expect(e.issues).toBeUndefined()
  })

  it('carries issues when provided', () => {
    const e = new LlmError('bad input', {
      kind: 'bad_request',
      retryable: false,
      issues: [{ path: 'name', message: 'required' }],
    })

    expect(e.issues).toEqual([{ path: 'name', message: 'required' }])
  })

  it('maintains instanceof across prototype chain', () => {
    const e = new LlmError('test', { kind: 'unknown', retryable: false })
    expect(e instanceof Error).toBe(true)
    expect(e instanceof LlmError).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// normalizeSchemaIssues (D6)
// ---------------------------------------------------------------------------

describe('normalizeSchemaIssues', () => {
  it('root-level issue (no path) normalizes to path: "" with empty segments', () => {
    const issues: StandardSchemaV1.Issue[] = [{ message: 'root is invalid' }]
    expect(normalizeSchemaIssues(issues)).toEqual([
      { segments: [], path: '', message: 'root is invalid' },
    ])
  })

  it('empty path array also normalizes to path: ""', () => {
    const issues: StandardSchemaV1.Issue[] = [{ message: 'root is invalid', path: [] }]
    expect(normalizeSchemaIssues(issues)).toEqual([
      { segments: [], path: '', message: 'root is invalid' },
    ])
  })

  it('nested string-key paths normalize to dotted notation', () => {
    const issues: StandardSchemaV1.Issue[] = [
      { message: 'expected string', path: ['context', 'photographer'] },
    ]
    expect(normalizeSchemaIssues(issues)).toEqual([
      {
        segments: ['context', 'photographer'],
        path: 'context.photographer',
        message: 'expected string',
      },
    ])
  })

  it('array-index segments keep numeric identity; dotted path stringifies them', () => {
    const issues: StandardSchemaV1.Issue[] = [
      { message: 'expected string', path: ['items', 0, 'name'] },
    ]
    expect(normalizeSchemaIssues(issues)).toEqual([
      {
        segments: ['items', 0, 'name'],
        path: 'items.0.name',
        message: 'expected string',
      },
    ])
  })

  it('accepts { key } wrapper path segments (StandardSchemaV1.PathSegment)', () => {
    const issues: StandardSchemaV1.Issue[] = [
      { message: 'bad', path: [{ key: 'a' }, { key: 1 }, { key: 'b' }] },
    ]
    expect(normalizeSchemaIssues(issues)).toEqual([
      { segments: ['a', 1, 'b'], path: 'a.1.b', message: 'bad' },
    ])
  })

  it('symbol path segments are stringified (plain-JSON output)', () => {
    const sym = Symbol('secretField')
    const issues: StandardSchemaV1.Issue[] = [{ message: 'bad symbol key', path: [sym] }]
    const normalized = normalizeSchemaIssues(issues)
    expect(normalized).toEqual([
      { segments: [sym.toString()], path: sym.toString(), message: 'bad symbol key' },
    ])
    // Confirm it is a genuine string, not the symbol itself — safe for JSON.stringify.
    expect(typeof normalized[0]!.path).toBe('string')
    expect(typeof normalized[0]!.segments[0]).toBe('string')
    expect(() => JSON.stringify(normalized)).not.toThrow()
  })

  it('normalizes multiple issues independently, preserving order', () => {
    const issues: StandardSchemaV1.Issue[] = [
      { message: 'first', path: ['a'] },
      { message: 'second' },
      { message: 'third', path: ['b', 2] },
    ]
    expect(normalizeSchemaIssues(issues)).toEqual([
      { segments: ['a'], path: 'a', message: 'first' },
      { segments: [], path: '', message: 'second' },
      { segments: ['b', 2], path: 'b.2', message: 'third' },
    ])
  })

  it('toErrorIssues strips segments, leaving the plain { path, message } payload', () => {
    const normalized = normalizeSchemaIssues([
      { message: 'expected string', path: ['items', 0, 'name'] },
      { message: 'root is invalid' },
    ])
    expect(toErrorIssues(normalized)).toEqual([
      { path: 'items.0.name', message: 'expected string' },
      { path: '', message: 'root is invalid' },
    ])
  })
})

// ---------------------------------------------------------------------------
// classifyError — structured evidence first, message heuristic last (R4.5)
// ---------------------------------------------------------------------------

describe('classifyError — evidence order', () => {
  it('a structured 400 wins over a "timeout" in the message', () => {
    const e = Object.assign(new Error('Invalid value at generation_config.timeout'), {
      status: 400,
    })
    const result = classifyError(e)
    expect(result.kind).toBe('bad_request')
    expect(result.retryable).toBe(false)
    expect(result.httpStatus).toBe(400)
    expect(result.message).toBe('Invalid value at generation_config.timeout')
    expect(result.cause).toBe(e)
  })

  it('a structured 429 wins over a "timed out" message and keeps retryAfterMs', () => {
    const e = Object.assign(new Error('quota check timed out, slow down'), {
      status: 429,
      retryAfter: 4,
    })
    const result = classifyError(e)
    expect(result.kind).toBe('rate_limited')
    expect(result.retryAfterMs).toBe(4_000)
  })

  it('a structured status wins over a connection errno on the cause', () => {
    const e = Object.assign(
      new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }),
      {
        status: 503,
      },
    )
    expect(classifyError(e).kind).toBe('server')
    expect(classifyError(e).httpStatus).toBe(503)
  })

  it('a number that is not an HTTP status is not read as one', () => {
    for (const code of [0, 14, -104, 99, 600, 429.5]) {
      const result = classifyError(Object.assign(new Error('request timeout'), { code }))
      expect(result.kind).toBe('timeout')
      expect(result.httpStatus).toBeUndefined()
    }
  })

  it('AbortError still wins over everything else', () => {
    const e = Object.assign(new Error('fetch failed: timeout'), {
      name: 'AbortError',
      status: 500,
    })
    expect(classifyError(e).kind).toBe('aborted')
  })

  it('TimeoutError by name beats a transport match', () => {
    const e = Object.assign(new Error('fetch failed'), { name: 'TimeoutError' })
    expect(classifyError(e).kind).toBe('timeout')
  })

  it('maps 404 and 413 to bad_request and 409 to unknown from a structured status', () => {
    expect(classifyError({ status: 404 })).toMatchObject({
      kind: 'bad_request',
      retryable: false,
    })
    expect(classifyError({ status: 413 })).toMatchObject({
      kind: 'bad_request',
      retryable: false,
    })
    expect(classifyError({ status: 409 })).toMatchObject({
      kind: 'unknown',
      retryable: false,
    })
  })

  it('reads a nested response.status and error.code', () => {
    expect(classifyError({ response: { status: 404 } }).kind).toBe('bad_request')
    expect(classifyError({ error: { code: 413 } }).kind).toBe('bad_request')
  })
})

describe('classifyError — structured status shapes', () => {
  it('reads a numeric-string status (gaxios sets code to the string status)', () => {
    expect(classifyError({ code: '429' })).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      httpStatus: 429,
    })
    expect(classifyError({ status: '503' })).toMatchObject({
      kind: 'server',
      httpStatus: 503,
    })
    expect(classifyError({ response: { status: '404' } }).kind).toBe('bad_request')
  })

  it.each(['abc', '42', '4290', '429.5', '', ' ', 'ECONNRESET'])(
    'a string that is not a three-digit status (%j) is not read as one',
    (code) => {
      expect(classifyError({ code }).httpStatus).toBeUndefined()
    },
  )

  it('reads statusCode (AI SDK, got, AWS shapes)', () => {
    expect(classifyError({ statusCode: 429, retryAfter: 3 })).toMatchObject({
      kind: 'rate_limited',
      httpStatus: 429,
      retryAfterMs: 3_000,
    })
    expect(classifyError({ response: { statusCode: 502 } }).kind).toBe('server')
  })

  it('finds a status that exists only on the cause chain', () => {
    const e = new Error('Request failed', {
      cause: Object.assign(new Error('inner'), { status: 429, retryAfter: 2 }),
    })
    const result = classifyError(e)
    expect(result).toMatchObject({
      kind: 'rate_limited',
      retryable: true,
      httpStatus: 429,
      retryAfterMs: 2_000,
    })
    expect(result.message).toBe('Request failed')
    expect(result.cause).toBe(e)
  })

  it('reads retry-after from response.headers (axios, ky)', () => {
    expect(
      classifyError({ response: { status: 429, headers: { 'retry-after': '8' } } })
        .retryAfterMs,
    ).toBe(8_000)
    expect(
      classifyError({
        status: 429,
        headers: {},
        response: { headers: new Headers({ 'retry-after': '9' }) },
      }).retryAfterMs,
    ).toBe(9_000)
  })

  it('carries a provider delay on a 503, not only on a 429', () => {
    expect(
      classifyError({ status: 503, headers: { 'retry-after': '20' } }),
    ).toMatchObject({ kind: 'server', retryable: true, retryAfterMs: 20_000 })
  })
})

describe('classifyError — transport failures', () => {
  it('undici "fetch failed" with ECONNRESET on the cause is a retryable server error', () => {
    const e = new TypeError('fetch failed', {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    })
    const result = classifyError(e)
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
    expect(result.cause).toBe(e)
    expect(result.message).toBe('fetch failed')
  })

  it.each([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'EPIPE',
    'ENOTFOUND',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'UND_ERR_SOCKET',
    'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  ])(
    'a bare %s code on the error or deep in its cause chain is a retryable server error',
    (code) => {
      const direct = classifyError(Object.assign(new Error('x'), { code }))
      expect(direct).toMatchObject({ kind: 'server', retryable: true })

      const deep = classifyError(
        new Error('outer', { cause: new Error('middle', { cause: { code } }) }),
      )
      expect(deep).toMatchObject({ kind: 'server', retryable: true })
    },
  )

  it.each(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])(
    'undici deadline %s stays a retryable timeout',
    (code) => {
      const e = new TypeError('fetch failed', {
        cause: Object.assign(new Error('Timeout Error'), { code }),
      })
      expect(classifyError(e)).toMatchObject({ kind: 'timeout', retryable: true })
    },
  )

  it('matches the SDK messages "Connection error." and "socket hang up"', () => {
    expect(classifyError(new Error('Connection error.')).kind).toBe('server')
    expect(classifyError(new Error('socket hang up')).kind).toBe('server')
    expect(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:443')).kind).toBe(
      'server',
    )
    expect(classifyError(new Error('read ECONNRESET')).kind).toBe('server')
  })

  it.each([
    'Invalid schema: no connection error handler',
    'Tool output: fetch failed: file not found',
    'the socket hang up handler is missing',
    'request failed: ECONNRESET while parsing',
  ])('free text that merely mentions a transport phrase is not one: %s', (message) => {
    expect(classifyError(new Error(message))).toMatchObject({
      kind: 'unknown',
      retryable: false,
    })
  })

  it.each([
    'UND_ERR_INVALID_ARG',
    'UND_ERR_NOT_SUPPORTED',
    'UND_ERR_CLOSED',
    'UND_ERR_DESTROYED',
    'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  ])('the undici programming error %s is not retried', (code) => {
    expect(classifyError(Object.assign(new Error('x'), { code }))).toMatchObject({
      kind: 'unknown',
      retryable: false,
    })
  })

  it('does not match an unrelated errno or message', () => {
    expect(classifyError(Object.assign(new Error('x'), { code: 'ENOENT' })).kind).toBe(
      'unknown',
    )
    expect(classifyError(new Error('something went wrong')).kind).toBe('unknown')
  })

  it('terminates on a cyclic cause chain', () => {
    const a: { cause?: unknown; message: string } = { message: 'a' }
    const b: { cause?: unknown; message: string } = { message: 'b', cause: a }
    a.cause = b
    expect(isTransportError(a)).toBe(false)
    expect(classifyError(a).kind).toBe('unknown')
  })

  it('only looks a bounded depth down the cause chain', () => {
    let e: unknown = { code: 'ECONNRESET' }
    for (let i = 0; i < 12; i++) e = { message: `level ${i}`, cause: e }
    expect(isTransportError(e)).toBe(false)
  })
})

describe('causeChain', () => {
  it('lists the value then its causes, outermost first', () => {
    const inner = { message: 'inner' }
    const middle = { message: 'middle', cause: inner }
    const outer = new Error('outer', { cause: middle })
    expect(causeChain(outer)).toEqual([outer, middle, inner])
  })

  it('is empty for non-objects', () => {
    for (const v of [undefined, null, 'x', 5, true]) expect(causeChain(v)).toEqual([])
  })

  it('stops at a cycle and at 8 nodes', () => {
    const a: { cause?: unknown } = {}
    const b = { cause: a }
    a.cause = b
    expect(causeChain(a)).toEqual([a, b])
    let e: unknown = { depth: 'end' }
    for (let i = 0; i < 12; i++) e = { cause: e }
    expect(causeChain(e)).toHaveLength(8)
  })
})

describe('isTransportError', () => {
  it('is false for non-objects and for LlmErrors without a transport cause', () => {
    for (const v of [undefined, null, 'ECONNRESET', 5, true]) {
      expect(isTransportError(v)).toBe(false)
    }
    expect(isTransportError(new LlmError('x', { kind: 'server', retryable: true }))).toBe(
      false,
    )
  })

  it('finds a transport failure under an LlmError cause', () => {
    const inner = Object.assign(new Error('x'), { code: 'EPIPE' })
    expect(
      isTransportError(
        new LlmError('wrapped', { kind: 'unknown', retryable: false, cause: inner }),
      ),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// parseRetryAfter (R4.6)
// ---------------------------------------------------------------------------

describe('parseRetryAfter', () => {
  const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)

  it('reads retry-after-ms, decimals allowed, rounding up', () => {
    expect(parseRetryAfter({ 'retry-after-ms': '1500' }, NOW)).toBe(1500)
    expect(parseRetryAfter({ 'retry-after-ms': '1500.2' }, NOW)).toBe(1501)
  })

  it('retry-after-ms wins over retry-after', () => {
    expect(parseRetryAfter({ 'retry-after-ms': '250', 'retry-after': '60' }, NOW)).toBe(
      250,
    )
  })

  it('reads retry-after as delta-seconds, decimals allowed', () => {
    expect(parseRetryAfter({ 'retry-after': '60' }, NOW)).toBe(60_000)
    expect(parseRetryAfter({ 'retry-after': '1.5' }, NOW)).toBe(1_500)
    expect(parseRetryAfter({ 'retry-after': ' 7 ' }, NOW)).toBe(7_000)
  })

  it('reads retry-after as an HTTP-date relative to now', () => {
    expect(parseRetryAfter({ 'retry-after': 'Sat, 03 Oct 2026 12:00:30 GMT' }, NOW)).toBe(
      30_000,
    )
    expect(
      parseRetryAfter({ 'retry-after': 'Saturday, 03-Oct-26 12:01:00 GMT' }, NOW),
    ).toBe(60_000)
    expect(parseRetryAfter({ 'retry-after': 'Sat Oct  3 12:02:00 2026' }, NOW)).toBe(
      120_000,
    )
  })

  it('ignores an HTTP-date in the past', () => {
    expect(
      parseRetryAfter({ 'retry-after': 'Sat, 03 Oct 2026 11:59:00 GMT' }, NOW),
    ).toBeUndefined()
  })

  it('reads Go-style durations such as 6m0s', () => {
    expect(parseRetryAfter({ 'retry-after': '6m0s' }, NOW)).toBe(360_000)
    expect(parseRetryAfter({ 'x-ratelimit-reset-requests': '6m0s' }, NOW)).toBe(360_000)
    expect(parseRetryAfter({ 'x-ratelimit-reset-tokens': '1h2m3.5s' }, NOW)).toBe(
      3_723_500,
    )
    expect(parseRetryAfter({ 'x-ratelimit-reset-requests': '250ms' }, NOW)).toBe(250)
    expect(parseRetryAfter({ 'x-ratelimit-reset-requests': '1m30s500ms' }, NOW)).toBe(
      90_500,
    )
  })

  it('treats x-ratelimit-reset above 1e9 as epoch seconds', () => {
    const epochSeconds = String(NOW / 1000 + 45)
    expect(parseRetryAfter({ 'x-ratelimit-reset': epochSeconds }, NOW)).toBe(45_000)
  })

  it('treats a small x-ratelimit-reset as seconds from now', () => {
    expect(parseRetryAfter({ 'x-ratelimit-reset': '12' }, NOW)).toBe(12_000)
    expect(parseRetryAfter({ 'x-ratelimit-reset': '999999999' }, NOW)).toBe(
      24 * 60 * 60 * 1000,
    )
  })

  it('an epoch reset in the past is ignored, not a 56-year delay', () => {
    expect(
      parseRetryAfter({ 'x-ratelimit-reset': '1790000000' }, 1_800_000_000_000),
    ).toBe(undefined)
  })

  it('takes the shortest reset when the exhausted limit cannot be told apart', () => {
    expect(
      parseRetryAfter(
        {
          'x-ratelimit-reset': '5',
          'x-ratelimit-reset-requests': '1s',
          'x-ratelimit-reset-tokens': '20s',
        },
        NOW,
      ),
    ).toBe(1_000)
  })

  it('OpenAI shape: 1 s token reset beside a 6 m request reset waits 1 s, not 6 m', () => {
    const headers = {
      'x-ratelimit-limit-requests': '500',
      'x-ratelimit-remaining-requests': '499',
      'x-ratelimit-reset-requests': '6m0s',
      'x-ratelimit-limit-tokens': '30000',
      'x-ratelimit-remaining-tokens': '0',
      'x-ratelimit-reset-tokens': '1s',
    }
    expect(parseRetryAfter(headers, NOW)).toBe(1_000)
    // The same two windows without remaining counts: the earliest reset.
    const {
      'x-ratelimit-remaining-requests': _a,
      'x-ratelimit-remaining-tokens': _b,
      ...bare
    } = headers
    expect(parseRetryAfter(bare, NOW)).toBe(1_000)
  })

  it('waits for every exhausted window: the longest of their resets', () => {
    expect(
      parseRetryAfter(
        {
          'x-ratelimit-remaining-requests': '0',
          'x-ratelimit-reset-requests': '6m0s',
          'x-ratelimit-remaining-tokens': '0',
          'x-ratelimit-reset-tokens': '1s',
        },
        NOW,
      ),
    ).toBe(360_000)
  })

  it('ignores the windows that still have capacity once one is exhausted', () => {
    expect(
      parseRetryAfter(
        {
          'x-ratelimit-remaining-requests': '12',
          'x-ratelimit-reset-requests': '6m0s',
          'x-ratelimit-remaining-tokens': '0',
          'x-ratelimit-reset-tokens': '45s',
        },
        NOW,
      ),
    ).toBe(45_000)
  })

  it('pairs the bare x-ratelimit-remaining with x-ratelimit-reset', () => {
    expect(
      parseRetryAfter(
        {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '30',
          'x-ratelimit-reset-tokens': '2s',
        },
        NOW,
      ),
    ).toBe(30_000)
  })

  it('reads the IETF ratelimit-reset (delta-seconds)', () => {
    expect(parseRetryAfter({ 'ratelimit-reset': '17' }, NOW)).toBe(17_000)
    expect(
      parseRetryAfter({ 'ratelimit-remaining': '0', 'ratelimit-reset': '17' }, NOW),
    ).toBe(17_000)
  })

  it('treats a reset above 1e12 as epoch milliseconds', () => {
    expect(parseRetryAfter({ 'x-ratelimit-reset': String(NOW + 45_000) }, NOW)).toBe(
      45_000,
    )
    // In the past: ignored, not a multi-decade delay.
    expect(parseRetryAfter({ 'x-ratelimit-reset': String(NOW - 1_000) }, NOW)).toBe(
      undefined,
    )
  })

  it('prefers retry-after over the reset family', () => {
    expect(parseRetryAfter({ 'retry-after': '3', 'x-ratelimit-reset': '90' }, NOW)).toBe(
      3_000,
    )
  })

  it('falls through to the next header when one is unusable', () => {
    expect(parseRetryAfter({ 'retry-after-ms': 'soon', 'retry-after': '5' }, NOW)).toBe(
      5_000,
    )
    expect(
      parseRetryAfter({ 'retry-after': 'tomorrow', 'x-ratelimit-reset': '8' }, NOW),
    ).toBe(8_000)
  })

  it('caps at 24 hours', () => {
    const day = 24 * 60 * 60 * 1000
    expect(parseRetryAfter({ 'retry-after': '99999999' }, NOW)).toBe(day)
    expect(parseRetryAfter({ 'retry-after-ms': '999999999999' }, NOW)).toBe(day)
    expect(parseRetryAfter({ 'retry-after': 'Wed, 21 Oct 2037 07:28:00 GMT' }, NOW)).toBe(
      day,
    )
  })

  it.each(['', '  ', '0', '0.0', '-5', 'NaN', 'Infinity', '1e3', 'retry 5', '5 seconds'])(
    'ignores the unusable value %j',
    (value) => {
      expect(parseRetryAfter({ 'retry-after': value }, NOW)).toBeUndefined()
      expect(parseRetryAfter({ 'x-ratelimit-reset': value }, NOW)).toBeUndefined()
    },
  )

  it('matches header names case-insensitively in a plain record', () => {
    expect(parseRetryAfter({ 'Retry-After': '9' }, NOW)).toBe(9_000)
    expect(parseRetryAfter({ 'RETRY-AFTER-MS': '40' }, NOW)).toBe(40)
  })

  it('accepts number and array values in a plain record', () => {
    expect(parseRetryAfter({ 'retry-after': 12 }, NOW)).toBe(12_000)
  })

  it('reads every element of an array value and honours the longest retry-after', () => {
    expect(parseRetryAfter({ 'retry-after': ['4', '99'] }, NOW)).toBe(99_000)
    expect(parseRetryAfter({ 'retry-after-ms': ['40', 250, 'x'] }, NOW)).toBe(250)
    expect(parseRetryAfter({ 'x-ratelimit-reset-tokens': ['9s', '3s'] }, NOW)).toBe(3_000)
  })

  it('reads duplicate headers merged into one comma-joined string', () => {
    expect(parseRetryAfter({ 'retry-after': '5, 10' }, NOW)).toBe(10_000)
    expect(parseRetryAfter({ 'retry-after-ms': '500,1500' }, NOW)).toBe(1_500)
    // An HTTP-date keeps its own comma.
    expect(parseRetryAfter({ 'retry-after': 'Sat, 03 Oct 2026 12:00:30 GMT' }, NOW)).toBe(
      30_000,
    )
  })

  it('reads a leading-dot decimal', () => {
    expect(parseRetryAfter({ 'retry-after': '.5' }, NOW)).toBe(500)
  })

  it('a number too large for a double is the cap, not undefined', () => {
    const day = 24 * 60 * 60 * 1000
    expect(parseRetryAfter({ 'retry-after': '9'.repeat(400) }, NOW)).toBe(day)
    expect(parseRetryAfter({ 'retry-after': '9'.repeat(23) }, NOW)).toBe(day)
  })

  it('reads a Headers object', () => {
    const headers = new Headers({
      'Retry-After': '2.5',
      'x-ratelimit-reset-tokens': '1m',
    })
    expect(parseRetryAfter(headers, NOW)).toBe(2_500)
    expect(parseRetryAfter(new Headers({ 'x-ratelimit-reset-tokens': '1m' }), NOW)).toBe(
      60_000,
    )
  })

  it('returns undefined when no header is present', () => {
    expect(parseRetryAfter({}, NOW)).toBeUndefined()
    expect(parseRetryAfter(new Headers(), NOW)).toBeUndefined()
  })

  it('classifyError carries the parsed delay on the LlmError', () => {
    const date = new Date(Date.now() + 45_000).toUTCString()
    const viaDate = classifyError({ status: 429, headers: { 'retry-after': date } })
    expect(viaDate.retryAfterMs).toBeGreaterThan(40_000)
    expect(viaDate.retryAfterMs).toBeLessThanOrEqual(45_000)

    const viaEpoch = classifyError({
      status: 429,
      headers: { 'x-ratelimit-reset': '1790000000' },
    })
    expect(
      viaEpoch.retryAfterMs === undefined || viaEpoch.retryAfterMs <= 86_400_000,
    ).toBe(true)

    expect(
      classifyError({ status: 429, headers: { 'retry-after-ms': '750' } }).retryAfterMs,
    ).toBe(750)
    expect(
      classifyError({ status: 429, headers: { 'x-ratelimit-reset-requests': '6m0s' } })
        .retryAfterMs,
    ).toBe(360_000)
    expect(classifyError({ status: 429, retryAfterMs: 9e12 }).retryAfterMs).toBe(
      86_400_000,
    )
    expect(classifyError({ status: 429, retryAfterMs: 0 }).retryAfterMs).toBeUndefined()
  })
})
