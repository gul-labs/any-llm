# Plan: xAI Files store for `@gullabs/xai` (+ core `file-ref` part)

| Field                  | Value                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**             | SHIPPED — `@gullabs/xai@0.3.0` (`XaiFileStore` + `FileRefPart`); follow-on fail-closed in 0.4.0                                                                    |
| **Date**               | 2026-08-12                                                                                                                                                         |
| **Packages**           | Primary: `packages/xai`. Core seam: `packages/core` (`FileRefPart`). Optional fake: `packages/testing`.                                                            |
| **Consumer**           | Host applications using provider Files for multi-call document attach                                                                                              |
| **Related hosts plan** | Host-owned run-lifecycle / cleanup docs (out of this repo). Fail-closed delete: [`PLAN-file-store-fail-closed-delete.md`](./PLAN-file-store-fail-closed-delete.md) |
| **Parity reference**   | `@gullabs/google` `GoogleFileStore` + adapter `file-uri` mapping                                                                                                   |
| **Design principles**  | DESIGN.md P1–P7 (see §4)                                                                                                                                           |
| **Docs verified**      | 2026-08-12 against docs.x.ai Files managing / chat-with-files / upload REST / security FAQ                                                                         |

---

## 1. Why this is needed (consumer problem)

Hosts run document-heavy multi-call LLM pipelines:

1. Pin shared reference text in their own object store.
2. Load large source documents as evidence.
3. Fan out **one structured-output LLM call per unit of work**.

### Pain today

- Default provider is **xAI Grok** via `@gullabs/xai`.
- Evidence is still sent as **inline extracted text** on every call (~**150–200k input tokens** on a real document pack).
- Dominant cost is **re-sending the same corpus** N times (mostly input tokens on a failed `grok-4.5` run).
- Gemini has first-class **Files + Context Cache** in `@gullabs/google` (`GoogleFileStore`, `GoogleCacheStore`).
- xAI path has **no** Files store in any-llm. Host cleanup paths that accidentally construct Gemini stores on Grok runs fail at runtime.

### Decision (host production)

- **No inline corpus for production Grok multi-call runs.**
- Source documents are **uploaded to xAI Files** once per run, referenced by **`file_id`**, then **deleted**.
- Shared reference text stays in host prompts (not xAI Collections by default).
- Cleanup must be **idempotent**; **default TTL** must expire files if workers die mid-run.

any-llm must expose a clean, tested **xAI Files** surface so hosts (and other apps) do not hand-roll REST forever.

---

## 2. Goals / non-goals

### Goals

1. **`XaiFileStore`** (name parallel to `GoogleFileStore`) for upload / get / list / delete / content.
2. **Generate path** accepts xAI-hosted file references via a **core-neutral** `FileRefPart` (`kind: 'file-ref'`) mapped by the xAI adapter to Responses `{ type: 'input_file', file_id }`.
3. **TTL / `expires_after`** supported on upload (required by hosts defaults).
4. **Idempotent delete** (HTTP 404 = success; other delete failures fail-open via `onDeleteError`, matching Google P5 side-effect style).
5. **Auth via injected material** (no ambient env reads) — same as rest of any-llm (P1).
6. **Tests + fixtures** + surface exports from `@gullabs/xai` (and core type/guards).
7. **Docs**: README section + this plan’s API table + billing caveat for auto-`attachment_search`.

### Non-goals (this plan)

- **Collections** full RAG product (separate plan if needed).
- Explicit server tools surface (`web_search`, `x_search`, `code_interpreter`, collections search) and tool-call billing lanes in `computeCost`.
- Streaming.
- Public file URL product APIs (`public_url` minting) — hosts must not use public URLs for private source documents.
- Replacing a host's own corpus / lifecycle layer (any-llm provides **vendor primitives**; apps own run lifecycle).
- Changing Gemini `GoogleFileStore` behavior “for compatibility.”
- Faking file-storage $ into `computeCost` token lanes (P4: cost is freeze-at-write for generate usage only).
- Chunked upload (`/v1/files:initialize` / `:uploadChunks`) — single-shot multipart covers ≤48–50 MB docs.

---

## 3. Live xAI API contract (resolved 2026-08-12)

