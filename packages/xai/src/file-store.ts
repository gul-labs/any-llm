/**
 * XaiFileStore — thin wrapper over the xAI Files REST API.
 *
 * Upload / get / list / delete / content over injectable `fetch`.
 * No READY-state polling (upload returns metadata immediately).
 * No ambient credential reads — auth is injected at construction.
 *
 * @module
 */

import type { AuthMaterial, JsonValue, Logger } from '@gullabs/core'
import { LlmError, classifyError, redactSecrets } from '@gullabs/core'

import { XAI_MAX_TIMEOUT_MS, requireApiKey } from './client.js'
import { classifyXaiError } from './adapter.js'

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/** xAI minimum `expires_after` (1 hour), inclusive. */
export const XAI_FILE_TTL_MIN_SECONDS = 3_600

/** xAI maximum `expires_after` (30 days), inclusive. */
export const XAI_FILE_TTL_MAX_SECONDS = 2_592_000

/**
 * Conservative max upload size (48 MiB). Managing-files docs say ~48 MB;
 * upload REST says 50 MB — we take the lower bound.
 */
export const XAI_FILE_MAX_BYTES = 48 * 1024 * 1024

/** Default Files API base (includes `/v1`). */
export const XAI_FILES_DEFAULT_BASE_URL = 'https://api.x.ai/v1'

/**
 * Default deadline of one Files API call (headers and body), in milliseconds:
 * 60 s. A store with an `AbortSignal` of its own still honours it; a very large
 * upload on a slow link needs a larger `timeoutMs` in {@link XaiFileStoreOptions}.
 */
export const XAI_FILES_DEFAULT_TIMEOUT_MS = 60_000

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A handle to a file stored in the xAI Files API. */
export interface XaiFileHandle {
  /** File id, e.g. `"file_a128090d-…"`. Use as `FileRefPart.fileId`. */
  id: string
  filename?: string
  bytes?: number
  purpose?: string
  createdAt?: Date
  /** Present when the file has a TTL; key omitted when permanent / unknown. */
  expiresAt?: Date
  /** Full vendor JSON object for forward-compat (P2 raw lane). */
  raw?: { [k: string]: JsonValue }
}

export interface XaiFileUploadInput {
  data: Uint8Array | Blob
  filename: string
  mimeType?: string
  /**
   * TTL in seconds. Must be an integer in
   * `[XAI_FILE_TTL_MIN_SECONDS, XAI_FILE_TTL_MAX_SECONDS]` when set.
   * Omit only for permanent storage (discouraged for ephemeral corpus).
   */
  expiresAfterSeconds?: number
  /** Default `"assistants"` (OpenAI SDK convention; xAI does not enforce). */
  purpose?: string
}

export interface XaiFileListOptions {
  /** 1..100. Server default is 100 when omitted. */
  limit?: number
  order?: 'asc' | 'desc'
  sortBy?: 'created_at' | 'filename' | 'size'
  paginationToken?: string
}

export interface XaiFileListResult {
  files: XaiFileHandle[]
  paginationToken?: string
}

/**
 * Options for {@link XaiFileStore.delete} / {@link XaiFileStore.deleteAll}.
 *
 * Default is fail-open (P5 side-effect style). Pass `failClosed: true` when
 * the host gates durable state (e.g. `released_at`) on known delete success.
 */
export interface FileDeleteOptions {
  signal?: AbortSignal
  /**
   * When true, non-404 failures throw typed `LlmError`.
   * When false/omitted, non-404 failures invoke `onDeleteError` and resolve.
   * HTTP 404 is success in both modes (idempotent).
   */
  failClosed?: boolean
}

