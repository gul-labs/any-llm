# Plan: File-store fail-closed delete + host follow-ons

| Field                    | Value                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| **Status**               | SHIPPED — `@gullabs/xai@0.4.0` / `@gullabs/google@0.9.0` / `@gullabs/testing@0.5.0`                   |
| **Date**                 | 2026-08-12                                                                                            |
| **Origin**               | Host feedback after Files v1 publish                                                                  |
| **Packages (P0)**        | `packages/xai` (`XaiFileStore`), `packages/google` (`GoogleFileStore`)                                |
| **Packages (P1, later)** | `packages/xai` (usage/cost), `packages/testing` (fake), docs / meta-package                           |
| **Related**              | [`docs/archive/PLAN-xai-files-store.md`](./PLAN-xai-files-store.md) (B-002 shipped), DESIGN.md **P5** |
| **Consumer**             | Host applications using provider Files for multi-call document attach                                 |

P0 (`failClosed`) shipped in the versions above. §1–§2 keep the original problem statement as context. Host finally-catch vs sweep-retry patterns in §3.4 / §8 remain the documented host contract.

---

## 1. Problem statement (consumer)

A host production Grok path:

1. Upload source documents once via `XaiFileStore` (TTL 24h).
2. Attach with core `FileRefPart` → Responses `file_id`.
3. On run end / orphan sweep: `delete(file_id)`, then mark Postgres rows `released_at`.

**Bug class today:** delete is **fail-open only** (DESIGN P5 side-effect style):

- HTTP 5xx / network / timeout → `onDeleteError` + **resolve void**.
- Sweep can mark DB “released” while the file still exists at the provider.
- Empty / blank `fileId` on xAI also fail-opens via callback (unlike `get` / `getContent`, which throw `bad_request`).

Hosts need a **durable-state gate**: only mark released when delete is known-success or known-already-gone (404).

`delete(id, { failClosed })` shipped in `@gullabs/xai@0.4.0`. Upload / attach shipped earlier in `0.3.0`.

---

## 2. Validation of the ask

### 2.1 P0 — Fail-closed delete — **VALID**

| Claim                                                 | Assessment                                                                                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fail-open delete is wrong for background orphan sweep | **Correct.** Cleanup is a control-plane operation that gates durable DB state.                                                                                                         |
| P5 forbids any throwing delete                        | **Incorrect reading of P5.** P5 protects the **LLM call** from sink/telemetry/cost side effects. Explicit `delete` is not “a broken sink during generate”; it is the operation itself. |
| 404 must remain success                               | **Correct.** Idempotent cleanup (double release, sweep after release).                                                                                                                 |
| Empty `fileId` should throw                           | **Correct.** Caller fault; already the contract for get/content.                                                                                                                       |
| Need both xAI and Google stores                       | **Correct.** Same lifecycle pattern on Gemini corpus paths; avoid provider skew.                                                                                                       |

**Temporary consumer workaround:** throw inside `onDeleteError` recovers 5xx for fail-closed hosts but:

- Easy to mis-wire (must rethrow, not only log).
- Does **not** fix empty-id fail-open.
- Abort / classify path still store-specific.

Library support is the right fix.

### 2.2 P1 items — **VALID, separate tracks**

| Ask                                                                      | Valid?                                                | Blocking 0.3.0 bump?                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------- |
| Usage/cost visibility for implicit `attachment_search`                   | Yes — real billing gap when xAI returns tool counters | **No**                                  |
| `FakeXaiFileStore` in `@gullabs/testing`                                 | Yes — host ergonomics                                 | **No** (injectable `fetch` works in CI) |
| Multi-provider install docs (`any-llm` + `@gullabs/xai` + `openai` peer) | Yes — docs                                            | **No**                                  |

### 2.3 Explicit non-goals (consumer + library)

- Collections / RAG product
- Chunked upload (`:initialize` / `:uploadChunks`)
- Context-cache store for xAI
- Public file URL minting for private source documents

---

## 3. Vision

### 3.1 What “done” looks like for hosts

```ts
// A) Best-effort only (no DB gate) — default, rare for long-lived host files
await store.delete(fileId)

// B) host release in workflow finally — truthful delete, host run still succeeds
try {
  await store.delete(fileId, { failClosed: true })
  await db.markReleased(fileId)
} catch (err) {
  logger.warn({ err, fileId }, 'file.release.delete_failed')
  // released_at stays null → sweep + TTL
}

// C) host orphan sweep activity — fail closed so workflow runtime retries
await store.delete(fileId, { failClosed: true })
await db.markReleased(fileId)
```