Sources: [Managing Files](https://docs.x.ai/developers/files/managing-files), [Chat with Files](https://docs.x.ai/developers/model-capabilities/files/chat-with-files), [Upload REST](https://docs.x.ai/developers/rest-api-reference/files/upload), [Security / ZDR](https://docs.x.ai/developers/faq/security), [Files overview](https://docs.x.ai/developers/files).

| Behavior           | Spec                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL           | `https://api.x.ai/v1`                                                                                                                                          |
| Upload             | `POST /v1/files` `multipart/form-data`                                                                                                                         |
| Auth               | `Authorization: Bearer <apiKey>` from injected `AuthMaterial` only                                                                                             |
| Max size           | **48 MB** (managing-files) / **50 MB** (upload REST) — library validates **48 MiB** hard ceiling (conservative)                                                |
| Formats            | PDF, text, md, csv, json, code, etc. (no client MIME allowlist beyond size; provider rejects unsupported)                                                      |
| **TTL**            | `expires_after` **integer seconds**, range **3600 … 2592000** inclusive; omit = permanent until delete                                                         |
| Multipart order    | **`expires_after` (and `purpose`) MUST appear before `file`** or HTTP 400                                                                                      |
| Upload response    | immediate metadata: `id`, `filename`, `bytes`, `created_at`, `expires_at` (unix s or null), `object`, `purpose` — **no processing-state poll** (unlike Gemini) |
| Get                | `GET /v1/files/{id}`                                                                                                                                           |
| List               | `GET /v1/files?limit&order&sort_by&pagination_token` (limit max 100; default 100)                                                                              |
| Content            | `GET /v1/files/{id}/content` → raw bytes                                                                                                                       |
| Delete             | `DELETE /v1/files/{id}` → `{ id, deleted }`                                                                                                                    |
| Attach (Responses) | content part `{ "type": "input_file", "file_id": "<id>" }` **or** `{ "type": "input_file", "file_url": "https://..." }`                                        |
| Auto tool          | Attaching files **implicitly enables `attachment_search`** (agentic workflow + per-invocation tool billing)                                                    |
| File id shape      | e.g. `file_a128090d-f0c9-4873-bd84-e499777e7417`                                                                                                               |
| Team scope         | Files scoped to team/org owning the API key                                                                                                                    |
| **ZDR**            | New uploads and `file_id` attachments **blocked**; existing files view/delete still allowed                                                                    |

### Storage pricing (docs; not ledgered)

| Resource       | Rate                   |
| -------------- | ---------------------- |
| File storage   | **$0.025 / GiB / day** |
| File downloads | $0.20 / GiB            |

Storage is **cheap vs token re-send**. Still require TTL + delete so failed cleanups cannot accumulate GiB forever.

**Do not** inject storage cost into `computeCost` / token lanes (P4). Apps track storage separately if needed. Document that `attachment_search` tool invocations may add tool fees on top of tokens — future Cost lane if/when tools are modeled.

---

## 4. Design principles applied (P1–P7)

| Principle                         | Application in this feature                                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1 Host owns world**            | `auth` injected at store construction; optional `fetch`, `baseUrl`, `logger`, `onDeleteError`, `now`. **Zero** `process.env` in `packages/xai` non-test sources (existing CI invariant). |
| **P2 Typed + raw**                | Typed `XaiFileHandle` fields; optional `raw` JSON capture of vendor metadata for forward-compat.                                                                                         |
| **P3 Thin adapters**              | Store = HTTP shaping only. Adapter maps `FileRefPart` → `input_file`; no cost/retry/persist.                                                                                             |
| **P4 Cost frozen at write**       | Storage $ **not** faked into generate cost. Generate path keeps existing token costing only.                                                                                             |
| **P5 Fail-open side effects**     | `delete` / `deleteAll`: 404 → silent success; other errors → `onDeleteError` + resolve void (never throw). Upload/get/list/content **fail-closed** with typed `LlmError`.                |
| **P6 Forward-compat persistence** | Handle may carry `raw`; no new ledger columns required for v1.                                                                                                                           |
| **P7 Explicit routing**           | File refs are content parts, not routing. Still require explicit `(provider, model)` on generate.                                                                                        |

### Gemini parity matrix (behavioral template, not copy-paste)

| Concern               | `GoogleFileStore`                          | `XaiFileStore` (this plan)                                                  |
| --------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| Auth                  | Injected `AuthMaterial`                    | Same; `requireApiKey`                                                       |
| Transport             | Injectable SDK client                      | Injectable `fetch` + `baseUrl` (REST multipart; no SDK files dependency)    |
| Upload readiness      | Poll until `ACTIVE`                        | **No poll** — metadata returned immediately                                 |
| TTL                   | Provider ~48h auto (read-only `expiresAt`) | Caller-set `expiresAfterSeconds`; validate 3600..2592000                    |
| Handle id             | `name` + `uri`                             | `id` (+ optional filename/bytes/…)                                          |
| Delete API            | `delete(handle)`                           | `delete(fileId \| handle)` — string id primary for hosts Postgres maps      |
| Delete 404            | Swallowed via fail-open                    | **Explicit success** (idempotent) before fail-open path                     |
| Delete other errors   | `onDeleteError` + void                     | Same + optional `logger.error` default                                      |
| Logger                | Optional `Logger`                          | Same                                                                        |
| Generate attach       | `FileUriPart` → `fileData.fileUri`         | `FileRefPart` → `input_file.file_id`                                        |
| Cross-provider misuse | N/A                                        | Gemini `file-uri` / foreign hosts still **reject-don’t-map** on xAI adapter |
| Ambient auth          | Forbidden                                  | Forbidden                                                                   |

---

## 5. Resolved open questions (was §8)

| #   | Question                             | Decision                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Multipart + Responses attach schema  | REST: field order `expires_after` → `purpose` → `file`. Responses: `{ type: 'input_file', file_id }`. Public doc attach via existing `file-uri` **not** expanded in v1 (images stay image-only; docs use `file-ref` after upload).                                                                                                                                                                         |
| 2   | Structured output + file attachments | Supported on same Responses request shape the adapter already uses (`text.format` + input parts). Attaching files **does** auto-enable `attachment_search` (agentic) — document billing; do **not** add explicit tools array in v1.                                                                                                                                                                        |
| 3   | ZDR error body                       | No stable public error body fixture. Classify via existing `classifyXaiError` / HTTP status; if message/body mentions zero-data-retention / ZDR / files disabled, keep `bad_request` (or `invalid_auth` only for key failures) and **include ZDR guidance in error message** when detectable. Unit-test with synthetic body.                                                                               |
| 4   | Polling                              | **None.** Upload response is ready metadata.                                                                                                                                                                                                                                                                                                                                                               |
| 5   | Team scoping                         | Document only: `file_id` is team-scoped to the key’s org; multi-tenant hosts must not share ids across keys.                                                                                                                                                                                                                                                                                               |
| 6   | Part union shape                     | **New core part** `FileRefPart` — see §6. Not `xai-file` provider-specific kind (keeps Message portable). Not overloading `file-uri` with bare ids (ids are not URIs; would corrupt Gemini/xAI image URL lane).                                                                                                                                                                                            |
| 7   | TTL out of range                     | **Validate and throw** `bad_request` (no silent clamp). Honest API; callers pass legal values.                                                                                                                                                                                                                                                                                                             |
| 8   | `purpose`                            | Default `"assistants"` (OpenAI SDK convention); overridable; xAI does not enforce.                                                                                                                                                                                                                                                                                                                         |
| 9   | Delete argument                      | Accept `string` file id **or** `{ id: string }` handle — primary path is string for consumer DB maps.                                                                                                                                                                                                                                                                                                      |
| 10  | Testing fake                         | Ship `FakeXaiFileStore` in `@gullabs/testing` only if cheap; otherwise in-package test doubles via injectable `fetch` are sufficient for CI. Prefer injectable-fetch unit tests as the gate; add testing fake if export surface wants host-level fakes without HTTP. **Decision: in-package fetch fakes for CI gate; optional thin `FakeXaiFileStore` in testing if time allows — not a release blocker.** |

---

## 6. Library surface (locked API)

### 6.1 Core — `FileRefPart`

```ts
// packages/core/src/types.ts

/** Provider-hosted file id reference (not a URI). */
export type FileRefPart = {
  kind: 'file-ref'
  /** Provider file id, e.g. xAI `file_…`. */
  fileId: string
  /** Optional IANA type hint for hosts/telemetry; adapters may ignore. */
  mimeType?: string
}

export type Part = TextPart | InlineMediaPart | FileUriPart | FileRefPart

export function isFileRefPart(part: Part): part is FileRefPart {
  return part.kind === 'file-ref'
}
```

- Export type + guard from `@gullabs/core`.
- Update `assertNever` exhaustiveness in google + xai adapters.
- **Google adapter:** `file-ref` → `bad_request` (“Google expects FileUriPart with a Files API uri; got file-ref”). No silent cross-map.
- **xAI adapter:** `file-ref` → `{ type: 'input_file', file_id: part.fileId }` after non-empty id validation.
- Existing xAI `file-uri` rules unchanged (public http(s) **images only**). Gemini / `gs://` / non-image https still reject.

### 6.2 `XaiFileStore`

```ts
// packages/xai/src/file-store.ts

export const XAI_FILE_TTL_MIN_SECONDS = 3_600
export const XAI_FILE_TTL_MAX_SECONDS = 2_592_000
export const XAI_FILE_MAX_BYTES = 48 * 1024 * 1024
export const XAI_FILES_DEFAULT_BASE_URL = 'https://api.x.ai/v1'

export interface XaiFileHandle {
  id: string
  filename?: string
  bytes?: number
  purpose?: string
  createdAt?: Date
  /** Present when the file has a TTL; omitted key when permanent / unknown. */
  expiresAt?: Date
  /** Full vendor JSON object for forward-compat (P2 raw lane). */
  raw?: { [k: string]: JsonValue }
}

export interface XaiFileUploadInput {
  data: Uint8Array | Blob
  filename: string
  mimeType?: string
  /**
   * TTL seconds. Must be in [3600, 2592000] when set.
   * Omit only for permanent storage (discouraged for long-lived host files).
   */
  expiresAfterSeconds?: number
  /** Default `"assistants"`. */
  purpose?: string
}

export interface XaiFileListOptions {
  limit?: number // 1..100
  order?: 'asc' | 'desc'
  sortBy?: 'created_at' | 'filename' | 'size'
  paginationToken?: string
}

export interface XaiFileListResult {
  files: XaiFileHandle[]
  paginationToken?: string
}

export interface XaiFileStoreOptions {
  auth: AuthMaterial
  /** Default `https://api.x.ai/v1`. */
  baseUrl?: string
  /** Injectable fetch (tests). Default global `fetch`. */
  fetch?: typeof fetch
  /**
   * Delete failures that are NOT already-gone (404).
   * Default: logger.error or console.error with redacted message.
   */
  onDeleteError?: (fileId: string, err: unknown) => void
  logger?: Logger
  /** Injectable clock for tests. */
  now?: () => number
}