export interface XaiFileStoreOptions {
  auth: AuthMaterial
  /** Default {@link XAI_FILES_DEFAULT_BASE_URL}. */
  baseUrl?: string
  /** Injectable fetch for tests. Default: global `fetch`. */
  fetch?: typeof fetch
  /**
   * Deadline of each call (response headers and body) in milliseconds. A call
   * that is still open then fails with a retryable `timeout` error. An integer
   * from 1 to {@link XAI_MAX_TIMEOUT_MS}; default {@link XAI_FILES_DEFAULT_TIMEOUT_MS}.
   */
  timeoutMs?: number
  /**
   * Delete failures that are NOT already-gone (404).
   * Default: `logger.error` or `console.error` with a redacted message.
   */
  onDeleteError?: (fileId: string, err: unknown) => void
  logger?: Logger
  /** Injectable clock for tests. Default: `Date.now`. */
  now?: () => number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type VendorFileObject = {
  id?: unknown
  filename?: unknown
  bytes?: unknown
  purpose?: unknown
  created_at?: unknown
  expires_at?: unknown
  object?: unknown
  [k: string]: unknown
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function badRequest(message: string): LlmError {
  return new LlmError(message, {
    kind: 'bad_request',
    retryable: false,
    provider: 'xai',
  })
}

function resolveFileId(fileIdOrHandle: string | Pick<XaiFileHandle, 'id'>): string {
  if (typeof fileIdOrHandle === 'string') {
    return fileIdOrHandle
  }
  return fileIdOrHandle.id
}

function unixSecondsToDate(value: unknown): Date | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return new Date(value * 1000)
}

function makeHandle(raw: VendorFileObject): XaiFileHandle {
  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new LlmError('File response missing required field (id)', {
      kind: 'server',
      retryable: false,
      provider: 'xai',
    })
  }

  const handle: XaiFileHandle = {
    id: raw.id,
    raw: raw as { [k: string]: JsonValue },
  }

  if (typeof raw.filename === 'string' && raw.filename.length > 0) {
    handle.filename = raw.filename
  }
  if (typeof raw.bytes === 'number' && Number.isFinite(raw.bytes)) {
    handle.bytes = raw.bytes
  }
  if (typeof raw.purpose === 'string') {
    handle.purpose = raw.purpose
  }

  const createdAt = unixSecondsToDate(raw.created_at)
  if (createdAt !== undefined) {
    handle.createdAt = createdAt
  }

  // expires_at is null for permanent files — omit the key entirely (Google parity).
  if (raw.expires_at !== null && raw.expires_at !== undefined) {
    const expiresAt = unixSecondsToDate(raw.expires_at)
    if (expiresAt !== undefined) {
      handle.expiresAt = expiresAt
    }
  }

  return handle
}

function byteLengthOf(data: Uint8Array | Blob): number {
  return data instanceof Uint8Array ? data.byteLength : data.size
}

function toBlob(data: Uint8Array | Blob, mimeType: string | undefined): Blob {
  if (data instanceof Blob) {
    return data
  }
  // Copy into a plain ArrayBuffer-backed view for BlobPart typing.
  const copy = Uint8Array.from(data)
  return mimeType !== undefined && mimeType.length > 0
    ? new Blob([copy], { type: mimeType })
    : new Blob([copy])
}

/**
 * Shape a non-2xx fetch response into a throw value that
 * {@link classifyXaiError} / {@link classifyError} understand:
 * - `.status` for HTTP routing
 * - `.error` for structured body (auth-body detection)
 */
/**
 * Error shaped for {@link classifyError} / {@link classifyXaiError}:
 * numeric `.status` for HTTP routing, `.error` for structured body text.
 */
class XaiFilesHttpError extends Error {
  readonly status: number
  readonly error: unknown
  /** The response headers: `classifyError` reads `Retry-After` from them. */
  readonly headers: Headers

  constructor(status: number, message: string, errorBody: unknown, headers: Headers) {
    super(message)
    this.name = 'XaiFilesHttpError'
    this.status = status
    this.error = errorBody
    this.headers = headers
  }
}

async function throwHttpFailure(res: Response): Promise<never> {
  const status = res.status
  let bodyText = ''
  try {
    bodyText = await res.text()
  } catch {
    bodyText = ''
  }

  let parsed: unknown = bodyText
  if (bodyText.length > 0) {
    try {
      parsed = JSON.parse(bodyText) as unknown
    } catch {
      parsed = bodyText
    }
  }

  let message = `xAI Files API HTTP ${status}`
  if (typeof parsed === 'string' && parsed.length > 0) {
    message = parsed
  } else if (isPlainRecord(parsed) && typeof parsed['error'] === 'string') {
    message = parsed['error']
  }
  const requestId = res.headers.get('x-request-id')
  if (requestId !== null && requestId !== '') message += ` (request id ${requestId})`

  throw new XaiFilesHttpError(status, message, parsed, res.headers)
}

