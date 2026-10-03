import { describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'
import { FakeClock } from './clock.js'
import { FakeGoogleCacheStore } from './fake-google-cache-store.js'
import { FakeGoogleFileStore } from './fake-google-file-store.js'

const HOUR = 3_600_000

describe('FakeGoogleFileStore', () => {
  it('uploads bytes and returns a handle in the real handle shape', async () => {
    const clock = new FakeClock(1_000)
    const files = new FakeGoogleFileStore({ now: () => clock.now() })

    const handle = await files.upload(new Uint8Array([1, 2, 3]), 'image/png', {
      displayName: 'a.png',
    })

    expect(handle).toEqual({
      name: 'files/fake-1',
      uri: 'https://generativelanguage.googleapis.com/v1beta/files/fake-1',
      mimeType: 'image/png',
      expiresAt: new Date(1_000 + 48 * HOUR),
    })
    expect(files.size).toBe(1)
    expect(files.has(handle.name)).toBe(true)
  })

  it('accepts a Blob, and gives every upload its own name', async () => {
    const files = new FakeGoogleFileStore()
    const a = await files.upload(new Blob(['x']), 'text/plain')
    const b = await files.upload(new Uint8Array(1), 'text/plain')
    expect(a.name).not.toBe(b.name)
    expect(files.size).toBe(2)
  })

  it('files expire after the ttl, on the injected clock', async () => {
    const clock = new FakeClock(0)
    const files = new FakeGoogleFileStore({ now: () => clock.now(), ttlMs: 1_000 })
    const handle = await files.upload(new Uint8Array(1), 'image/png')

    clock.advance(999)
    expect(files.has(handle.name)).toBe(true)
    clock.advance(1)
    expect(files.has(handle.name)).toBe(false)
    expect(files.size).toBe(0)
  })

  it('rejects an empty mime type with bad_request, and an aborted signal as aborted', async () => {
    const files = new FakeGoogleFileStore()
    await expect(files.upload(new Uint8Array(1), '')).rejects.toMatchObject({
      kind: 'bad_request',
    })
    const controller = new AbortController()
    controller.abort()
    await expect(
      files.upload(new Uint8Array(1), 'image/png', { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: 'aborted' })
    expect(files.size).toBe(0)
  })

  it('delete removes the file; a missing file is success, as in the real store', async () => {
    const files = new FakeGoogleFileStore()
    const handle = await files.upload(new Uint8Array(1), 'image/png')

    await files.delete(handle)
    expect(files.size).toBe(0)
    await expect(files.delete(handle, { failClosed: true })).resolves.toBeUndefined()
  })

  it('deleteMissingAsError simulates a non-404 failure: swallowed to onDeleteError, or thrown with failClosed', async () => {
    const seen: string[] = []
    const files = new FakeGoogleFileStore({
      deleteMissingAsError: true,
      onDeleteError: (name) => seen.push(name),
    })

    await files.delete({ name: 'files/ghost' })
    expect(seen).toEqual(['files/ghost'])
    const error = await files
      .delete({ name: 'files/ghost' }, { failClosed: true })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ kind: 'server', retryable: true, provider: 'google' })
  })

  it('deleteAll deletes every handle; fail-open continues past a failure, fail-closed throws', async () => {
    const files = new FakeGoogleFileStore({ deleteMissingAsError: true })
    const a = await files.upload(new Uint8Array(1), 'image/png')
    const b = await files.upload(new Uint8Array(1), 'image/png')

    await files.deleteAll([a, { name: 'files/ghost' }, b])
    expect(files.size).toBe(0)

    await expect(
      files.deleteAll([{ name: 'files/ghost' }], { failClosed: true }),
    ).rejects.toBeInstanceOf(LlmError)
  })
})