export class XaiFileStore {
  constructor(opts: XaiFileStoreOptions)

  upload(input: XaiFileUploadInput, signal?: AbortSignal): Promise<XaiFileHandle>
  get(fileId: string, signal?: AbortSignal): Promise<XaiFileHandle>
  list(opts?: XaiFileListOptions, signal?: AbortSignal): Promise<XaiFileListResult>
  /**
   * Idempotent. 404 → void success.
   * Other errors → onDeleteError + void (fail-open). Never throws.
   */
  delete(
    fileIdOrHandle: string | Pick<XaiFileHandle, 'id'>,
    signal?: AbortSignal,
  ): Promise<void>
  deleteAll(
    ids: ReadonlyArray<string | Pick<XaiFileHandle, 'id'>>,
    signal?: AbortSignal,
  ): Promise<void>
  getContent(fileId: string, signal?: AbortSignal): Promise<Uint8Array>
}
```

#### Implementation rules

1. **Auth snapshot:** capture `requireApiKey(auth)` at construction (static API keys). Same ADR-020 note as Google if refreshable creds appear later.
2. **Multipart builder:** append in order: optional `expires_after` (decimal string), `purpose`, then `file` blob with filename. Never reverse.
3. **TTL validation:** non-integer / out of range → throw `LlmError('bad_request')` before network.
4. **Size validation:** for `Uint8Array` use `.byteLength`; for `Blob` use `.size` (always defined). Reject `> XAI_FILE_MAX_BYTES` with `bad_request`.
5. **Empty filename / empty fileId:** `bad_request`.
6. **Error mapping (raw fetch → classifyXaiError):** on non-2xx, parse JSON body when possible and **throw a plain object** `{ status, error: bodyOrText, message? }` so `classifyError` reads `.status` and `classifyXaiError` can still detect the structured auth-body signature via `.error`. Unit-test 401→`invalid_auth`, 429→`rate_limited`, 500→`server`.
7. **404 on get/content:** special-case to `LlmError({ kind: 'bad_request', httpStatus: 404, provider: 'xai' })` (core maps bare 404→`unknown`; pin stable kind for missing files).
8. **Delete 404:** detect via `httpStatus === 404` on classified error **or** raw status; treat as success **without** calling `onDeleteError`.
9. **No READY poll.**
10. **Timestamps:** `created_at` / `expires_at` unix seconds → `Date`; omit `expiresAt` key when null/absent (mirror Google omit-vs-undefined discipline).

### 6.3 Adapter attach

```ts
// mapPart additions
case 'file-ref': {
  if (typeof p.fileId !== 'string' || p.fileId.trim() === '') {
    throw badXaiRequest('FileRefPart.fileId must be a non-empty string.')
  }
  return { type: 'input_file', file_id: p.fileId }
}
```

Extend `XaiInputContentPart`:

```ts
export interface XaiInputFilePart {
  type: 'input_file'
  file_id?: string
  file_url?: string
}
export type XaiInputContentPart = XaiInputTextPart | XaiInputImagePart | XaiInputFilePart
```

**Reject-don’t-map** remains for:

- `file-uri` with Gemini host / `gs://` / non-http
- `file-uri` with non-image mime (unchanged)
- Google adapter: `file-ref` rejected