function isNotFoundError(err: unknown): boolean {
  if (err instanceof LlmError && err.httpStatus === 404) {
    return true
  }
  if (typeof err === 'object' && err !== null) {
    const status = (err as { status?: unknown }).status
    if (status === 404) return true
    const httpStatus = (err as { httpStatus?: unknown }).httpStatus
    if (httpStatus === 404) return true
  }
  return false
}

function notFoundError(fileId: string, operation: string): LlmError {
  return new LlmError(`xAI file not found during ${operation}: "${fileId}"`, {
    kind: 'bad_request',
    retryable: false,
    httpStatus: 404,
    provider: 'xai',
  })
}

function maybeZdrHint(message: string): string {
  if (
    /zero\s*data\s*retention|\bzdr\b|files?\s+(api\s+)?(disabled|unavailable|not supported)/i.test(
      message,
    )
  ) {
    return `${message} (xAI Zero Data Retention blocks new file uploads and file_id attachments for this team.)`
  }
  return message
}

/** Prefer structured body text / explicit message over generic `HTTP NNN`. */
function extractThrownMessage(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj['message'] === 'string' && obj['message'].length > 0) {
    return obj['message']
  }
  const err = obj['error']
  if (typeof err === 'string' && err.length > 0) return err
  if (typeof err === 'object' && err !== null) {
    const nested = err as Record<string, unknown>
    if (typeof nested['error'] === 'string' && nested['error'].length > 0) {
      return nested['error']
    }
    if (typeof nested['message'] === 'string' && nested['message'].length > 0) {
      return nested['message']
    }
  }
  return undefined
}

function classifyStoreError(raw: unknown): LlmError {
  if (raw instanceof LlmError) {
    return raw
  }
  const classified = classifyXaiError(raw)
  const bodyMessage = extractThrownMessage(raw)
  // classifyError maps plain `{ status }` throws to generic "HTTP NNN" — prefer
  // the structured body text we attached in throwHttpFailure when present.
  const baseMessage =
    bodyMessage !== undefined &&
    (classified.message.startsWith('HTTP ') || classified.message.length === 0)
      ? bodyMessage
      : classified.message
  const hinted = maybeZdrHint(baseMessage)
  if (
    hinted === classified.message &&
    classified.provider === 'xai' &&
    bodyMessage === undefined
  ) {
    return classified
  }
  return new LlmError(hinted, {
    kind: classified.kind,
    retryable: classified.retryable,
    ...(classified.httpStatus !== undefined ? { httpStatus: classified.httpStatus } : {}),
    ...(classified.retryAfterMs !== undefined
      ? { retryAfterMs: classified.retryAfterMs }
      : {}),
    provider: 'xai',
    cause: classified.cause ?? raw,
  })
}

// ---------------------------------------------------------------------------
// Per-call deadline
// ---------------------------------------------------------------------------

/** The `LlmError`s a store's own deadline timer created, to tell them from a caller's abort. */
const DEADLINE_ERRORS = new WeakSet()

/**
 * The error a call whose `signal` aborted ends in: the store's own timeout when
 * its deadline fired, else an `aborted` error carrying the caller's reason.
 */
function abortedError(signal: AbortSignal, message: string, cause?: unknown): LlmError {
  const reason: unknown = signal.reason
  if (reason instanceof LlmError && DEADLINE_ERRORS.has(reason)) return reason
  return new LlmError(message, {
    kind: 'aborted',
    retryable: false,
    provider: 'xai',
    ...(cause !== undefined ? { cause } : {}),
  })
}

/**
 * `id` as one URL path segment. `encodeURIComponent` keeps `/`, `?` and `#` in an
 * id from addressing another path; `.` and `..` survive it and are refused.
 */
function pathSegment(id: string): string {
  if (id === '.' || id === '..') {
    throw badRequest(`fileId "${id}" is not a valid file id.`)
  }
  return encodeURIComponent(id)
}

// ---------------------------------------------------------------------------
// XaiFileStore
// ---------------------------------------------------------------------------

