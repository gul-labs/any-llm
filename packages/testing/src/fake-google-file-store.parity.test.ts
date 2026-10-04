/**
 * `FakeGoogleFileStore` parity with the real `GoogleFileStore`: the same cases run
 * against both, the real one over a fake `GeminiFilesClientLike`, and must give the
 * same outcome. No network.
 */

import { describe, expect, it, vi } from 'vitest'
import { LlmError } from '@gullabs/core'
import { GoogleFileStore } from '@gullabs/google'
import type { GeminiFilesClientLike } from '@gullabs/google'
import { FakeGoogleFileStore } from './fake-google-file-store.js'

interface Subject {
  name: 'real' | 'fake'
  /** An upload whose work never settles by itself, so only an abort can end it. */
  stalledUpload(signal?: AbortSignal): Promise<unknown>
  /** An upload that succeeds, returning its handle. */
  upload(): Promise<{ name: string }>
  delete(
    handle: { name: string },
    opts?: { signal?: AbortSignal; failClosed?: boolean },
  ): Promise<void>
  /** Calls that reached the (fake) provider's delete. */
  providerDeletes(): number
  /** Names given to the delete-error callback, with the error. */
  deleteErrors: Array<{ name: string; err: unknown }>
}

function real(): Subject {
  const deleteErrors: Subject['deleteErrors'] = []
  const never = new Promise<never>(() => {})
  let stall = false
  const client: GeminiFilesClientLike = {
    upload: vi.fn().mockImplementation(() =>
      stall
        ? never
        : Promise.resolve({
            name: 'files/real-1',
            uri: 'https://example.com/files/real-1',
            mimeType: 'image/png',
            state: 'ACTIVE',
          }),
    ),
    get: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
  }
  const store = new GoogleFileStore({
    auth: { apiKey: 'k' },
    client,
    onDeleteError: (name, err) => deleteErrors.push({ name, err }),
  })
  return {
    name: 'real',
    stalledUpload(signal) {
      stall = true
      return store.upload(new Uint8Array([1]), 'image/png', {
        ...(signal !== undefined ? { signal } : {}),
      })
    },
    upload() {
      stall = false
      return store.upload(new Uint8Array([1]), 'image/png')
    },
    delete: (handle, opts) =>
      store.delete({ ...handle, uri: 'u', mimeType: 'image/png' }, opts),
    providerDeletes: () => (client.delete as ReturnType<typeof vi.fn>).mock.calls.length,
    deleteErrors,
  }
}

function fake(): Subject {
  const deleteErrors: Subject['deleteErrors'] = []
  const store = new FakeGoogleFileStore({
    onDeleteError: (name, err) => deleteErrors.push({ name, err }),
  })
  return {
    name: 'fake',
    stalledUpload(signal) {
      const blob = new Blob(['x'])
      blob.arrayBuffer = () => new Promise<ArrayBuffer>(() => {})
      return store.upload(blob, 'image/png', {
        ...(signal !== undefined ? { signal } : {}),
      })
    },
    upload: () => store.upload(new Uint8Array([1]), 'image/png'),
    delete: (handle, opts) => store.delete(handle, opts),
    // The fake keeps no provider call count; a file that is still stored was not deleted.
    providerDeletes: () => 0,
    deleteErrors,
  }
}

describe.each([real, fake])('GoogleFileStore parity', (make) => {
  const label = make.name

  it(`${label}: an abort while the upload is in flight rejects with aborted at once`, async () => {
    const subject = make()
    const controller = new AbortController()
    const settled = subject.stalledUpload(controller.signal).catch((e: unknown) => e)
    await new Promise((resolve) => setTimeout(resolve, 5))
    controller.abort()
    const err = await settled
    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({ kind: 'aborted', retryable: false })
  })

  it(`${label}: an already-aborted signal rejects an upload with aborted`, async () => {
    const subject = make()
    const controller = new AbortController()
    controller.abort()
    await expect(subject.stalledUpload(controller.signal)).rejects.toMatchObject({
      kind: 'aborted',
      retryable: false,
    })
  })

  it.each(['', '   '])(
    `${label}: delete of a blank name (%j) is bad_request, failClosed or not, and never reaches the callback`,
    async (blank) => {
      const subject = make()
      for (const failClosed of [true, false]) {
        const err = await subject.delete({ name: blank }, { failClosed }).catch((e) => e)
        expect(err).toBeInstanceOf(LlmError)
        expect(err).toMatchObject({ kind: 'bad_request', retryable: false })
      }
      expect(subject.deleteErrors).toEqual([])
      expect(subject.providerDeletes()).toBe(0)
    },
  )

  it(`${label}: delete with an aborted signal throws aborted when failClosed`, async () => {
    const subject = make()
    const handle = await subject.upload()
    const controller = new AbortController()
    controller.abort()
    const err = await subject
      .delete(handle, { signal: controller.signal, failClosed: true })
      .catch((e) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect(err).toMatchObject({ kind: 'aborted', retryable: false })
    expect(subject.deleteErrors).toEqual([])
    expect(subject.providerDeletes()).toBe(0)
  })

  it(`${label}: delete with an aborted signal goes to onDeleteError and resolves when fail-open`, async () => {
    const subject = make()
    const handle = await subject.upload()
    const controller = new AbortController()
    controller.abort()
    await expect(
      subject.delete(handle, { signal: controller.signal }),
    ).resolves.toBeUndefined()
    expect(subject.deleteErrors).toHaveLength(1)
    expect(subject.deleteErrors[0]?.name).toBe(handle.name)
    expect(subject.deleteErrors[0]?.err).toMatchObject({ kind: 'aborted' })
    expect(subject.providerDeletes()).toBe(0)
  })

  it(`${label}: a live signal does not disturb a delete`, async () => {
    const subject = make()
    const handle = await subject.upload()
    await expect(
      subject.delete(handle, { signal: new AbortController().signal, failClosed: true }),
    ).resolves.toBeUndefined()
    expect(subject.deleteErrors).toEqual([])
  })
})