### 6.4 Error taxonomy

| Condition                                                          | `LlmError.kind`                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Missing/invalid `auth.apiKey`                                      | `invalid_auth`                                                                      |
| TTL out of range / empty id / oversize / bad multipart client-side | `bad_request`                                                                       |
| HTTP 400 (incl. ZDR block when detectable)                         | `bad_request` (+ ZDR hint in message when matched)                                  |
| HTTP 401/403                                                       | `invalid_auth` (a structured safety body overlays to `content_filter`; see ADR-028) |
| HTTP 404 on get/content                                            | **`bad_request`** + `httpStatus: 404` (store special-case; core bare 404→`unknown`) |
| HTTP 404 on delete                                                 | **success** (no throw)                                                              |
| HTTP 429                                                           | `rate_limited`                                                                      |
| HTTP 5xx / transport                                               | `server` (retryable per existing classifyXaiError)                                  |
| AbortSignal                                                        | `aborted`                                                                           |

### 6.5 Exports

- `@gullabs/core`: `FileRefPart`, `isFileRefPart`, `Part` union update
- `@gullabs/xai`: `XaiFileStore`, handle/input/options types, TTL/size constants
- README sections for both packages
- Changeset: **minor** for `@gullabs/core` (new part kind) and `@gullabs/xai` (store + attach); patch dependents as changesets graph requires