/**
 * **Auth snapshot note:** captures `AuthMaterial` at construction and holds
 * the resolved API key for the store lifetime. Correct for static API keys.
 * Refreshable credentials would need a resolver callback (see GoogleFileStore
 * / ADR-020).
 */
export class XaiFileStore {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly onDeleteError: (fileId: string, err: unknown) => void
  private readonly logger: Logger | undefined

  constructor(opts: XaiFileStoreOptions) {
    this.apiKey = requireApiKey(opts.auth)
    this.baseUrl = (opts.baseUrl ?? XAI_FILES_DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.fetchImpl = opts.fetch ?? fetch
    const timeoutMs = opts.timeoutMs ?? XAI_FILES_DEFAULT_TIMEOUT_MS
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > XAI_MAX_TIMEOUT_MS) {
      throw badRequest(
        `XaiFileStoreOptions.timeoutMs must be an integer from 1 to ${XAI_MAX_TIMEOUT_MS}.`,
      )
    }
    this.timeoutMs = timeoutMs
    this.logger = opts.logger
    this.onDeleteError =
      opts.onDeleteError ??
      ((fileId, err) => {
        const message = redactSecrets(classifyError(err).message)
        if (this.logger !== undefined) {
          this.logger.error({ fileId, error: message }, 'xai.file.delete.failed')
        } else {
          console.error(`[XaiFileStore] delete failed for "${fileId}":`, message)
        }
      })
  }

  private authHeaders(): Headers {
    const headers = new Headers()
    headers.set('Authorization', `Bearer ${this.apiKey}`)
    return headers
  }

  private filesUrl(path = ''): string {
    if (path.length === 0) return `${this.baseUrl}/files`
    return `${this.baseUrl}/files/${path.replace(/^\//, '')}`
  }

  /** Build RequestInit without writing `signal: undefined` (exactOptionalPropertyTypes). */
  private requestInit(
    method: string,
    opts?: { body?: FormData; signal?: AbortSignal },
  ): RequestInit {
    const init: RequestInit = {
      method,
      headers: this.authHeaders(),
    }
    if (opts?.body !== undefined) {
      init.body = opts.body
    }
    if (opts?.signal !== undefined) {
      init.signal = opts.signal
    }
    return init
  }

  /**
   * Runs one call under the store's deadline: `run` gets a signal that aborts
   * when the caller's does or when `timeoutMs` passes (headers and body read
   * both count), and the timer is cleared however the call ends.
   */
  private async bounded<T>(
    caller: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController()
    const forward = (): void => {
      controller.abort(caller?.reason)
    }
    if (caller?.aborted === true) forward()
    else caller?.addEventListener('abort', forward, { once: true })
    const timer = setTimeout(() => {
      const error = new LlmError(
        `xAI Files API call timed out after ${this.timeoutMs}ms`,
        {
          kind: 'timeout',
          retryable: true,
          provider: 'xai',
        },
      )
      DEADLINE_ERRORS.add(error)
      controller.abort(error)
    }, this.timeoutMs)
    try {
      return await run(controller.signal)
    } finally {
      clearTimeout(timer)
      caller?.removeEventListener('abort', forward)
    }
  }