describe('FakeGoogleCacheStore', () => {
  const key = { model: 'gemini-2.5-pro', stableKey: 'prefix-1' }
  const factory = () => Promise.resolve({ ttlSeconds: 600 })

  it('creates a model-bound cache with an expiry and, when configured, a token count', async () => {
    const clock = new FakeClock(5_000)
    const caches = new FakeGoogleCacheStore({
      now: () => clock.now(),
      tokenCount: (input) => input.model.length,
    })

    const handle = await caches.create({ model: 'm1', ttlSeconds: 60 })

    expect(handle).toEqual({
      cacheName: 'cachedContents/fake-1',
      model: 'm1',
      expiresAt: new Date(5_000 + 60_000),
      totalTokenCount: 2,
    })
    expect(caches.created).toBe(1)
    expect(caches.size).toBe(1)
  })

  it('totalTokenCount is absent unless configured', async () => {
    const handle = await new FakeGoogleCacheStore().create({ model: 'm', ttlSeconds: 60 })
    expect('totalTokenCount' in handle).toBe(false)
    const fixed = await new FakeGoogleCacheStore({ tokenCount: 4096 }).create({
      model: 'm',
      ttlSeconds: 60,
    })
    expect(fixed.totalTokenCount).toBe(4096)
  })

  it('getOrCreate reuses a live cache and re-creates one that is inside the expiry skew', async () => {
    const clock = new FakeClock(0)
    const caches = new FakeGoogleCacheStore({ now: () => clock.now() })

    const a = await caches.getOrCreate(key, factory)
    const b = await caches.getOrCreate(key, factory)
    expect(b).toBe(a)
    expect(caches.created).toBe(1)

    clock.advance(569_999) // 30 s skew: live while expiry - 30 s is still ahead
    expect(await caches.getOrCreate(key, factory)).toBe(a)
    clock.advance(1)
    const c = await caches.getOrCreate(key, factory)
    expect(c).not.toBe(a)
    expect(caches.created).toBe(2)
  })

  it('different keys get different caches', async () => {
    const caches = new FakeGoogleCacheStore()
    const a = await caches.getOrCreate(key, factory)
    const b = await caches.getOrCreate({ ...key, stableKey: 'other' }, factory)
    expect(a.cacheName).not.toBe(b.cacheName)
  })

  it('refreshIfExpiringSoon extends a cache near expiry with the original ttl, and leaves a fresh one', async () => {
    const clock = new FakeClock(0)
    const caches = new FakeGoogleCacheStore({ now: () => clock.now() })
    const handle = await caches.getOrCreate(key, factory) // expires at 600 s

    expect(await caches.refreshIfExpiringSoon(handle)).toBe(handle) // 600 s away, threshold 300 s

    clock.advance(400_000) // 200 s left
    const refreshed = await caches.refreshIfExpiringSoon(handle)
    expect(refreshed.expiresAt).toEqual(new Date(400_000 + 600_000))
    expect(refreshed.cacheName).toBe(handle.cacheName)
    // getOrCreate now hands back the refreshed handle without creating another cache.
    expect(await caches.getOrCreate(key, factory)).toBe(refreshed)
    expect(caches.created).toBe(1)
  })

  it('refresh takes an explicit extension, and is fail-open for a cache that is gone', async () => {
    const clock = new FakeClock(0)
    const caches = new FakeGoogleCacheStore({ now: () => clock.now() })
    const handle = await caches.create({ model: 'm', ttlSeconds: 60 })

    const extended = await caches.refreshIfExpiringSoon(handle, {
      extensionSeconds: 7_200,
    })
    expect(extended.expiresAt).toEqual(new Date(7_200_000))

    await caches.delete(handle)
    expect(await caches.refreshIfExpiringSoon(extended, { thresholdSeconds: 1e9 })).toBe(
      extended,
    )
  })

  it('delete removes the cache and its getOrCreate entry; a second delete reports to onDeleteError', async () => {
    const seen: string[] = []
    const caches = new FakeGoogleCacheStore({ onDeleteError: (name) => seen.push(name) })
    const handle = await caches.getOrCreate(key, factory)

    await caches.delete(handle)
    expect(caches.size).toBe(0)
    expect(seen).toEqual([])
    await caches.delete(handle)
    expect(seen).toEqual([handle.cacheName])

    const again = await caches.getOrCreate(key, factory)
    expect(again.cacheName).not.toBe(handle.cacheName)
  })

  it('create rejects a missing model or a non-positive ttl with bad_request', async () => {
    const caches = new FakeGoogleCacheStore()
    await expect(caches.create({ model: '', ttlSeconds: 60 })).rejects.toMatchObject({
      kind: 'bad_request',
    })
    await expect(caches.create({ model: 'm', ttlSeconds: 0 })).rejects.toMatchObject({
      kind: 'bad_request',
    })
    expect(caches.created).toBe(0)
  })
})