### 6.6 Testing requirements (CI gate)

All tests use injectable `fetch` / fake adapter client — **no network** in default CI.

| Case                                  | Assertion                                                     |
| ------------------------------------- | ------------------------------------------------------------- |
| Upload with TTL                       | multipart field order; handle.id; expiresAt from `expires_at` |
| Upload without TTL                    | no `expires_after` field; no expiresAt key                    |
| TTL below min / above max             | throws `bad_request` before fetch                             |
| Oversize body                         | throws `bad_request`                                          |
| Get / list / content                  | correct method/URL/auth header; handle mapping                |
| Delete success                        | DELETE called; resolves                                       |
| Delete 404                            | resolves; `onDeleteError` **not** called                      |
| Delete 500                            | resolves; `onDeleteError` called once                         |
| Double delete                         | both resolve                                                  |
| Auth header                           | `Bearer` from injected key only                               |
| No ambient auth                       | existing `no-ambient-auth` suite still green                  |
| Adapter file-ref                      | maps to `{ type: 'input_file', file_id }`                     |
| Adapter empty file-ref                | `bad_request`                                                 |
| Adapter still rejects Gemini file-uri | `bad_request`                                                 |
| Google adapter file-ref               | `bad_request`                                                 |
| classify/ZDR synthetic body           | message or kind stable                                        |

Optional live smoke (credentials present only): upload tiny text → generate structured with file-ref → delete twice. Never invent live results.

---

## 7. TTL defaults (library docs + hosts contract)

xAI allows **1 hour … 30 days**, or permanent if omitted.

| Parameter         | Library                           | Host production                            |
| ----------------- | --------------------------------- | ------------------------------------------ |
| Default on upload | **None** (explicit caller choice) | **86400** (24h) always passed              |
| Min / max         | Validate 3600..2592000            | Same                                       |
| Permanent         | Allowed by library                | **Disallowed** on the host production path |