  /**
   * Upload bytes to xAI Files. Returns immediately with metadata (no poll).
   *
   * Multipart field order is load-bearing: `expires_after` then `purpose`
   * then `file` — reversing order yields HTTP 400 from xAI.
   */
  async upload(input: XaiFileUploadInput, signal?: AbortSignal): Promise<XaiFileHandle> {
    if (typeof input.filename !== 'string' || input.filename.trim() === '') {
      throw badRequest('XaiFileUploadInput.filename must be a non-empty string.')
    }

    const size = byteLengthOf(input.data)
    if (size > XAI_FILE_MAX_BYTES) {
      throw badRequest(
        `xAI file uploads must be at most ${XAI_FILE_MAX_BYTES} bytes (48 MiB); got ${size}.`,
      )
    }

    if (input.expiresAfterSeconds !== undefined) {
      const ttl = input.expiresAfterSeconds
      if (
        typeof ttl !== 'number' ||
        !Number.isInteger(ttl) ||
        ttl < XAI_FILE_TTL_MIN_SECONDS ||
        ttl > XAI_FILE_TTL_MAX_SECONDS
      ) {
        throw badRequest(
          `expiresAfterSeconds must be an integer in [${XAI_FILE_TTL_MIN_SECONDS}, ${XAI_FILE_TTL_MAX_SECONDS}]; got ${String(ttl)}.`,
        )
      }
    }

    const purpose = input.purpose ?? 'assistants'
    const form = new FormData()

    // Order: expires_after → purpose → file (xAI multipart requirement).
    if (input.expiresAfterSeconds !== undefined) {
      form.append('expires_after', String(input.expiresAfterSeconds))
    }
    form.append('purpose', purpose)
    form.append('file', toBlob(input.data, input.mimeType), input.filename)

    return this.bounded(signal, async (bound) => {
      let res: Response
      try {
        res = await this.fetchImpl(
          this.filesUrl(),
          this.requestInit('POST', { body: form, signal: bound }),
        )
      } catch (e) {
        if (bound.aborted) throw abortedError(bound, 'xAI file upload aborted')
        throw classifyStoreError(e)
      }

      if (!res.ok) {
        try {
          await throwHttpFailure(res)
        } catch (e) {
          throw classifyStoreError(e)
        }
      }

      let json: unknown
      try {
        json = await res.json()
      } catch (e) {
        if (bound.aborted) throw abortedError(bound, 'xAI file upload aborted', e)
        throw new LlmError('xAI file upload returned non-JSON body', {
          kind: 'server',
          retryable: false,
          provider: 'xai',
          cause: e,
        })
      }

      return makeHandle(json as VendorFileObject)
    })
  }

  async get(fileId: string, signal?: AbortSignal): Promise<XaiFileHandle> {
    if (typeof fileId !== 'string' || fileId.trim() === '') {
      throw badRequest('fileId must be a non-empty string.')
    }
    const url = this.filesUrl(pathSegment(fileId))

    return this.bounded(signal, async (bound) => {
      let res: Response
      try {
        res = await this.fetchImpl(url, this.requestInit('GET', { signal: bound }))
      } catch (e) {
        if (bound.aborted) throw abortedError(bound, 'xAI file get aborted')
        throw classifyStoreError(e)
      }

      if (res.status === 404) {
        throw notFoundError(fileId, 'get')
      }

      if (!res.ok) {
        try {
          await throwHttpFailure(res)
        } catch (e) {
          throw classifyStoreError(e)
        }
      }

      return makeHandle((await readJsonBody(res, bound, 'get')) as VendorFileObject)
    })
  }

  async list(
    opts: XaiFileListOptions = {},
    signal?: AbortSignal,
  ): Promise<XaiFileListResult> {
    if (opts.limit !== undefined) {
      if (
        typeof opts.limit !== 'number' ||
        !Number.isInteger(opts.limit) ||
        opts.limit < 1 ||
        opts.limit > 100
      ) {
        throw badRequest('list.limit must be an integer in [1, 100].')
      }
    }

    const params = new URLSearchParams()
    if (opts.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts.order !== undefined) params.set('order', opts.order)
    if (opts.sortBy !== undefined) params.set('sort_by', opts.sortBy)
    if (opts.paginationToken !== undefined) {
      params.set('pagination_token', opts.paginationToken)
    }

    const qs = params.toString()
    const url = qs.length > 0 ? `${this.filesUrl()}?${qs}` : this.filesUrl()

    return this.bounded(signal, async (bound) => {
      let res: Response
      try {
        res = await this.fetchImpl(url, this.requestInit('GET', { signal: bound }))
      } catch (e) {
        if (bound.aborted) throw abortedError(bound, 'xAI file list aborted')
        throw classifyStoreError(e)
      }

      if (!res.ok) {
        try {
          await throwHttpFailure(res)
        } catch (e) {
          throw classifyStoreError(e)
        }
      }

      const json = (await readJsonBody(res, bound, 'list')) as {
        data?: VendorFileObject[]
        pagination_token?: string
      }
      const files = Array.isArray(json.data) ? json.data.map((f) => makeHandle(f)) : []
      const result: XaiFileListResult = { files }
      if (typeof json.pagination_token === 'string' && json.pagination_token.length > 0) {
        result.paginationToken = json.pagination_token
      }
      return result
    })
  }

