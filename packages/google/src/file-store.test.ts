/**
 * GoogleFileStore unit tests.
 *
 * All tests use an injected fake GeminiFilesClientLike — no network.
 * sleep is injected as () => Promise.resolve() for instant polling.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest'
import { LlmError, createClient } from '@gullabs/core'
import {
  FakeClock,
  RecordingSink,
  fakeGeminiResponse,
  makeFakeGemini,
} from '@gullabs/testing'
import { geminiAdapter } from './adapter.js'
import { geminiPricingSource } from './cost.js'
import { defaultGeminiRegistry } from './models.js'
import { GoogleFileStore } from './file-store.js'
import type { GeminiFilesClientLike, GoogleFileHandle } from './file-store.js'

// ---------------------------------------------------------------------------
// Mock @google/genai — vi.mock factories are hoisted above imports, so all
// state must be created inside the factory via vi.hoisted. Only used by the
// getClient() lazy-build / clientOverride-short-circuit tests below; every
// other test in this file injects a fake GeminiFilesClientLike instead.
// ---------------------------------------------------------------------------

const { constructorCalls, uploadMock, getMock, deleteMock } = vi.hoisted(() => {
  return {
    constructorCalls: [] as unknown[],
    uploadMock: vi.fn().mockResolvedValue({
      name: 'files/lazy123',
      uri: 'https://example.com/files/lazy123',
      mimeType: 'image/png',
      state: 'ACTIVE',
    }),
    getMock: vi.fn(),
    deleteMock: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    files: { upload: typeof uploadMock; get: typeof getMock; delete: typeof deleteMock }
    constructor(args: unknown) {
      constructorCalls.push(args)
      this.files = { upload: uploadMock, get: getMock, delete: deleteMock }
    }
  }
  return { GoogleGenAI }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeAuth = { apiKey: 'test-key' }
const fastSleep = (): Promise<void> => Promise.resolve()

function makeClient(
  overrides: Partial<GeminiFilesClientLike> = {},
): GeminiFilesClientLike {
  return {
    upload: vi.fn().mockResolvedValue({
      name: 'files/abc123',
      uri: 'https://example.com/files/abc123',
      mimeType: 'image/png',
      state: 'ACTIVE',
    }),
    get: vi.fn().mockResolvedValue({
      name: 'files/abc123',
      uri: 'https://example.com/files/abc123',
      mimeType: 'image/png',
      state: 'ACTIVE',
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GoogleFileStore media-type admission (same rule as generate)', () => {
  it('uploads admitted types, case and parameters aside, sending the string unchanged', async () => {
    for (const type of [
      'text/csv',
      'video/quicktime',
      'IMAGE/PNG',
      'text/plain; charset=utf-8',
    ]) {
      const client = makeClient()
      const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
      await store.upload(new Uint8Array([1]), type)
      expect(client.upload).toHaveBeenCalledWith(
        expect.objectContaining({ config: expect.objectContaining({ mimeType: type }) }),
      )
    }
  })

  it('rejects an empty or unadmitted type before the SDK is called', async () => {
    for (const type of ['', ' ', 'application/json', 'image/*']) {
      const client = makeClient()
      const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
      await expect(store.upload(new Uint8Array([1]), type), type).rejects.toMatchObject({
        kind: 'bad_request',
        retryable: false,
      })
      expect(client.upload).not.toHaveBeenCalled()
    }
  })

  it('a type generate accepts is a type upload accepts, and the reverse', async () => {
    const { client: llm, fake } = (() => {
      const f = makeFakeGemini(fakeGeminiResponse({ text: 'ok' }))
      return {
        fake: f,
        client: createClient({
          adapters: [geminiAdapter({ client: f })],
          pricingSources: { google: geminiPricingSource() },
          modelRegistry: defaultGeminiRegistry,
          sink: new RecordingSink(),
        }),
      }
    })()
    for (const type of [
      'text/csv',
      'video/mov',
      'application/pdf',
      'application/json',
      'font/ttf',
      '',
    ]) {
      const uploadOk = await new GoogleFileStore({
        auth: fakeAuth,
        client: makeClient(),
        sleep: fastSleep,
      })
        .upload(new Uint8Array([1]), type)
        .then(
          () => true,
          () => false,
        )
      const before = fake.calls.length
      const generateOk = await llm
        .generate(
          {
            provider: 'google',
            model: 'gemini-3.6-flash',
            messages: [
              {
                role: 'user',
                parts: [{ kind: 'file-uri', mimeType: type, uri: 'https://x.test/f' }],
              },
            ],
          },
          { auth: fakeAuth },
        )
        .then(
          () => true,
          () => false,
        )
      expect(generateOk, `generate ${type}`).toBe(uploadOk)
      expect(fake.calls.length > before, type).toBe(generateOk)
    }
  })
})

describe('GoogleFileStore', () => {
  // 1. ACTIVE immediately — no polling
  it('returns a handle when upload state is ACTIVE immediately', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'ACTIVE',
        expirationTime: '2026-07-01T00:00:00Z',
      }),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const handle = await store.upload(new Uint8Array([1, 2, 3]), 'image/png')

    expect(handle.name).toBe('files/abc123')
    expect(handle.uri).toBe('https://example.com/files/abc123')
    expect(handle.mimeType).toBe('image/png')
    expect(client.get).not.toHaveBeenCalled()
  })

  // 2. Polls through PROCESSING then ACTIVE
  it('polls through PROCESSING then resolves when ACTIVE', async () => {
    const getResponses = [
      {
        state: 'PROCESSING',
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
      },
      {
        state: 'PROCESSING',
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
      },
      {
        state: 'ACTIVE',
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
      },
    ]
    let getCallIdx = 0

    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockImplementation(() => Promise.resolve(getResponses[getCallIdx++])),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const handle = await store.upload(new Uint8Array([1]), 'image/png')

    expect(handle.name).toBe('files/abc123')
    expect(client.get).toHaveBeenCalledTimes(3)
  })

  // 3. FAILED state → LlmError kind === 'bad_request'
  it('throws LlmError bad_request when upload state is FAILED immediately', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'FAILED',
      }),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    await expect(store.upload(new Uint8Array([1]), 'image/png')).rejects.toMatchObject({
      kind: 'bad_request',
      retryable: false,
    })
    await expect(store.upload(new Uint8Array([1]), 'image/png')).rejects.toBeInstanceOf(
      LlmError,
    )
  })

  it('throws LlmError bad_request when FAILED during polling', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'FAILED',
      }),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const err = await store.upload(new Uint8Array([1]), 'image/png').catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('bad_request')
    expect((err as LlmError).retryable).toBe(false)
  })

  it('keeps the provider File.error message and status on FAILED (immediately and while polling)', async () => {
    const fileError = { code: 3, message: 'The file could not be decoded as video/mp4.' }
    const failedImmediately = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'video/mp4',
        state: 'FAILED',
        error: fileError,
      }),
    })
    const store = new GoogleFileStore({
      auth: fakeAuth,
      client: failedImmediately,
      sleep: fastSleep,
    })
    const first = (await store
      .upload(new Uint8Array([1]), 'video/mp4')
      .catch((e) => e)) as LlmError
    expect(first).toMatchObject({
      kind: 'bad_request',
      retryable: false,
      provider: 'google',
    })
    expect(first.message).toContain('The file could not be decoded as video/mp4.')
    expect(first.cause).toEqual(fileError)

    const failedWhilePolling = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'video/mp4',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        state: 'FAILED',
        error: fileError,
      }),
    })
    const polling = new GoogleFileStore({
      auth: fakeAuth,
      client: failedWhilePolling,
      sleep: fastSleep,
    })
    const second = (await polling
      .upload(new Uint8Array([1]), 'video/mp4')
      .catch((e) => e)) as LlmError
    expect(second.message).toContain('The file could not be decoded as video/mp4.')
    expect(second.cause).toEqual(fileError)
  })

  it('a FAILED file with no provider error keeps the plain message', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        state: 'FAILED',
      }),
    })
    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const err = (await store
      .upload(new Uint8Array([1]), 'image/png')
      .catch((e) => e)) as LlmError
    expect(err.message).toBe('File processing failed immediately after upload')
    expect(err.cause).toBeUndefined()
  })

  it('passes the signal to the SDK upload config', async () => {
    const controller = new AbortController()
    const client = makeClient()
    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    await store.upload(new Uint8Array([1]), 'image/png', { signal: controller.signal })
    const call = (client.upload as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      config: { abortSignal?: AbortSignal }
    }
    expect(call.config.abortSignal).toBe(controller.signal)
  })

  it('an abort during the upload rejects with aborted at once, though the SDK call never settles', async () => {
    const controller = new AbortController()
    const client = makeClient({ upload: vi.fn().mockReturnValue(new Promise(() => {})) })
    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const pending = store
      .upload(new Uint8Array([1]), 'image/png', { signal: controller.signal })
      .catch((e) => e)
    controller.abort()
    const err = (await pending) as LlmError
    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({ kind: 'aborted', retryable: false })
  })

  it('an already-aborted signal rejects before the SDK is called', async () => {
    const controller = new AbortController()
    controller.abort()
    const client = makeClient()
    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    await expect(
      store.upload(new Uint8Array([1]), 'image/png', { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'aborted' })
    expect(client.upload).not.toHaveBeenCalled()
  })

  // 4. Poll timeout → server, not retryable (ADR-036: `timeout` is always retryable)
  it('throws a non-retryable server error when polling exceeds timeoutMs', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockResolvedValue({
        state: 'PROCESSING',
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
      }),
    })

    // Zero timeout to trigger immediately
    const store = new GoogleFileStore({
      auth: fakeAuth,
      client,
      sleep: fastSleep,
      poll: { timeoutMs: 0, intervalMs: 0 },
    })
    const err = await store.upload(new Uint8Array([1]), 'image/png').catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    // Not `timeout`: ADR-036 makes every `timeout` retryable, and a retry here
    // would upload the bytes again and orphan the first file.
    expect(err).toMatchObject({ kind: 'server', retryable: false, provider: 'google' })
  })

  // 5. expiresAt is Date when expirationTime present; absent (not undefined key) when not
  it('maps expirationTime to expiresAt Date when present', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'ACTIVE',
        expirationTime: '2026-07-01T00:00:00Z',
      }),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const handle = await store.upload(new Uint8Array([1]), 'image/png')
    expect(handle.expiresAt).toBeInstanceOf(Date)
    expect(handle.expiresAt?.toISOString()).toBe('2026-07-01T00:00:00.000Z')
  })

  it('omits expiresAt key entirely when expirationTime is absent', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'ACTIVE',
        // no expirationTime
      }),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const handle = await store.upload(new Uint8Array([1]), 'image/png')
    expect('expiresAt' in handle).toBe(false)
  })

  // 6. delete swallows error and calls onDeleteError
  it('swallows delete error and calls onDeleteError with the name', async () => {
    const deleteError = new Error('network error')
    const client = makeClient({
      delete: vi.fn().mockRejectedValue(deleteError),
    })
    const onDeleteError = vi.fn()

    const store = new GoogleFileStore({
      auth: fakeAuth,
      client,
      sleep: fastSleep,
      onDeleteError,
    })
    const handle: GoogleFileHandle = {
      name: 'files/abc123',
      uri: 'u',
      mimeType: 'image/png',
    }

    // Should not throw
    await expect(store.delete(handle)).resolves.toBeUndefined()
    expect(onDeleteError).toHaveBeenCalledTimes(1)
    expect(onDeleteError.mock.calls[0]?.[0]).toBe('files/abc123')
    expect(onDeleteError.mock.calls[0]?.[1]).toBeInstanceOf(LlmError)
  })

  it('failClosed delete throws and does not call onDeleteError', async () => {
    const client = makeClient({
      delete: vi.fn().mockRejectedValue({ status: 500, message: 'server' }),
    })
    const onDeleteError = vi.fn()
    const store = new GoogleFileStore({
      auth: fakeAuth,
      client,
      sleep: fastSleep,
      onDeleteError,
    })
    const handle: GoogleFileHandle = {
      name: 'files/abc123',
      uri: 'u',
      mimeType: 'image/png',
    }
    await expect(store.delete(handle, { failClosed: true })).rejects.toMatchObject({
      kind: 'server',
      provider: 'google',
    })
    expect(onDeleteError).not.toHaveBeenCalled()
  })

  it('failClosed delete treats not-found as success', async () => {
    const client = makeClient({
      delete: vi.fn().mockRejectedValue({ status: 404, message: 'file not found' }),
    })
    const onDeleteError = vi.fn()
    const store = new GoogleFileStore({
      auth: fakeAuth,
      client,
      sleep: fastSleep,
      onDeleteError,
    })
    await expect(
      store.delete(
        { name: 'files/gone', uri: 'u', mimeType: 'image/png' },
        { failClosed: true },
      ),
    ).resolves.toBeUndefined()
    expect(onDeleteError).not.toHaveBeenCalled()
  })

  it('empty handle.name throws bad_request', async () => {
    const onDeleteError = vi.fn()
    const store = new GoogleFileStore({
      auth: fakeAuth,
      client: makeClient(),
      sleep: fastSleep,
      onDeleteError,
    })
    await expect(
      store.delete({ name: '  ', uri: 'u', mimeType: 'image/png' }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(onDeleteError).not.toHaveBeenCalled()
  })

  it('failClosed deleteAll fails fast', async () => {
    const client = makeClient({
      delete: vi.fn().mockRejectedValue({ status: 500 }),
    })
    const store = new GoogleFileStore({
      auth: fakeAuth,
      client,
      sleep: fastSleep,
      onDeleteError: vi.fn(),
    })
    await expect(
      store.deleteAll([{ name: 'files/a', uri: 'u', mimeType: 'image/png' }], {
        failClosed: true,
      }),
    ).rejects.toMatchObject({ kind: 'server' })
  })

  it('failClosed respects pre-aborted signal', async () => {
    const ac = new AbortController()
    ac.abort()
    const client = makeClient({ delete: vi.fn() })
    const store = new GoogleFileStore({
      auth: fakeAuth,
      client,
      sleep: fastSleep,
      onDeleteError: vi.fn(),
    })
    await expect(
      store.delete(
        { name: 'files/a', uri: 'u', mimeType: 'image/png' },
        { failClosed: true, signal: ac.signal },
      ),
    ).rejects.toMatchObject({ kind: 'aborted' })
    expect(client.delete).not.toHaveBeenCalled()
  })

  // NEW: deterministic timeout via injected now (not just timeoutMs:0)
  it('times out based on injected clock across multiple polls', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
    })

    // Injected clock: starts at 0, is past the deadline (5000) once the first wait ends
    let tick = 0
    const now = () => (tick === 0 ? 0 : 5_001)
    const countingSleep = (): Promise<void> => {
      tick++
      return Promise.resolve()
    }

    const store = new GoogleFileStore({
      auth: fakeAuth,
      client,
      sleep: countingSleep,
      now,
      poll: { timeoutMs: 5_000, intervalMs: 0 },
    })

    const err = await store.upload(new Uint8Array([1]), 'image/png').catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({ kind: 'server', retryable: false })
    // The virtual clock crossed the deadline during the wait: no poll started
    expect(client.get).not.toHaveBeenCalled()
  })

  // NEW: client.upload throwing → classified LlmError (not raw object)
  it('classifies raw SDK error from client.upload as LlmError', async () => {
    const sdkError = Object.assign(new Error('SDK boom'), { status: 503 })
    const client = makeClient({
      upload: vi.fn().mockRejectedValue(sdkError),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const err = await store.upload(new Uint8Array([1]), 'image/png').catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    // Must NOT be the raw SDK error object
    expect(err).not.toBe(sdkError)
  })

  // NEW: client.get throwing during poll → classified LlmError
  it('classifies raw SDK error from client.get during polling as LlmError', async () => {
    const sdkError = Object.assign(new Error('network glitch'), { status: 500 })
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockRejectedValue(sdkError),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const err = await store.upload(new Uint8Array([1]), 'image/png').catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err).not.toBe(sdkError)
  })

  // NEW: default onDeleteError logs sanitized message, NOT raw error
  it('default onDeleteError logs a sanitized message without the raw error object', async () => {
    const rawErr = Object.assign(new Error('secret-api-key-in-message'), {
      secretField: 'supersecret',
    })
    const client = makeClient({
      delete: vi.fn().mockRejectedValue(rawErr),
    })

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // No onDeleteError override → uses default sanitized handler
      const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
      const handle: GoogleFileHandle = {
        name: 'files/abc123',
        uri: 'u',
        mimeType: 'image/png',
      }
      await store.delete(handle)

      expect(consoleSpy).toHaveBeenCalledOnce()
      // The raw Error object must NOT appear as any argument
      const callArgs = consoleSpy.mock.calls[0]!
      expect(callArgs).not.toContain(rawErr)
      // The second arg (sanitized message) must be a string, not an object
      expect(typeof callArgs[1]).toBe('string')
    } finally {
      consoleSpy.mockRestore()
    }
  })

  // Abort signal tests (FIX 6)
  it('rejects with kind aborted when AbortSignal is already aborted before polling starts', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockResolvedValue({
        state: 'PROCESSING',
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
      }),
    })

    const controller = new AbortController()
    controller.abort() // Already aborted before upload call

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const err = await store
      .upload(new Uint8Array([1]), 'image/png', { signal: controller.signal })
      .catch((e) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('aborted')
    // get should NOT have been called — aborted before first poll
    expect(client.get).not.toHaveBeenCalled()
  })

  it('rejects with kind aborted and stops polling when signal fires mid-PROCESSING', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockResolvedValue({
        state: 'PROCESSING',
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
      }),
    })

    const controller = new AbortController()

    // Sleep that aborts the controller on its first call, simulating mid-poll abort
    let sleepCount = 0
    const abortingSleep = (): Promise<void> => {
      sleepCount++
      if (sleepCount === 1) controller.abort()
      return Promise.resolve()
    }

    const store = new GoogleFileStore({
      auth: fakeAuth,
      client,
      sleep: abortingSleep,
      poll: { timeoutMs: 300_000, intervalMs: 0 },
    })

    const err = await store
      .upload(new Uint8Array([1]), 'image/png', { signal: controller.signal })
      .catch((e) => e)

    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('aborted')
    // Polling stopped — get was called at most once (the one poll after first sleep)
    // before the next iteration detects the abort
    expect(client.get).toHaveBeenCalledTimes(1)
  })

  // NEW: default sleep (not injected) uses the real setTimeout-based realSleep
  it('defaults sleep to the real timer-based implementation when not injected', async () => {
    const getResponses = [
      {
        state: 'PROCESSING',
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
      },
      {
        state: 'ACTIVE',
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
      },
    ]
    let getCallIdx = 0
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockImplementation(() => Promise.resolve(getResponses[getCallIdx++])),
    })

    // No `sleep` override — exercises the real setTimeout-based default.
    // intervalMs: 0 keeps the real timer delay negligible for the test.
    const store = new GoogleFileStore({ auth: fakeAuth, client, poll: { intervalMs: 0 } })
    const handle = await store.upload(new Uint8Array([1]), 'image/png')

    expect(handle.name).toBe('files/abc123')
    expect(client.get).toHaveBeenCalledTimes(2)
  }, 10_000)

  it('polls on the injected scheduler: a FakeClock fires the wait and the poll timeout', async () => {
    const clock = new FakeClock()
    const processing = {
      name: 'files/abc123',
      uri: 'https://example.com/files/abc123',
      mimeType: 'image/png',
      state: 'PROCESSING',
    }
    const client = makeClient({
      upload: vi.fn().mockResolvedValue(processing),
      get: vi.fn().mockResolvedValue(processing),
    })
    const store = new GoogleFileStore({
      auth: fakeAuth,
      client,
      scheduler: clock,
      now: () => clock.now(),
      poll: { intervalMs: 3_000, timeoutMs: 10_000 },
    })
    const settled = store
      .upload(new Uint8Array([1]), 'image/png')
      .catch((e: unknown) => e)

    await clock.advanceAsync(0)
    expect(client.get).not.toHaveBeenCalled()
    // the wait, and the deadline it is raced against
    expect(clock.pendingTimers).toBe(2)
    await clock.advanceAsync(3_000)
    expect(client.get).toHaveBeenCalledTimes(1)
    await clock.advanceAsync(3_000)
    await clock.advanceAsync(3_000)
    await clock.advanceAsync(3_000)

    const err = await settled
    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({ kind: 'server', retryable: false })
    expect(clock.pendingTimers).toBe(0)
  })

  describe('polling never returns a handle after its deadline', () => {
    const processing = {
      name: 'files/abc123',
      uri: 'https://example.com/files/abc123',
      mimeType: 'image/png',
      state: 'PROCESSING',
    }
    const active = { ...processing, state: 'ACTIVE' }

    it('a poll interval longer than the time left ends at the deadline: no poll starts, no handle comes back', async () => {
      const clock = new FakeClock()
      const client = makeClient({
        upload: vi.fn().mockResolvedValue(processing),
        get: vi.fn().mockResolvedValue(active),
      })
      const store = new GoogleFileStore({
        auth: fakeAuth,
        client,
        scheduler: clock,
        now: () => clock.now(),
        poll: { timeoutMs: 1_000, intervalMs: 3_000 },
      })
      const settled = store
        .upload(new Uint8Array([1]), 'image/png')
        .catch((e: unknown) => e)
      await clock.advanceAsync(1_000)
      const err = await settled
      expect(err).toBeInstanceOf(LlmError)
      expect(err).toMatchObject({ kind: 'server', retryable: false, provider: 'google' })
      expect((err as LlmError).message).toContain('Timed out waiting')
      expect(client.get).not.toHaveBeenCalled()
      // the wait that lost the race was cleared: nothing stays pending
      expect(clock.pendingTimers).toBe(0)
      expect(client.get).not.toHaveBeenCalled()
    })

    it('an abort that wins the race clears the wait: no timer stays pending', async () => {
      const clock = new FakeClock()
      const client = makeClient({
        upload: vi.fn().mockResolvedValue(processing),
        get: vi.fn().mockResolvedValue(active),
      })
      const store = new GoogleFileStore({
        auth: fakeAuth,
        client,
        scheduler: clock,
        now: () => clock.now(),
        poll: { timeoutMs: 600_000, intervalMs: 300_000 },
      })
      const ac = new AbortController()
      const settled = store
        .upload(new Uint8Array([1]), 'image/png', { signal: ac.signal })
        .catch((e: unknown) => e)
      await clock.advanceAsync(0)
      // the wait, and the deadline it is raced against
      expect(clock.pendingTimers).toBe(2)
      ac.abort()
      const err = await settled
      expect(err).toMatchObject({ kind: 'aborted' })
      expect(clock.pendingTimers).toBe(0)
    })

    it('a host-supplied sleep is awaited as given: the deadline still ends the upload', async () => {
      const clock = new FakeClock()
      const hostTimers: ReturnType<FakeClock['setTimeout']>[] = []
      const client = makeClient({
        upload: vi.fn().mockResolvedValue(processing),
        get: vi.fn().mockResolvedValue(active),
      })
      const store = new GoogleFileStore({
        auth: fakeAuth,
        client,
        scheduler: clock,
        now: () => clock.now(),
        sleep: (ms) =>
          new Promise<void>((resolve) => {
            hostTimers.push(clock.setTimeout(resolve, ms))
          }),
        poll: { timeoutMs: 1_000, intervalMs: 3_000 },
      })
      const settled = store
        .upload(new Uint8Array([1]), 'image/png')
        .catch((e: unknown) => e)
      await clock.advanceAsync(1_000)
      expect(await settled).toMatchObject({ kind: 'server', retryable: false })
      // only the host's own, non-cancellable timer is left
      expect(hostTimers).toHaveLength(1)
      expect(clock.pendingTimers).toBe(1)
    })

    it('a completed upload leaves no timer pending, whatever the poll interval', async () => {
      const clock = new FakeClock()
      const client = makeClient({
        upload: vi.fn().mockResolvedValue(processing),
        get: vi.fn().mockResolvedValue(active),
      })
      const store = new GoogleFileStore({
        auth: fakeAuth,
        client,
        scheduler: clock,
        now: () => clock.now(),
        poll: { timeoutMs: 600_000, intervalMs: 300_000 },
      })
      const settled = store.upload(new Uint8Array([1]), 'image/png')
      await clock.advanceAsync(300_000)
      await expect(settled).resolves.toMatchObject({ name: 'files/abc123' })
      expect(clock.pendingTimers).toBe(0)
    })

    it('a wait a custom sleep let run past the deadline does not buy another poll', async () => {
      let nowMs = 0
      const client = makeClient({
        upload: vi.fn().mockResolvedValue(processing),
        get: vi.fn().mockResolvedValue(active),
      })
      const store = new GoogleFileStore({
        auth: fakeAuth,
        client,
        sleep: () => {
          nowMs = 1_500
          return Promise.resolve()
        },
        now: () => nowMs,
        poll: { timeoutMs: 1_000, intervalMs: 3_000 },
      })
      const err = await store.upload(new Uint8Array([1]), 'image/png').catch((e) => e)
      expect(err).toMatchObject({ kind: 'server', retryable: false })
      expect(client.get).not.toHaveBeenCalled()
    })

    it('an ACTIVE answer that arrives after the deadline is the timeout error, not a handle', async () => {
      let nowMs = 0
      const client = makeClient({
        upload: vi.fn().mockResolvedValue(processing),
        get: vi.fn().mockImplementation(() => {
          nowMs = 1_001
          return Promise.resolve(active)
        }),
      })
      const store = new GoogleFileStore({
        auth: fakeAuth,
        client,
        sleep: fastSleep,
        now: () => nowMs,
        poll: { timeoutMs: 1_000, intervalMs: 0 },
      })
      const err = await store.upload(new Uint8Array([1]), 'image/png').catch((e) => e)
      expect(err).toBeInstanceOf(LlmError)
      expect(err).toMatchObject({ kind: 'server', retryable: false })
      expect((err as LlmError).message).toContain('Timed out waiting')
      expect(client.get).toHaveBeenCalledTimes(1)
    })

    it('an ACTIVE answer inside the deadline is still a handle', async () => {
      let nowMs = 0
      const client = makeClient({
        upload: vi.fn().mockResolvedValue(processing),
        get: vi.fn().mockImplementation(() => {
          nowMs = 999
          return Promise.resolve(active)
        }),
      })
      const store = new GoogleFileStore({
        auth: fakeAuth,
        client,
        sleep: fastSleep,
        now: () => nowMs,
        poll: { timeoutMs: 1_000, intervalMs: 0 },
      })
      await expect(store.upload(new Uint8Array([1]), 'image/png')).resolves.toMatchObject(
        { name: 'files/abc123' },
      )
    })
  })

  describe('a stalled get() during polling', () => {
    const processing = {
      name: 'files/abc123',
      uri: 'https://example.com/files/abc123',
      mimeType: 'image/png',
      state: 'PROCESSING',
    }
    /** A get() that never settles by itself; `rejectLate` settles it after the race is lost. */
    function stalledGet() {
      let rejectLate: (e: unknown) => void = () => {}
      const get = vi.fn().mockImplementation(
        () =>
          new Promise((_, reject) => {
            rejectLate = reject
          }),
      )
      return { get, rejectLate: (e: unknown) => rejectLate(e) }
    }

    it('an abort releases upload() while get() is still pending, and a late rejection is not unhandled', async () => {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        const stalled = stalledGet()
        const client = makeClient({
          upload: vi.fn().mockResolvedValue(processing),
          get: stalled.get,
        })
        const controller = new AbortController()
        const store = new GoogleFileStore({
          auth: fakeAuth,
          client,
          sleep: fastSleep,
          poll: { intervalMs: 0, timeoutMs: 300_000 },
        })
        const settled = store
          .upload(new Uint8Array([1]), 'image/png', { signal: controller.signal })
          .catch((e: unknown) => e)
        await vi.waitFor(() => expect(stalled.get).toHaveBeenCalledTimes(1))
        controller.abort()
        const err = await settled
        expect(err).toBeInstanceOf(LlmError)
        expect(err).toMatchObject({ kind: 'aborted', retryable: false })
        stalled.rejectLate(new Error('socket closed after the abort'))
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })

    it('the polling deadline releases upload() while get() is still pending, as a non-retryable server error', async () => {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)
      try {
        const clock = new FakeClock()
        const stalled = stalledGet()
        const client = makeClient({
          upload: vi.fn().mockResolvedValue(processing),
          get: stalled.get,
        })
        const store = new GoogleFileStore({
          auth: fakeAuth,
          client,
          scheduler: clock,
          now: () => clock.now(),
          poll: { intervalMs: 1_000, timeoutMs: 10_000 },
        })
        const settled = store
          .upload(new Uint8Array([1]), 'image/png')
          .catch((e: unknown) => e)
        await clock.advanceAsync(1_000)
        expect(stalled.get).toHaveBeenCalledTimes(1)
        // 9 000 ms of the deadline remain; get() is still pending.
        await clock.advanceAsync(9_000)
        const err = await settled
        expect(err).toBeInstanceOf(LlmError)
        expect(err).toMatchObject({
          kind: 'server',
          retryable: false,
          provider: 'google',
        })
        expect((err as LlmError).message).toContain('Timed out waiting')
        expect(clock.pendingTimers).toBe(0)
        stalled.rejectLate(new Error('late'))
        await new Promise((resolve) => setTimeout(resolve, 10))
        expect(unhandled).toEqual([])
      } finally {
        process.off('unhandledRejection', onUnhandled)
      }
    })
  })

  // NEW: opts.displayName is forwarded into the upload config
  it('forwards opts.displayName into the upload call config', async () => {
    const client = makeClient()
    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })

    await store.upload(new Uint8Array([1]), 'image/png', { displayName: 'my-file' })

    expect(client.upload).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ displayName: 'my-file' }),
      }),
    )
  })

  // NEW: makeHandle falls back to the initial upload's name/uri/mimeType when a
  // poll response omits them (the API only guarantees these on the first response)
  it('falls back to the original upload name/uri/mimeType when a poll response omits them', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      }),
      get: vi.fn().mockResolvedValue({
        state: 'ACTIVE',
        // name, uri, mimeType omitted from the poll response
      }),
    })

    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    const handle = await store.upload(new Uint8Array([1]), 'image/png')

    expect(handle.name).toBe('files/abc123')
    expect(handle.uri).toBe('https://example.com/files/abc123')
    expect(handle.mimeType).toBe('image/png')
  })

  // 7. deleteAll continues past individual failures
  it('deleteAll continues past individual failures and calls onDeleteError for each', async () => {
    const onDeleteError = vi.fn()
    const deleteError = new Error('fail')
    const client = makeClient({
      delete: vi.fn().mockRejectedValue(deleteError),
    })

    const store = new GoogleFileStore({
      auth: fakeAuth,
      client,
      sleep: fastSleep,
      onDeleteError,
    })
    const handles: GoogleFileHandle[] = [
      { name: 'files/a', uri: 'ua', mimeType: 'image/png' },
      { name: 'files/b', uri: 'ub', mimeType: 'image/png' },
      { name: 'files/c', uri: 'uc', mimeType: 'image/png' },
    ]

    await expect(store.deleteAll(handles)).resolves.toBeUndefined()
    expect(onDeleteError).toHaveBeenCalledTimes(3)
    expect(onDeleteError.mock.calls.map((c) => c[0])).toEqual([
      'files/a',
      'files/b',
      'files/c',
    ])
    for (const call of onDeleteError.mock.calls) {
      expect(call[1]).toBeInstanceOf(LlmError)
    }
  })

  // NEW: upload validation — missing/empty name and uri variants
  it('throws LlmError server when upload response name is undefined', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'ACTIVE',
      }),
    })
    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    await expect(store.upload(new Uint8Array([1]), 'image/png')).rejects.toMatchObject({
      message: 'File upload response missing required fields (name or uri)',
      kind: 'server',
      retryable: false,
      provider: 'google',
    })
    await expect(store.upload(new Uint8Array([1]), 'image/png')).rejects.toBeInstanceOf(
      LlmError,
    )
  })

  it('throws LlmError server when upload response name is an empty string', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: '',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
        state: 'ACTIVE',
      }),
    })
    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    await expect(store.upload(new Uint8Array([1]), 'image/png')).rejects.toMatchObject({
      message: 'File upload response missing required fields (name or uri)',
      kind: 'server',
      retryable: false,
      provider: 'google',
    })
  })

  it('throws LlmError server when upload response uri is undefined', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        mimeType: 'image/png',
        state: 'ACTIVE',
      }),
    })
    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    await expect(store.upload(new Uint8Array([1]), 'image/png')).rejects.toMatchObject({
      message: 'File upload response missing required fields (name or uri)',
      kind: 'server',
      retryable: false,
      provider: 'google',
    })
  })

  it('throws LlmError server when upload response uri is an empty string', async () => {
    const client = makeClient({
      upload: vi.fn().mockResolvedValue({
        name: 'files/abc123',
        uri: '',
        mimeType: 'image/png',
        state: 'ACTIVE',
      }),
    })
    const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
    await expect(store.upload(new Uint8Array([1]), 'image/png')).rejects.toMatchObject({
      message: 'File upload response missing required fields (name or uri)',
      kind: 'server',
      retryable: false,
      provider: 'google',
    })
  })

  // NEW: getClient() — clientOverride short-circuits and never builds the SDK client
  describe('getClient()', () => {
    it('clientOverride short-circuits: never constructs GoogleGenAI', async () => {
      constructorCalls.length = 0
      const client = makeClient()
      const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
      const handle: GoogleFileHandle = {
        name: 'files/abc123',
        uri: 'u',
        mimeType: 'image/png',
      }

      await store.upload(new Uint8Array([1]), 'image/png')
      await store.delete(handle)

      expect(constructorCalls).toHaveLength(0)
      expect(client.upload).toHaveBeenCalledTimes(1)
      expect(client.delete).toHaveBeenCalledTimes(1)
    })

    it('lazily builds and memoises the SDK client: concurrent calls construct GoogleGenAI only once', async () => {
      constructorCalls.length = 0
      uploadMock.mockClear()
      const store = new GoogleFileStore({ auth: fakeAuth, sleep: fastSleep })

      // Two concurrent uploads without a client override — both must resolve
      // through the same memoised clientPromise.
      const [h1, h2] = await Promise.all([
        store.upload(new Uint8Array([1]), 'image/png'),
        store.upload(new Uint8Array([2]), 'image/png'),
      ])

      expect(constructorCalls).toHaveLength(1)
      expect(h1.name).toBe('files/lazy123')
      expect(h2.name).toBe('files/lazy123')

      // A subsequent call also reuses the same memoised client.
      await store.upload(new Uint8Array([3]), 'image/png')
      expect(constructorCalls).toHaveLength(1)
    })

    it('lazily-built client converts a Uint8Array to a Blob typed with the admitted mimeType', async () => {
      constructorCalls.length = 0
      uploadMock.mockClear()
      const store = new GoogleFileStore({ auth: fakeAuth, sleep: fastSleep })

      await store.upload(new Uint8Array([1, 2, 3]), 'image/png')

      expect(uploadMock).toHaveBeenCalledTimes(1)
      const callArg = uploadMock.mock.calls[0]![0] as { file: Blob }
      expect(callArg.file).toBeInstanceOf(Blob)
      expect(callArg.file.type).toBe('image/png')
    })

    it('lazily-built client passes a Blob source through untouched (no re-wrapping)', async () => {
      constructorCalls.length = 0
      uploadMock.mockClear()
      const store = new GoogleFileStore({ auth: fakeAuth, sleep: fastSleep })

      const sourceBlob = new Blob(['hello'], { type: 'text/plain' })
      await store.upload(sourceBlob, 'text/plain')

      expect(uploadMock).toHaveBeenCalledTimes(1)
      const callArg = uploadMock.mock.calls[0]![0] as { file: Blob }
      expect(callArg.file).toBe(sourceBlob)
    })

    it('lazily-built client wraps ai.files.get and ai.files.delete', async () => {
      constructorCalls.length = 0
      getMock.mockReset()
      getMock.mockResolvedValue({
        name: 'files/lazy123',
        uri: 'https://example.com/files/lazy123',
        mimeType: 'image/png',
        state: 'ACTIVE',
      })
      uploadMock.mockClear()
      uploadMock.mockResolvedValueOnce({
        name: 'files/lazy123',
        uri: 'https://example.com/files/lazy123',
        mimeType: 'image/png',
        state: 'PROCESSING',
      })
      deleteMock.mockClear()

      const store = new GoogleFileStore({ auth: fakeAuth, sleep: fastSleep })

      const handle = await store.upload(new Uint8Array([1]), 'image/png')
      expect(getMock).toHaveBeenCalledWith({ name: 'files/lazy123' })
      expect(handle.name).toBe('files/lazy123')

      await store.delete(handle)
      expect(deleteMock).toHaveBeenCalledWith({ name: 'files/lazy123' })

      // Still only one GoogleGenAI instance across upload + get polling + delete.
      expect(constructorCalls).toHaveLength(1)
    })
  })

  // delete error routing
  describe('delete error routing', () => {
    it('routes delete failure to logger.error when logger is provided', async () => {
      const errorFn = vi.fn()
      const logger = { info() {}, warn() {}, debug() {}, error: errorFn }
      const client = makeClient({
        delete: vi.fn().mockRejectedValue(new Error('network down')),
      })
      const store = new GoogleFileStore({
        auth: fakeAuth,
        client,
        sleep: fastSleep,
        logger,
      })
      const handle: GoogleFileHandle = {
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
      }
      await store.delete(handle)

      expect(errorFn).toHaveBeenCalledOnce()
      const [obj, msg] = errorFn.mock.calls[0]!
      expect(msg).toBe('gemini.file.delete.failed')
      expect(obj).toMatchObject({ name: 'files/abc123' })
      expect(typeof obj.error).toBe('string')
    })

    it('falls back to console.error when no logger provided', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const client = makeClient({
        delete: vi.fn().mockRejectedValue(new Error('network down')),
      })
      const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
      const handle: GoogleFileHandle = {
        name: 'files/abc123',
        uri: 'https://example.com/files/abc123',
        mimeType: 'image/png',
      }
      await store.delete(handle)

      expect(consoleSpy).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })
  })

  // ---------------------------------------------------------------------
  // Errors classify through classifyGoogleError (one path for every Google error)
  // ---------------------------------------------------------------------
  describe('error classification', () => {
    const handle: GoogleFileHandle = {
      name: 'files/abc123',
      uri: 'https://example.com/files/abc123',
      mimeType: 'image/png',
    }
    // Bodies are built from the documented google.rpc detail types (doc-derived,
    // see __fixtures__/error-bodies-2026-10-03.json); `message` is omitted.
    const apiError = (status: number, body: unknown): Error =>
      Object.assign(new Error(JSON.stringify(body)), { status, name: 'ApiError' })
    const invalidKey = (): Error =>
      apiError(400, {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
              reason: 'API_KEY_INVALID',
            },
          ],
        },
      })
    const dailyQuota = (): Error =>
      apiError(429, {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel' }],
            },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' },
          ],
        },
      })
    const perMinute = (): Error =>
      apiError(429, {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' }],
            },
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' },
          ],
        },
      })

    it('upload: a bad API key is invalid_auth tagged google', async () => {
      const client = makeClient({ upload: vi.fn().mockRejectedValue(invalidKey()) })
      const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
      const err = (await store
        .upload(new Uint8Array([1]), 'image/png')
        .catch((e) => e)) as LlmError
      expect(err).toMatchObject({
        kind: 'invalid_auth',
        retryable: false,
        provider: 'google',
      })
    })

    it('upload: a per-day quota is not retryable and is sent once', async () => {
      const upload = vi.fn().mockRejectedValue(dailyQuota())
      const store = new GoogleFileStore({
        auth: fakeAuth,
        client: makeClient({ upload }),
        sleep: fastSleep,
      })
      const err = (await store
        .upload(new Uint8Array([1]), 'image/png')
        .catch((e) => e)) as LlmError
      expect(err).toMatchObject({
        kind: 'rate_limited',
        retryable: false,
        reason: 'daily_quota',
        provider: 'google',
      })
      expect(err.retryAfterMs).toBeUndefined()
      expect(upload).toHaveBeenCalledTimes(1)
    })

    it('upload: a per-minute 429 carries RetryInfo as retryAfterMs', async () => {
      const store = new GoogleFileStore({
        auth: fakeAuth,
        client: makeClient({ upload: vi.fn().mockRejectedValue(perMinute()) }),
        sleep: fastSleep,
      })
      const err = (await store
        .upload(new Uint8Array([1]), 'image/png')
        .catch((e) => e)) as LlmError
      expect(err).toMatchObject({
        kind: 'rate_limited',
        retryable: true,
        retryAfterMs: 34_000,
        provider: 'google',
      })
    })

    it('polling get: classified through the same path', async () => {
      const client = makeClient({
        upload: vi.fn().mockResolvedValue({
          name: 'files/abc123',
          uri: 'https://example.com/files/abc123',
          state: 'PROCESSING',
        }),
        get: vi.fn().mockRejectedValue(invalidKey()),
      })
      const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
      const err = (await store
        .upload(new Uint8Array([1]), 'image/png')
        .catch((e) => e)) as LlmError
      expect(err).toMatchObject({ kind: 'invalid_auth', provider: 'google' })
    })

    it('delete (fail-closed): a bad API key is invalid_auth tagged google', async () => {
      const client = makeClient({ delete: vi.fn().mockRejectedValue(invalidKey()) })
      const store = new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
      const err = (await store
        .delete(handle, { failClosed: true })
        .catch((e) => e)) as LlmError
      expect(err).toMatchObject({
        kind: 'invalid_auth',
        retryable: false,
        provider: 'google',
      })
    })
  })

  // ---------------------------------------------------------------------
  // FAILED files follow the documented File.error status code
  // ---------------------------------------------------------------------
  describe('FAILED file classification', () => {
    const failedWith = (error: unknown): GeminiFilesClientLike =>
      makeClient({
        upload: vi.fn().mockResolvedValue({
          name: 'files/abc123',
          uri: 'https://example.com/files/abc123',
          state: 'FAILED',
          ...(error !== undefined ? { error } : {}),
        }),
      })
    const run = async (client: GeminiFilesClientLike): Promise<LlmError> =>
      (await new GoogleFileStore({ auth: fakeAuth, client, sleep: fastSleep })
        .upload(new Uint8Array([1]), 'image/png')
        .catch((e) => e)) as LlmError

    it.each([
      [4, 'DEADLINE_EXCEEDED'],
      [13, 'INTERNAL'],
      [14, 'UNAVAILABLE'],
    ])('code %i (%s) is a retryable server error', async (code) => {
      const err = await run(failedWith({ code, message: 'processing failed' }))
      expect(err).toMatchObject({ kind: 'server', retryable: true, provider: 'google' })
      expect(err.message).toContain('processing failed')
    })

    it.each([[3], [9], [undefined]])(
      'code %s stays a non-retryable bad_request',
      async (code) => {
        const err = await run(
          failedWith({
            ...(code !== undefined ? { code } : {}),
            message: 'cannot decode',
          }),
        )
        expect(err).toMatchObject({
          kind: 'bad_request',
          retryable: false,
          provider: 'google',
        })
      },
    )
  })
})
