/* eslint-disable @typescript-eslint/require-await -- Promise-shaped API; body is sync in-memory */
/**
 * FakeGoogleFileStore — in-memory stand-in for `@gullabs/google` `GoogleFileStore`.
 *
 * Structural (no import of `@gullabs/google`): hosts inject it where production
 * code takes a store-shaped object. Mirrors the real store's surface (`upload`,
 * `delete`, `deleteAll`) and its delete semantics: a missing file is success,
 * other failures follow `failClosed`.
 *
 * @module
 */

import { LlmError } from '@gullabs/core'

/** Mirrors `GoogleFileHandle`. */
export interface FakeGoogleFileHandle {
  /** Resource name, e.g. `files/fake-1`. */
  name: string
  /** URI to pass as a `file-uri` part. */
  uri: string
  mimeType: string
  /** The provider deletes a file about 48 h after upload. */
  expiresAt?: Date
}

/** Mirrors `FileDeleteOptions`. */
export interface FakeGoogleFileDeleteOptions {
  signal?: AbortSignal
  failClosed?: boolean
}

export interface FakeGoogleFileStoreOptions {
  /** Injectable clock (ms). Default `Date.now`. Pass `() => clock.now()` for a FakeClock. */
  now?: () => number
  /** How long a file lives after upload, in ms. Default 48 hours, as Google's File API. */
  ttlMs?: number
  /**
   * When true, deleting a file that is not stored is a simulated non-404 failure
   * (`server`, retryable) instead of success. With `failClosed` it throws;
   * otherwise it goes to `onDeleteError`.
   */
  deleteMissingAsError?: boolean
  /** Called on a swallowed delete failure. Default: ignore. */
  onDeleteError?: (name: string, err: unknown) => void
}

const DEFAULT_TTL_MS = 48 * 3_600_000

/**
 * An in-memory Gemini file store. Upload keeps the bytes and returns a handle
 * (always ACTIVE: no processing delay is simulated).
 *
 * ```ts
 * const files = new FakeGoogleFileStore()
 * const handle = await files.upload(new Uint8Array([1, 2, 3]), 'image/png')
 * expect(files.size).toBe(1)
 * await files.delete(handle)
 * ```
 */
export class FakeGoogleFileStore {
  private readonly files = new Map<
    string,
    { handle: FakeGoogleFileHandle; bytes: Uint8Array; expiresAtMs: number }
  >()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly deleteMissingAsError: boolean
  private readonly onDeleteError: (name: string, err: unknown) => void
  private seq = 0

  constructor(opts: FakeGoogleFileStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.deleteMissingAsError = opts.deleteMissingAsError === true
    this.onDeleteError =
      opts.onDeleteError ??
      (() => {
        /* fail-open default */
      })
  }

  /** Files currently stored (expired ones are gone). */
  get size(): number {
    this.purgeExpired()
    return this.files.size
  }

  /** Whether a file with this resource `name` is stored. */
  has(name: string): boolean {
    this.purgeExpired()
    return this.files.has(name)
  }

  async upload(
    source: Uint8Array | Blob,
    mimeType: string,
    opts?: { displayName?: string; signal?: AbortSignal },
  ): Promise<FakeGoogleFileHandle> {
    if (typeof mimeType !== 'string' || mimeType.trim() === '') {
      throw new LlmError('mimeType must be a non-empty string.', {
        kind: 'bad_request',
        retryable: false,
        provider: 'google',
      })
    }
    if (opts?.signal?.aborted === true) {
      throw new LlmError('File upload aborted', { kind: 'aborted', retryable: false })
    }
    const bytes =
      source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer())
    this.seq += 1
    const name = `files/fake-${this.seq}`
    const expiresAtMs = this.now() + this.ttlMs
    const handle: FakeGoogleFileHandle = {
      name,
      uri: `https://generativelanguage.googleapis.com/v1beta/${name}`,
      mimeType,
      expiresAt: new Date(expiresAtMs),
    }
    this.files.set(name, { handle: { ...handle }, bytes: bytes.slice(), expiresAtMs })
    return { ...handle }
  }

  async delete(
    handle: Pick<FakeGoogleFileHandle, 'name'>,
    opts?: FakeGoogleFileDeleteOptions,
  ): Promise<void> {
    this.purgeExpired()
    if (this.files.delete(handle.name)) return
    if (!this.deleteMissingAsError) return // not found is success (idempotent)
    const err = new LlmError('simulated delete failure', {
      kind: 'server',
      retryable: true,
      provider: 'google',
    })
    if (opts?.failClosed === true) throw err
    this.onDeleteError(handle.name, err)
  }

  async deleteAll(
    handles: readonly Pick<FakeGoogleFileHandle, 'name'>[],
    opts?: FakeGoogleFileDeleteOptions,
  ): Promise<void> {
    if (opts?.failClosed === true) {
      await Promise.all(handles.map((h) => this.delete(h, opts)))
      return
    }
    await Promise.allSettled(handles.map((h) => this.delete(h, opts)))
  }

  private purgeExpired(): void {
    const t = this.now()
    for (const [name, stored] of this.files) {
      if (stored.expiresAtMs <= t) this.files.delete(name)
    }
  }
}