Same options shape on **Google** and **xAI** so multi-provider corpus code does not branch on semantics.

**Prefer per-id delete + markReleased in a loop** over fail-closed `deleteAll` when writing `released_at` (partial provider deletes are possible if `deleteAll` fail-fasts mid-batch).

### 3.2 Principles

| Principle                     | Application                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **P1 Host owns world**        | Host chooses fail-open vs fail-closed per call; auth still injected.                                              |
| **P3 Thin stores**            | Stores only map HTTP → void or `LlmError`; no DB awareness.                                                       |
| **P5 Fail-open side effects** | **Default** delete remains fail-open so generate-adjacent `finally` cleanup never fails the activity by accident. |
| **Fail-closed when asked**    | Opt-in makes delete a **first-class fallible operation** — same family as upload/get.                             |
| **Idempotent gone**           | HTTP 404 (and equivalent “not found”) is **success in both modes**.                                               |
| **Greenfield**                | No shims, no deprecated aliases, no dual `deleteStrict` forever-API. One method + options.                        |
| **Parity**                    | xAI and Google share the same options contract and truth table.                                                   |

### 3.3 Mental model

```
                    ┌─────────────────────────────┐
   delete(id)       │  mode?                      │
                    └──────────┬──────────────────┘
               default         │          failClosed: true
               fail-open       │
                    │          │
         ┌──────────▼──┐   ┌───▼────────────┐
         │ 404 → ok    │   │ 404 → ok       │
         │ 2xx → ok    │   │ 2xx → ok       │
         │ else →      │   │ else → throw   │
         │  onDelete   │   │  LlmError      │
         │  Error +    │   │                │
         │  resolve    │   │                │
         └─────────────┘   └────────────────┘

   empty/blank id → always throw bad_request (both modes)
```

Delete is **not** part of `generate()`’s side-effect envelope. Hosts that treat cleanup as best-effort keep the default; hosts that treat cleanup as a state transition use `failClosed: true`.

### 3.4 Product alignment — what hosts actually need

Assumptions about host run-lifecycle (the library does not implement these):

| host rule (locked)                                  | What it means for any-llm                                                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload + `FileRefPart` + 24h TTL                    | **Already shipped** in `@gullabs/xai@0.3.0`                                                                                                                     |
| DELETE idempotent; **404 = success**                | Keep in **both** fail-open and fail-closed modes                                                                                                                |
| **Never fail the host run** because cleanup errored | Library must **not** force fail-closed as default; host `finally` must **catch** if using fail-closed                                                           |
| **`released_at` only when delete succeeded**        | Host must not treat “promise resolved” as success under fail-open; need **observable failure** → `failClosed: true` then mark DB only on resolve                |
| Orphan sweep re-DELETE unreleased rows              | Sweep activity should use **`failClosed: true`** so workflow runtime can **retry** the activity; do not tombstone on throw                                      |
| TTL safety net if delete never succeeds             | Vendor `expires_at` still deletes the file; DB stays `released_at IS NULL` until a successful DELETE or expiry hygiene — **correct custody**, not a library bug |
| Never construct Gemini on Grok path                 | Out of scope for this plan (host factory); Google parity is for Gemini corpus hosts only                                                                        |
| No Collections / public URLs / production inline    | Still non-goals                                                                                                                                                 |

**The bug is not “delete is fail-open.”**  
The bug is **“host marks `released_at` after a delete API that cannot fail.”**

```text
WRONG (today with fail-open-only delete):
  await store.delete(id)      // always resolves (except we still want 404=ok)
  await db.markReleased(id) // LIED if provider 5xx

RIGHT — release in workflow finally (host run must not fail):
  try {
    await store.delete(id, { failClosed: true })
    await db.markReleased(id)   // only on known success / 404
  } catch (err) {
    log.warn(err)               // leave released_at null; TTL + sweep recover
    // do NOT rethrow out of finally
  }

RIGHT — orphan sweep activity (may fail and retry):
  await store.delete(id, { failClosed: true })
  await db.markReleased(id)
  // throw propagates → workflow runtime retries; row stays unreleased
```

**What we ship (library):** a truthful delete outcome (`void` success vs `LlmError`).  
**What we do not ship:** DB semantics, workflow runtime policies, or “fail the host run.” Those stay host-owned (P1).

**Customer need check**

