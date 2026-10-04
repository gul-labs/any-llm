/**
 * GoogleFileStore — thin wrapper over the Gemini File API.
 *
 * Handles upload + polling until ACTIVE, and tracked deletion.
 * Injectable sleep and client for tests (no network required).
 *
 * @module
 */

import type { AuthMaterial, Logger, Scheduler } from '@gullabs/core'
import { LlmError, assertMediaTypeAdmitted, redactSecrets } from '@gullabs/core'

import { MAX_TIMER_MS, newGoogleGenAI } from './client.js'
import { classifyGoogleError, isGoogleNotFoundError } from './errors.js'
import { GEMINI_INPUT_MIME_TYPES } from './model-limits.js'
import { PLATFORM_SCHEDULER } from './platform-scheduler.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A handle to a file stored in the Gemini File API. */
export interface GoogleFileHandle {
  /** Resource name, e.g. "files/abc123". */
  name: string
  /** URI to pass as FileUriPart.uri in an LlmRequest. */
  uri: string
  mimeType: string
  /** Provider auto-deletes ~48 h after upload. Absent when not returned. */
  expiresAt?: Date
}

/** The `File` resource fields the store reads. */
type FileResp = {
  name?: string
  uri?: string
  mimeType?: string
  state?: string
  expirationTime?: string
  /** Real field `File.error` (`FileStatus`): why processing failed. */
  error?: { code?: number; message?: string; details?: Record<string, unknown>[] }
}

/**
 * Minimal structural interface for the Gemini Files client surface we use.
 * Satisfied by the real ai.files object or a test fake.
 */
export interface GeminiFilesClientLike {
  upload(params: {
    file: Uint8Array | Blob
    config?: { mimeType?: string; displayName?: string; abortSignal?: AbortSignal }
  }): Promise<FileResp>
  get(params: { name: string }): Promise<FileResp>
  delete(params: { name: string }): Promise<void>
}

/**
 * Options for {@link GoogleFileStore.delete} / {@link GoogleFileStore.deleteAll}.
 *
 * Default is fail-open (P5 side-effect style). Pass `failClosed: true` when
 * the host gates durable state on known delete success. Shape matches
 * `@gullabs/xai` `FileDeleteOptions` by convention.
 */
export interface FileDeleteOptions {
  signal?: AbortSignal
  /**
   * When true, non-not-found failures throw typed `LlmError`.
   * When false/omitted, failures invoke `onDeleteError` and resolve.
   * Not-found is success in both modes (idempotent).
   */
  failClosed?: boolean
}