### Cleanup contract (hosts; library enables)

```
prepare: upload each doc with expiresAfterSeconds=86400; persist file_id
modules: generate with FileRefPart { kind:'file-ref', fileId }
release (finally): delete each file_id (idempotent)
sweep: re-delete unreleased / past expires
```

---

## 8. Implementation steps

1. Core: add `FileRefPart` + guard + types tests; export.
2. Google adapter: exhaustiveness — reject `file-ref` with clear `bad_request`; test.
3. xAI: `file-store.ts` + `file-store.test.ts` (injectable fetch).
4. xAI client types: `XaiInputFilePart`; adapter `mapPart` + tests (incl. reject Gemini URI).
5. Exports, README, surface tests, no-ambient still green.
6. Changeset(s); `pnpm quality`.
7. Claude signoff per commit; PR → main → Release workflow → `npm view` verify.
8. Hosts (separate repo): their own corpus / lifecycle adapter consumes the store — **out of this PR**.

### File layout

```text
packages/core/src/types.ts          # FileRefPart
packages/core/src/index.ts
packages/google/src/adapter.ts      # reject file-ref
packages/xai/src/file-store.ts
packages/xai/src/file-store.test.ts
packages/xai/src/client.ts          # XaiInputFilePart
packages/xai/src/adapter.ts         # map file-ref
packages/xai/src/adapter.test.ts
packages/xai/src/index.ts
packages/xai/README.md
.changeset/<name>.md
```

---

## 9. Consumer sketch (hosts)

```ts
import { XaiFileStore } from '@gullabs/xai'

const store = new XaiFileStore({
  auth: { apiKey },
  onDeleteError: (id, err) => log.warn({ id, err }, 'xai.file.delete.failed'),
})

const handle = await store.upload({
  data: pdfBytes,
  filename: doc.filename,
  mimeType: 'application/pdf',
  expiresAfterSeconds: 86_400,
})

await client.generate(
  {
    provider: 'xai',
    model: 'grok-4.5',
    messages: [
      {
        role: 'user',
        parts: [
          { kind: 'text', text: modulePrompt },
          { kind: 'file-ref', fileId: handle.id, mimeType: 'application/pdf' },
        ],
      },
    ],
    // structured output unchanged
  },
  { auth: { apiKey } },
)

await store.delete(handle.id)
await store.delete(handle.id) // idempotent
```

**Billing note for hosts:** attaching files makes the Responses call agentic (`attachment_search`). Expect tool-invocation fees + reasoning tokens beyond a plain completion. Prefer `promptCacheKey` stability across modules when the same file set is reused.

---

## 10. Success criteria

- [ ] Upload with TTL 24h → `id` + `expiresAt`
- [ ] Unit: multipart order `expires_after` before `file`
- [ ] Adapter maps `file-ref` → `input_file.file_id`
- [ ] Adapter rejects Gemini/`gs://` file-uri
- [ ] Delete twice + 404 delete → no throw; non-404 delete → onDeleteError
- [ ] No ambient env auth in xAI store path
- [ ] `pnpm quality` green
- [ ] Claude APPROVE on plan + each implementation commit
- [ ] Published `@gullabs/xai` (and core) on npm newer than pre-goal `0.2.5` / current core
- [ ] hosts can drop hand-rolled REST and depend on the release

---

## 11. Priority relative to host resilience work

| Order                 | Work                                                        |
| --------------------- | ----------------------------------------------------------- |
| Host P0               | Per-unit results + Grok must not call Gemini release        |
| **This any-llm plan** | XaiFileStore + FileRefPart + generate attach                |
| Host P1               | Host corpus adapter only; **no production inline** for Grok |
| Later                 | Collections (shared reference library only, if ever)        |

---

## 12. Release

- Changesets: minor bumps for user-facing surface.
- Normal path: feature PR with `.changeset/*.md` → merge main → CI → Release opens Version PR **or** publishes if pre-versioned.
- Prefer **normal changeset path** unless owner wants pre-versioned.
- Verify: `npm view @gullabs/xai version` and `npm view @gullabs/core version` after Release succeeds.
- If `NPM_TOKEN` / permissions block publish, capture blocker evidence — do not fake registry success.

---

_Implement in this repository.