| Need                                                          | Covered by P0 plan?                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Know delete failed (5xx/network) before writing `released_at` | **Yes** — `failClosed: true`                                                              |
| 404 / double-delete still OK                                  | **Yes**                                                                                   |
| Empty `fileId` is caller fault, not silent success            | **Yes** — always throw                                                                    |
| Release path must not kill the host run                       | **Yes** — default stays fail-open; docs prescribe catch-in-finally when using fail-closed |
| Sweep can retry failed deletes                                | **Yes** — fail-closed + activity retry                                                    |
| Gemini corpus same contract                                   | **Yes** — Google store parity                                                             |
| attachment_search $ in ledger                                 | **No** — P1 (billing), not custody                                                        |
| Fake store / install docs                                     | **No** — P1 ergonomics                                                                    |

**Vision alignment (any-llm)**

| Principle                              | Alignment                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| P1 host owns world                     | Host chooses mode per call site; owns DB + workflow runtime                                                                              |
| P3 thin stores                         | HTTP → void / `LlmError` only                                                                                                            |
| P5 fail-open side effects              | Default delete remains fail-open (cleanup-as-side-effect). Opt-in fail-closed is **the call** when the host says so — same as upload/get |
| Greenfield                             | One options bag; no `deleteStrict` dual API; bare-`signal` 2nd arg break OK                                                              |
| Vendor primitives, not product storage | We do not implement a host file-lifecycle port / `released_at` column                                                                    |