export interface GoogleFileStoreOptions {
  auth: AuthMaterial
  /** Injectable client for tests; skips SDK import when provided. */
  client?: GeminiFilesClientLike
  /** Called on delete failures instead of rethrowing. Default: console.error. */
  onDeleteError?: (name: string, err: unknown) => void
  /** Optional structured logger. When provided, routes delete failures to logger.error. */
  logger?: Logger
  poll?: {
    /** Delay between state polls. Default: 3000 ms. */
    intervalMs?: number
    /** Max time to wait for ACTIVE. Default: 300 000 ms (5 min). */
    timeoutMs?: number
  }
  /**
   * Timer source for the poll wait; pass the client's `FakeClock` in tests so
   * one `advance` fires the wait. Default: the platform's timers. (`now` is the
   * poll timeout's clock; pass `() => clock.now()` with it.)
   */
  scheduler?: Scheduler
  /**
   * Replaces the poll wait wholesale (instant polling in tests). When given,
   * `scheduler` is not used for the wait, and the wait cannot be cancelled: if
   * the deadline or an abort ends the upload first, a timer your `sleep` set
   * stays pending until it fires. The default wait is cleared at once.
   */
  sleep?: (ms: number) => Promise<void>
  /** Injectable clock for deterministic tests. Default: `Date.now`. */
  now?: () => number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 3_000
const DEFAULT_TIMEOUT_MS = 300_000

/** A poll wait, and how to end it early (a no-op for a host's own `sleep`). */
interface Wait {
  promise: Promise<void>
  cancel: () => void
}

/** The default wait: its timer is cleared by `cancel`, so a lost race leaves none. */
const waitOn =
  (scheduler: Scheduler) =>
  (ms: number): Wait => {
    let timer: ReturnType<Scheduler['setTimeout']> | undefined
    const promise = new Promise<void>((resolve) => {
      timer = scheduler.setTimeout(resolve, ms)
    })
    return {
      promise,
      cancel: () => {
        if (timer !== undefined) scheduler.clearTimeout(timer)
      },
    }
  }

/**
 * `server`, not `timeout`: ADR-036 makes every `timeout` retryable, and this must not be.
 * The upload already succeeded, so a retry would upload the bytes again and orphan the
 * first file (upload is not idempotent, ADR-024). Poll the existing file by name instead.
 */
function pollTimeoutError(name: string): LlmError {
  return new LlmError(`Timed out waiting for uploaded file "${name}" to become ACTIVE`, {
    kind: 'server',
    retryable: false,
    provider: 'google',
  })
}

async function buildFilesClient(auth: AuthMaterial): Promise<GeminiFilesClientLike> {
  const ai = await newGoogleGenAI(auth)

  return {
    async upload(params) {
      // Real SDK accepts string | Blob; convert Uint8Array → Blob.
      // Uint8Array.from() copies into a fresh, plain ArrayBuffer-backed
      // array — BlobPart requires Uint8Array<ArrayBuffer>, which excludes
      // the SharedArrayBuffer-backed views that Uint8Array<ArrayBufferLike>
      // (the type of params.file) may structurally include.
      const fileArg: Blob =
        params.file instanceof Uint8Array
          ? new Blob([Uint8Array.from(params.file)], {
              ...(params.config?.mimeType !== undefined
                ? { type: params.config.mimeType }
                : {}),
            })
          : params.file

      const result = await (ai.files.upload as (p: unknown) => Promise<FileResp>)({
        file: fileArg,
        ...(params.config !== undefined ? { config: params.config } : {}),
      })
      return result
    },

    async get(params) {
      const result = await (ai.files.get as (p: unknown) => Promise<FileResp>)(params)
      return result
    },

    async delete(params) {
      await (ai.files.delete as (p: unknown) => Promise<unknown>)(params)
    },
  }
}

function makeHandle(
  resp: FileResp,
  fallback: { name: string; uri: string; mimeType: string },
): GoogleFileHandle {
  const et = resp.expirationTime
  return {
    name: resp.name ?? fallback.name,
    uri: resp.uri ?? fallback.uri,
    mimeType: resp.mimeType ?? fallback.mimeType,
    ...(et !== undefined && et.length > 0 ? { expiresAt: new Date(et) } : {}),
  }
}

// ---------------------------------------------------------------------------
// GoogleFileStore
// ---------------------------------------------------------------------------

/**
 * **Auth snapshot note:** this store captures the `AuthMaterial` at construction
 * time and memoizes a single SDK client from it (`clientPromise`).  This is
 * correct and sufficient for static API keys.  If refreshable credentials
 * (short-lived OAuth/STS tokens) are added in the future, this memoization is
 * the seam that will need rework: the cached client would hold stale credentials
 * for the lifetime of a long-lived store instance.  At that point, the store
 * will need to either rebuild the client on each operation or accept a
 * credential-resolver callback rather than a plain `AuthMaterial` value.
 * See ADR-020 in DECISIONS.md.
 */
export class GoogleFileStore {
  private readonly auth: AuthMaterial
  private readonly clientOverride: GeminiFilesClientLike | undefined
  private readonly onDeleteError: (name: string, err: unknown) => void
  private readonly logger: Logger | undefined
  private readonly intervalMs: number
  private readonly timeoutMs: number
  private readonly startWait: (ms: number) => Wait
  private readonly scheduler: Scheduler
  private readonly now: () => number
  /** Memoised client promise — built at most once per store instance. */
  private clientPromise: Promise<GeminiFilesClientLike> | undefined

