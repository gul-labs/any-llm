/**
 * @gullabs/google — classifyGoogleError unit tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { LlmError } from '@gullabs/core'
import { classifyGoogleError } from './errors.js'

describe('classifyGoogleError', () => {
  it('preserves kind/retryable of an already-classified LlmError, tagging provider: google', () => {
    const original = new LlmError('boom', { kind: 'timeout', retryable: true })
    const result = classifyGoogleError(original)
    expect(result.kind).toBe('timeout')
    expect(result.retryable).toBe(true)
    expect(result.provider).toBe('google')
  })

  it('still routes a real HTTP status through classifyHttpStatus (500 → server, retryable)', () => {
    const result = classifyGoogleError({ status: 500 })
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
    expect(result.provider).toBe('google')
  })

  it('still routes 401 → invalid_auth, not retryable', () => {
    const result = classifyGoogleError({ status: 401 })
    expect(result.kind).toBe('invalid_auth')
    expect(result.retryable).toBe(false)
  })

  it('classifies a structured Gemini NOT_FOUND model-access response as bad_request', () => {
    const err = new Error(
      JSON.stringify({
        error: {
          code: 404,
          status: 'NOT_FOUND',
          message: 'This model is no longer available to new users.',
        },
      }),
    ) as Error & { status: number }
    err.status = 404
    const result = classifyGoogleError(err)
    expect(result).toMatchObject({
      kind: 'bad_request',
      retryable: false,
      httpStatus: 404,
      provider: 'google',
    })
  })

  it('classifies undici "fetch failed" TypeError as retryable server, not unknown', () => {
    const result = classifyGoogleError(new TypeError('fetch failed'))
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
    expect(result.provider).toBe('google')
  })

  it('detects a transport failure wrapped as .cause (undici fetch-failed shape)', () => {
    const causeErr = new Error('connect ECONNREFUSED 127.0.0.1:443') as Error & {
      code: string
    }
    causeErr.code = 'ECONNREFUSED'
    const fetchFailed = new TypeError('fetch failed') as TypeError & { cause?: unknown }
    fetchFailed.cause = causeErr
    const result = classifyGoogleError(fetchFailed)
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
  })

  it.each(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'])(
    'classifies a Node errno %s (on .code) as retryable server',
    (code) => {
      const err = new Error(`read ${code}`) as Error & { code: string }
      err.code = code
      const result = classifyGoogleError(err)
      expect(result.kind).toBe('server')
      expect(result.retryable).toBe(true)
    },
  )

  it('classifies "socket hang up" as retryable server', () => {
    const result = classifyGoogleError(new Error('socket hang up'))
    expect(result.kind).toBe('server')
    expect(result.retryable).toBe(true)
  })

  it('threads servedServiceTier through when provided', () => {
    const result = classifyGoogleError(new TypeError('fetch failed'), {
      servedServiceTier: 'standard',
    })
    expect(result.servedServiceTier).toBe('standard')
  })

  it('does not reclassify an unrelated unknown error as retryable', () => {
    const result = classifyGoogleError(new Error('something totally unrelated broke'))
    expect(result.kind).toBe('unknown')
    expect(result.retryable).toBe(false)
  })
})