**Do not ship as P0:** flipping default to fail-closed (would push throws into every `finally` and fight hosts' “never fail the host run” unless every host catches). Opt-in is the product-correct default.

---

## 4. Options considered (P0 API shape)

### Option A — Per-call `failClosed?: boolean` on `delete` / `deleteAll` (**RECOMMENDED**)

```ts
export type FileDeleteOptions = {
  signal?: AbortSignal
  /**
   * When true, non-404 failures throw typed `LlmError`.
   * When false/omitted (default), non-404 failures invoke `onDeleteError` and resolve.
   */
  failClosed?: boolean
}

// XaiFileStore
delete(
  fileIdOrHandle: string | Pick<XaiFileHandle, 'id'>,
  opts?: FileDeleteOptions,
): Promise<void>

// GoogleFileStore — preserve handle-first arg
delete(handle: GoogleFileHandle, opts?: FileDeleteOptions): Promise<void>
```

| Pros                                                             | Cons                                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Single method; no dual API surface                               | Slightly richer signature (signal moves into opts on xAI — see §5.2)                            |
| Per-call choice (sweep vs best-effort finally)                   | Call sites that passed bare `signal` as 2nd arg need a one-line update if we collapse overloads |
| Mirrors fetch-style options objects already used in the monorepo | —                                                                                               |
| Easy to document with a truth table                              | —                                                                                               |

### Option B — Separate `deleteStrict` / `deleteFailClosed` method

```ts
delete(id): Promise<void>           // fail-open
deleteStrict(id): Promise<void>     // fail-closed
```

| Pros                    | Cons                                                                |
| ----------------------- | ------------------------------------------------------------------- |
| Very discoverable names | Two entry points drift (tests, docs, `deleteAll` variants)          |
| No options object       | Violates “one contract” greenfield preference; permanent API weight |

**Reject** unless product insists on method-level discoverability over a single surface.

### Option C — Construction-time `defaultFailClosed: true` on the store

```ts
new XaiFileStore({ auth, failClosed: true })
```

| Pros                          | Cons                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| Zero per-call noise for hosts | Wrong granularity: same store instance often used for both best-effort finally and strict sweep |
| —                             | Forces two store instances or surprising global behavior                                        |

**Reject as sole mechanism.** Optional **construction default** that per-call `failClosed` overrides is a possible **v1.1** nicety — **not** required for P0.

### Option D — Status-returning delete (no throw)

```ts
delete(id): Promise<'deleted' | 'already_gone' | 'failed'>
```

| Pros                      | Cons                                                               |
| ------------------------- | ------------------------------------------------------------------ |
| No exception control flow | Breaks current `Promise<void>` contract for all callers            |
| —                         | Errors lose `LlmError` taxonomy unless paired with a result object |
| —                         | Larger break than opt-in throw                                     |

**Reject** for this library (exceptions + `LlmError` are the established fail-closed pattern).

### Option E — Document-only: “throw from `onDeleteError`”

| Pros         | Cons                                                                |
| ------------ | ------------------------------------------------------------------- |
| Ship nothing | Empty id still wrong; abort semantics muddy; easy to forget rethrow |
| —            | Does not meet consumer “agreed story” bar                           |

**Reject** as the product answer (may remain a one-release bridge in host apps).

### Option F — Flip default to fail-closed

| Pros                                       | Cons                                                         |
| ------------------------------------------ | ------------------------------------------------------------ |
| Matches “cleanup should be real” intuition | Breaks existing fail-open `finally` callers without notice   |
| —                                          | Contradicts P5 default posture for side-effect-style cleanup |

**Reject.** Opt-in only.

---

## 5. Locked design (P0) — after option selection

**Selected: Option A** — per-call `FileDeleteOptions.failClosed` on both stores.

### 5.1 Shared truth table

| Condition                                    | `failClosed: false` (default)                                                                                | `failClosed: true`                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| HTTP 2xx (or SDK success)                    | resolve                                                                                                      | resolve                                              |
| HTTP 404 / not-found                         | resolve (idempotent)                                                                                         | resolve (idempotent)                                 |
| HTTP 5xx / 429 / network / timeout           | `onDeleteError` + resolve                                                                                    | **throw** `LlmError` (`server` / `rate_limited` / …) |
| AbortSignal aborted mid-delete               | today: fail-open callback → **under fail-closed: throw `aborted`**; under fail-open: keep callback + resolve | throw `aborted`                                      |
| Empty / blank id (or missing handle id)      | **throw `bad_request`** (behavior change — see §5.3)                                                         | throw `bad_request`                                  |
| `onDeleteError` throws (host rethrow bridge) | propagates (unchanged)                                                                                       | N/A if we throw before callback                      |

When `failClosed: true` and the operation throws, **`onDeleteError` is not called** (error is the return path; double-reporting is noise). When fail-open, callback behavior is unchanged.

### 5.2 Signature details

**xAI today:**

```ts
delete(fileIdOrHandle, signal?: AbortSignal): Promise<void>
```

**xAI after (recommended):**

```ts
delete(
  fileIdOrHandle: string | Pick<XaiFileHandle, 'id'>,
  opts?: FileDeleteOptions, // { signal?: AbortSignal; failClosed?: boolean }
): Promise<void>
```

**Breaking note (greenfield OK):** second-parameter `AbortSignal` becomes `opts.signal`. Call sites that pass a bare signal update to `{ signal }`. No overload shim (P0 engineering rule: no legacy compatibility).

**Google today:**

```ts
delete(handle: GoogleFileHandle): Promise<void>
```

**Google after:**

```ts
delete(handle: GoogleFileHandle, opts?: FileDeleteOptions): Promise<void>
```

Google gains optional `signal` passthrough if the underlying client supports abort later; for P0, `signal` may be accepted and ignored on Google if the SDK client has no abort hook — document honestly. Prefer wiring abort if the injectable client can take it without inventing SDK APIs.

#### 5.2.1 xAI control-flow restructure (Claude nit — required in impl)

Today’s `XaiFileStore.delete` short-circuits **abort inside the inner fetch `catch`**: it calls `onDeleteError` and `return`s, never reaching an outer path that could honor `failClosed`.

**Required shape after this plan:**

```
validate id (empty → throw bad_request always)
try:
  fetch DELETE
  if 404 → return
  if !ok → throwHttpFailure → classify
catch err:
  if not-found → return
  if failClosed → throw classified LlmError   // includes aborted
  else → onDeleteError(id, classified); return
```

Abort must be classified as `aborted` and go through the **same** failClosed branch — no early fail-open return that ignores the flag.

### 5.3 Empty id — intentional small break

| Before (xAI 0.3.0)                         | After                                |
| ------------------------------------------ | ------------------------------------ |
| `delete('  ')` → `onDeleteError` + resolve | `delete('  ')` → throw `bad_request` |

Rationale: invalid input is never a successful cleanup. Aligns with `get` / `getContent`. Google: empty `handle.name` should throw the same way (if not already).

### 5.4 `deleteAll`

```ts
deleteAll(ids, opts?: FileDeleteOptions): Promise<void>
```

| Mode                | Semantics                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fail-open (default) | `Promise.allSettled` per id — each failure → `onDeleteError`; never throws                                                                                        |
| fail-closed         | **Fail-fast:** `Promise.all` over per-id `delete(..., { failClosed: true })` — first throw rejects the aggregate; **in-flight sibling DELETEs are not cancelled** |

**README must state (Claude nit):** a thrown fail-closed `deleteAll` does **not** mean zero partial deletes occurred at the provider. Hosts gating DB release should prefer **per-id** `delete` + mark released, not assume all-or-nothing from `deleteAll`.

**Rejected for P0:** custom `AggregateLlmError` for multi-delete (YAGNI until a consumer asks).

### 5.5 Error taxonomy (fail-closed throws)

Reuse existing store classification (`classifyXaiError` / Google `classifyError`):

| Situation       | `LlmError.kind`                                                     |
| --------------- | ------------------------------------------------------------------- |
| empty id        | `bad_request`                                                       |
| 401/403         | `invalid_auth` (structured safety body → `content_filter`; ADR-028) |
| 429             | `rate_limited`                                                      |
| 5xx / transport | `server` (retryable per existing rules)                             |
| abort           | `aborted`                                                           |
| 404             | **no throw**                                                        |

### 5.6 Types placement (**LOCKED**)

**Package-local identical types** in `packages/xai` and `packages/google` (each exports its own `FileDeleteOptions`).

- No `@gullabs/core` type for P0 (core stays free of vendor-store vocabulary; no `FileStore` port).
- Shapes must stay byte-for-byte aligned by convention + tests/docs; drift is a review blocker.

### 5.7 Docs / versioning

- README sections for both stores: truth table + **§3.4 host patterns** (finally catch vs sweep retry). Explicitly: _failClosed does not mean “fail the host run” — the host decides propagation._
- Changesets: **minor** `@gullabs/xai`, **minor** `@gullabs/google` (new option + empty-id throw is a small behavior change on invalid input).
- Backlog **B-005** tracks this work.
- Amend `PLAN-xai-files-store.md` with a pointer to this plan (no rewrite of shipped history).
- Optional one-liner for hosts: `0.3.0` is enough for upload/attach; adopt `0.4.0+` for an honest `released_at`; catch in `finally` rather than treating library fail-open as success.

### 5.8 Tests (must drive shipped code)

**xAI + Google each:**

1. Default: 500 → resolves; `onDeleteError` called.
2. `failClosed: true`: 500 → throws `LlmError` with expected kind; `onDeleteError` **not** called.
3. Both modes: 404 → resolves; `onDeleteError` not called.
4. Empty id → throws `bad_request` (both modes).
5. `failClosed: true` + abort → `aborted` (xAI).
6. `deleteAll` fail-open settles all; fail-closed fails fast on first error.
7. Double-delete still succeeds.

No network in CI; injectable fetch/client only.

---

## 6. P1 vision (not in P0 PR)

### 6.1 Attachment_search usage / cost visibility

**Problem:** Attaching files auto-enables xAI `attachment_search`. Tool invocations and extra reasoning tokens may appear in usage; `computeXaiCost` today is token-lane only.

**Vision (later plan):**

- Map numeric tool-related usage fields into `Usage.details` (already partially open).
- Optional future Cost lane for per-invocation tool fees when pricing tables are stable.
- Do **not** fake storage $/day into generate cost (still true).

**Status:** backlog plan TBD; does not block fail-closed delete.

### 6.2 `FakeXaiFileStore` in `@gullabs/testing`

**Vision:** In-memory map `id → { bytes, expiresAt, filename }`; idempotent delete; optional expiry clock for unit tests. Structural (no `@gullabs/xai` import) **or** thin dependency — match `FakeXai` / `makeFakeGemini` conventions.

**Status:** optional; injectable fetch remains the package-local test gate.

### 6.3 Multi-provider install docs

**Vision:** Root README + `@gullabs/xai` README:

```bash
pnpm add @gullabs/any-llm @gullabs/xai openai
# peer: openai ^6 for Responses client
```

Compose example: `composeProviders([xaiProvider(), googleProvider()])` + separate `XaiFileStore` / `GoogleFileStore` construction with host auth.

**Status:** docs PR; can ship with P0 or immediately after.

---

## 7. Implementation steps (P0 only)

1. Add `FileDeleteOptions` + implement fail-closed path in `packages/xai/src/file-store.ts`.
2. Mirror in `packages/google/src/file-store.ts` (404 detection may differ — SDK errors vs HTTP status; pin tests).
3. Empty-id / empty-name validation throws in both.
4. Unit tests (§5.8).
5. README truth tables + consumer snippet.
6. Changesets (minor xai + google).
7. `pnpm quality`; Claude signoff per commit; PR → main → Release.
8. Notify hosts: bump to published minors; wire §3.4 patterns (failClosed + catch in finally; failClosed on sweep); revise host delete wording to match.

---

## 8. Consumer migration (hosts)

Align host file-lifecycle release / sweep with §3.4 — **do not** mark `released_at` after fail-open delete.

```ts
// release inside workflow finally — host run must still succeed
for (const id of fileIds) {
  try {
    await store.delete(id, { failClosed: true })
    await db.markReleased(id)
  } catch (err) {
    logger.warn({ err, id }, 'file.release.delete_failed')
    // leave released_at null; TTL + sweep
  }
}

// orphan sweep activity — let workflow runtime retry on throw
for (const id of unreleasedIds) {
  await store.delete(id, { failClosed: true })
  await db.markReleased(id)
}
```

Update host docs from “delete errors: log + fail-open library” to “delete with `failClosed: true`; catch in finally so the host run never fails; only mark `released_at` on success.”

**Shipped:** `@gullabs/xai@0.4.0` / matching Google store — no `onDeleteError` rethrow bridge.

---

## 9. Success criteria

### P0

- [x] `failClosed: true` throws on 5xx/network; default does not
- [x] 404 success both modes
- [x] Empty id throws `bad_request` always
- [x] Google parity
- [x] README documents §3.4 (finally catch vs sweep retry); warns against `markReleased` after fail-open delete
- [x] Tests + changeset
- [x] Product check: host can implement “never fail host run” **and** “never lie about `released_at`” without `onDeleteError` rethrow hack
- [x] Claude plan APPROVE before implementation; Claude commit signoff on landing commits
- [x] Published versions on npm newer than pre-change

### P1 (tracked, not this PR’s gate)

- [ ] Tool usage/cost plan written
- [x] Fake store (optional)
- [x] Multi-provider install docs

---

## 10. Risks

| Risk                                            | Mitigation                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| Bare `signal` 2nd-arg break on xAI              | Greenfield; one-line fix; call out in CHANGELOG                      |
| Google 404 shape ≠ HTTP status                  | Test with SDK-like errors; treat classified not-found as success     |
| Hosts set failClosed on every finally and flake | Docs: default fail-open for finally; fail-closed only when gating DB |
| Scope creep into tool costing                   | Hard fence: P0 PR is delete semantics only                           |

---

## 11. Decision log

| #   | Decision                                       | Choice                                                          |
| --- | ---------------------------------------------- | --------------------------------------------------------------- |
| D1  | Is fail-closed delete a valid library feature? | **Yes**                                                         |
| D2  | API shape                                      | **Option A** — `opts.failClosed`                                |
| D3  | Default mode                                   | **Fail-open** (unchanged)                                       |
| D4  | 404                                            | **Success both modes**                                          |
| D5  | Empty id                                       | **Always throw** (small break)                                  |
| D6  | `deleteStrict` method                          | **No**                                                          |
| D7  | Construction-time only flag                    | **No** (optional later default)                                 |
| D8  | Google included in P0?                         | **Yes**                                                         |
| D9  | P1 tool cost / fake / docs in same PR?         | **No** — separate                                               |
| D10 | Core `FileStore` port?                         | **No** for P0                                                   |
| D11 | `FileDeleteOptions` placement                  | **Package-local** (xai + google)                                |
| D12 | xAI abort + failClosed                         | **Single catch path** (§5.2.1)                                  |
| D13 | fail-closed `deleteAll` partial deletes        | **Document** — not all-or-nothing                               |
| D14 | Product goal                                   | **Truthful delete outcome**, not “fail host runs”               |
| D15 | host finally vs sweep                          | **Same `failClosed` API**; host catch vs workflow runtime retry |
| D16 | Default remains fail-open                      | **Yes** — “never fail the host run” without mandatory try/catch |

---

## 12. Signoff

| Gate               | Result                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Claude plan review | **APPROVE_WITH_NITS** — session `8dcad035` (`file-delete-plan-signoff`), 2026-08-12            |
| locked_decisions   | `option_a_failClosed=pass`, `p5_interpretation=pass`, `google_parity=pass`, `p0_p1_split=pass` |
| Nits absorbed      | §5.2.1 abort restructure; §5.4 partial-delete README; §5.6 package-local types                 |
| Artifact           | `claude-plan-fail-closed-signoff.txt`                                                          |
| Implementation     | Per-commit Claude signoff; `pnpm quality` — start only while status stays LOCKED               |

---

_Implement in this repository.