  /**
   * Delete a file. Idempotent: HTTP 404 → success.
   *
   * Default (`failClosed` omitted/false): non-404 errors go to `onDeleteError`
   * and resolve (P5 fail-open). With `failClosed: true`, non-404 errors throw
   * typed `LlmError` and `onDeleteError` is not called.
   *
   * Empty/blank ids always throw `bad_request` (caller fault).
   */
  async delete(
    fileIdOrHandle: string | Pick<XaiFileHandle, 'id'>,
    opts?: FileDeleteOptions,
  ): Promise<void> {
    const fileId = resolveFileId(fileIdOrHandle)
    if (typeof fileId !== 'string' || fileId.trim() === '') {
      throw badRequest('fileId must be a non-empty string.')
    }
    const url = this.filesUrl(pathSegment(fileId))

    const failClosed = opts?.failClosed === true

    await this.bounded(opts?.signal, async (bound) => {
      try {
        const res = await this.fetchImpl(
          url,
          this.requestInit('DELETE', { signal: bound }),
        )

        if (res.status === 404) {
          return
        }

        if (!res.ok) {
          await throwHttpFailure(res)
        }
      } catch (err) {
        if (isNotFoundError(err)) {
          return
        }

        // Abort during fetch: surface as aborted LlmError through the same path.
        const classified =
          bound.aborted && !(err instanceof LlmError)
            ? abortedError(bound, 'xAI file delete aborted', err)
            : classifyStoreError(err)

        if (failClosed) {
          throw classified
        }
        this.onDeleteError(fileId, classified)
      }
    })
  }

  /**
   * Delete many files.
   *
   * Fail-open (default): `Promise.allSettled` — each failure → `onDeleteError`.
   * Fail-closed: `Promise.all` — first throw rejects; in-flight siblings are
   * not cancelled (partial deletes may already have succeeded at the provider).
   * Prefer per-id delete + host DB mark when gating durable release state.
   */
  async deleteAll(
    ids: ReadonlyArray<string | Pick<XaiFileHandle, 'id'>>,
    opts?: FileDeleteOptions,
  ): Promise<void> {
    if (opts?.failClosed === true) {
      await Promise.all(ids.map((id) => this.delete(id, opts)))
      return
    }
    await Promise.allSettled(ids.map((id) => this.delete(id, opts)))
  }

  /** Download raw file bytes. */
  async getContent(fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
    if (typeof fileId !== 'string' || fileId.trim() === '') {
      throw badRequest('fileId must be a non-empty string.')
    }
    const url = this.filesUrl(`${pathSegment(fileId)}/content`)

    return this.bounded(signal, async (bound) => {
      let res: Response
      try {
        res = await this.fetchImpl(url, this.requestInit('GET', { signal: bound }))
      } catch (e) {
        if (bound.aborted) throw abortedError(bound, 'xAI file content download aborted')
        throw classifyStoreError(e)
      }

      if (res.status === 404) {
        throw notFoundError(fileId, 'getContent')
      }

      if (!res.ok) {
        try {
          await throwHttpFailure(res)
        } catch (e) {
          throw classifyStoreError(e)
        }
      }

      try {
        return new Uint8Array(await res.arrayBuffer())
      } catch (e) {
        if (bound.aborted)
          throw abortedError(bound, 'xAI file content download aborted', e)
        throw classifyStoreError(e)
      }
    })
  }
}

/**
 * The JSON body of a 2xx response. A body that is not JSON (a gateway page behind
 * a 200) is a typed `server` error, an abort during the read is the abort.
 */
async function readJsonBody(
  res: Response,
  signal: AbortSignal,
  operation: string,
): Promise<unknown> {
  try {
    return await res.json()
  } catch (e) {
    if (signal.aborted) throw abortedError(signal, `xAI file ${operation} aborted`, e)
    throw new LlmError(`xAI file ${operation} returned a non-JSON body`, {
      kind: 'server',
      retryable: false,
      provider: 'xai',
      cause: e,
    })
  }
}