  constructor(opts: GoogleFileStoreOptions) {
    this.auth = opts.auth
    this.clientOverride = opts.client
    this.logger = opts.logger
    this.onDeleteError =
      opts.onDeleteError ??
      ((name, err) => {
        if (this.logger !== undefined) {
          this.logger.error(
            { name, error: redactSecrets(classifyGoogleError(err).message) },
            'gemini.file.delete.failed',
          )
        } else {
          console.error(
            `[GoogleFileStore] delete failed for "${name}":`,
            redactSecrets(classifyGoogleError(err).message),
          )
        }
      })
    this.intervalMs = opts.poll?.intervalMs ?? DEFAULT_INTERVAL_MS
    this.timeoutMs = opts.poll?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.scheduler = opts.scheduler ?? PLATFORM_SCHEDULER
    const customSleep = opts.sleep
    this.startWait =
      customSleep !== undefined
        ? (ms) => ({ promise: customSleep(ms), cancel: () => {} })
        : waitOn(this.scheduler)
    this.now = opts.now ?? (() => Date.now())
  }

  private getClient(): Promise<GeminiFilesClientLike> {
    if (this.clientOverride !== undefined) return Promise.resolve(this.clientOverride)
    if (this.clientPromise === undefined) {
      this.clientPromise = buildFilesClient(this.auth)
    }
    return this.clientPromise
  }

  /**
   * Upload bytes to the Gemini File API and wait until the file is ACTIVE.
   *
   * @param source  - Raw bytes or Blob.
   * @param mimeType - IANA media type, e.g. `"image/png"`. It must pass the same
   *   admission rule `generate` applies to a Gemini model's parts (one shared
   *   function, so a file that uploads can be used): an empty or unadmitted type
   *   is `bad_request` before any bytes are sent. The string is sent to Google
   *   unchanged.
   * @param opts    - Optional display name.
   */
  async upload(
    source: Uint8Array | Blob,
    mimeType: string,
    opts?: { displayName?: string; signal?: AbortSignal },
  ): Promise<GoogleFileHandle> {
    const signal = opts?.signal
    assertMediaTypeAdmitted(
      mimeType,
      GEMINI_INPUT_MIME_TYPES,
      'mimeType',
      'google',
      'a Google file upload',
    )
    const client = await this.getClient()

    if (signal?.aborted === true) {
      throw new LlmError('File upload aborted', { kind: 'aborted', retryable: false })
    }

    let uploadResp: FileResp
    try {
      // The signal goes to the SDK, and the wait is also raced against it: the
      // SDK's upload does not act on `abortSignal` (checked in
      // `@google/genai` 2.25.0), and an abort cannot recall bytes already sent,
      // so the file may still be stored; the caller is released at once.
      uploadResp = await abortable(
        client.upload({
          file: source,
          config: {
            mimeType,
            ...(opts?.displayName !== undefined ? { displayName: opts.displayName } : {}),
            ...(signal !== undefined ? { abortSignal: signal } : {}),
          },
        }),
        signal,
      )
    } catch (e) {
      throw classifyGoogleError(e)
    }

    const { name, uri } = uploadResp

    if (
      name === undefined ||
      name.length === 0 ||
      uri === undefined ||
      uri.length === 0
    ) {
      // Provider fault, not caller fault: the SDK call succeeded but the
      // payload is malformed — classify as a server error. NOT retryable:
      // upload() is side-effecting and not idempotent — the provider may have
      // already stored the file even though the payload carries no name/uri,
      // so there is no handle to clean up and an automatic retry could
      // orphan/duplicate provider-side resources.
      throw new LlmError('File upload response missing required fields (name or uri)', {
        kind: 'server',
        retryable: false,
        provider: 'google',
      })
    }

    const fallback = { name, uri, mimeType }

    if (uploadResp.state === 'ACTIVE') {
      return makeHandle(uploadResp, fallback)
    }

    if (uploadResp.state === 'FAILED') {
      throw failedFile('File processing failed immediately after upload', uploadResp)
    }

    // PROCESSING (or unknown) — poll until ACTIVE or timeout.
    const deadline = this.now() + this.timeoutMs

    // Pre-flight: if the signal is already aborted, throw before creating any
    // promise so we never produce an unhandled rejection. Cast: TS keeps the
    // narrowing from the check before the upload across the awaits.
    if ((signal?.aborted as boolean | undefined) === true) {
      throw new LlmError('File upload polling aborted', {
        kind: 'aborted',
        retryable: false,
      })
    }

    // Build an abort-race promise so future aborts wake up the sleep race
    // immediately rather than waiting the full interval.  Created only when
    // the signal is NOT already aborted (guard above handles that case). It is
    // observed from the start (a loop that ends before the first race, or after
    // the last, must not leave a rejection nobody handles), and its listener is
    // removed on every way out of the loop.
    let onAbort: (() => void) | undefined
    const abortRacePromise: Promise<never> | undefined =
      signal !== undefined
        ? new Promise<never>((_, reject) => {
            onAbort = () => {
              reject(
                new LlmError('File upload polling aborted', {
                  kind: 'aborted',
                  retryable: false,
                }),
              )
            }
            signal.addEventListener('abort', onAbort, { once: true })
          })
        : undefined
    abortRacePromise?.catch(() => {})

    try {
      return await this.pollUntilActive(
        client,
        name,
        fallback,
        deadline,
        signal,
        abortRacePromise,
      )
    } finally {
      if (signal !== undefined && onAbort !== undefined) {
        signal.removeEventListener('abort', onAbort)
      }
    }
  }

  /**
   * `work` raced against the abort promise and the time left until `deadline`
   * (the deadline is a non-retryable `server` error). `work` is observed, so a
   * late rejection after the race is lost is not unhandled; the deadline timer
   * is always cleared.
   */
  private async raceDeadline<T>(
    work: Promise<T>,
    name: string,
    deadline: number,
    abortRacePromise: Promise<never> | undefined,
  ): Promise<T> {
    work.catch(() => {})
    const remainingMs = deadline - this.now()
    let deadlineTimer: ReturnType<Scheduler['setTimeout']> | undefined
    const deadlineRace = new Promise<never>((_, reject) => {
      // Too far out for a timer: the abort is then the only early exit.
      if (remainingMs > MAX_TIMER_MS) return
      deadlineTimer = this.scheduler.setTimeout(
        () => {
          reject(pollTimeoutError(name))
        },
        Math.max(remainingMs, 0),
      )
    })
    deadlineRace.catch(() => {})
    try {
      return await Promise.race(
        abortRacePromise !== undefined
          ? [work, deadlineRace, abortRacePromise]
          : [work, deadlineRace],
      )
    } finally {
      if (deadlineTimer !== undefined) this.scheduler.clearTimeout(deadlineTimer)
    }
  }

  /** Polls `name` until ACTIVE; see {@link GoogleFileStore.upload}. */
  private async pollUntilActive(
    client: GeminiFilesClientLike,
    name: string,
    fallback: { name: string; uri: string; mimeType: string },
    deadline: number,
    signal: AbortSignal | undefined,
    abortRacePromise: Promise<never> | undefined,
  ): Promise<GoogleFileHandle> {
    for (;;) {
      if (this.now() >= deadline) {
        throw pollTimeoutError(name)
      }

      // The wait is raced against the abort and the rest of the polling
      // deadline: a poll interval longer than the time left ends at the
      // deadline, not after it.
      const wait = this.startWait(this.intervalMs)
      try {
        await this.raceDeadline(wait.promise, name, deadline, abortRacePromise)
      } finally {
        wait.cancel()
      }

      // The clock is checked again before a request starts: a wait that a custom
      // `sleep` let run past the deadline must not buy one more poll.
      if (this.now() >= deadline) {
        throw pollTimeoutError(name)
      }

      // The poll request is raced the same way, so a `get()` that stalls ends at
      // whichever comes first instead of holding `upload()` open. The losing
      // request is observed, so a late rejection is not unhandled.
      const pollCall = (async (): Promise<FileResp> => {
        try {
          return await client.get({ name })
        } catch (e) {
          throw classifyGoogleError(e)
        }
      })()
      const pollResp = await this.raceDeadline(pollCall, name, deadline, abortRacePromise)

      // Also guard here: the signal may have fired during client.get()
      // before we looped back to the sleep race.
      if (signal?.aborted === true) {
        throw new LlmError('File upload polling aborted', {
          kind: 'aborted',
          retryable: false,
        })
      }

      // A response that arrives after the deadline is not accepted, `ACTIVE`
      // included: the caller was promised an answer by then.
      if (this.now() >= deadline) {
        throw pollTimeoutError(name)
      }

      if (pollResp.state === 'ACTIVE') {
        return makeHandle(pollResp, fallback)
      }

      if (pollResp.state === 'FAILED') {
        throw failedFile('File processing failed during polling', pollResp)
      }
      // PROCESSING — continue loop
    }
  }

  /**
   * Delete a single uploaded file. Idempotent: not-found → success.
   *
   * Default (`failClosed` omitted/false): errors go to `onDeleteError` and
   * resolve (P5 fail-open). With `failClosed: true`, non-not-found errors
   * throw typed `LlmError` and `onDeleteError` is not called.
   *
   * Empty/blank `handle.name` always throws `bad_request`.
   */
  async delete(handle: GoogleFileHandle, opts?: FileDeleteOptions): Promise<void> {
    const name = handle.name
    if (typeof name !== 'string' || name.trim() === '') {
      throw new LlmError('GoogleFileHandle.name must be a non-empty string.', {
        kind: 'bad_request',
        retryable: false,
        provider: 'google',
      })
    }

    const failClosed = opts?.failClosed === true

    try {
      if (opts?.signal?.aborted === true) {
        throw new LlmError('Google file delete aborted', {
          kind: 'aborted',
          retryable: false,
          provider: 'google',
        })
      }
      const client = await this.getClient()
      await client.delete({ name })
    } catch (err) {
      if (isGoogleNotFoundError(err)) {
        return
      }
      const withProvider = classifyGoogleError(err)

      if (failClosed) {
        throw withProvider
      }
      this.onDeleteError(name, withProvider)
    }
  }

  /**
   * Delete multiple files.
   *
   * Fail-open (default): `Promise.allSettled` per handle.
   * Fail-closed: `Promise.all` — first throw rejects; in-flight siblings are
   * not cancelled. Prefer per-handle delete when gating durable release state.
   */
  async deleteAll(handles: GoogleFileHandle[], opts?: FileDeleteOptions): Promise<void> {
    if (opts?.failClosed === true) {
      await Promise.all(handles.map((h) => this.delete(h, opts)))
      return
    }
    await Promise.allSettled(handles.map((h) => this.delete(h, opts)))
  }
}

/**
 * gRPC codes (`google.rpc.Code`) a `File.error` status can carry that name a
 * provider-side, transient failure: `DEADLINE_EXCEEDED` (4), `INTERNAL` (13)
 * and `UNAVAILABLE` (14). Processing the same bytes again can succeed.
 */
const TRANSIENT_FILE_STATUS_CODES = new Set([4, 13, 14])

/**
 * A `FAILED` file, carrying the provider's own `File.error` (message in the
 * text, the whole `FileStatus` as `cause`). `File.error` is a `google.rpc.Status`:
 * a transient code (`DEADLINE_EXCEEDED`, `INTERNAL`, `UNAVAILABLE`) is a
 * retryable `server` error, since the failure is the provider's and a fresh
 * upload can succeed; any other code, or none, is a non-retryable `bad_request`
 * (the file itself cannot be processed).
 */
function failedFile(prefix: string, resp: FileResp): LlmError {
  const providerMessage = resp.error?.message
  const transient =
    typeof resp.error?.code === 'number' &&
    TRANSIENT_FILE_STATUS_CODES.has(resp.error.code)
  return new LlmError(
    providerMessage !== undefined && providerMessage.length > 0
      ? `${prefix}: ${providerMessage}`
      : prefix,
    {
      kind: transient ? 'server' : 'bad_request',
      retryable: transient,
      provider: 'google',
      ...(resp.error !== undefined ? { cause: resp.error } : {}),
    },
  )
}

/**
 * Races `promise` against `signal`: an abort rejects with an `aborted`
 * `LlmError` while the underlying work carries on unobserved.
 */
async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return promise
  promise.catch(() => {})
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(new LlmError('File upload aborted', { kind: 'aborted', retryable: false }))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}
