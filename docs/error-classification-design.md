# Error Classification and Propagation Design

**Status:** Accepted (Codex APPROVE, task-msspdo9c-lplc0s, 2026-08-14). Implementation follows this document. ADR-028 records the decision.

**Trigger:** [#65](https://github.com/gul-labs/any-llm/issues/65) — xAI safety-check HTTP 403 (`SAFETY_CHECK_TYPE_*`) is classified as `invalid_auth`. That is a symptom. The defect is the HTTP-status-only default in core plus an incomplete xAI overlay, plus docs that teach 403 = auth.

**P0:** No legacy compatibility. Prefer the clean current contract even when it is breaking. This change is a correctness repair of an existing kind (`content_filter`), not a compatibility shim and not a new kind.

---

## 1. Understanding

- **What:** Make provider safety/moderation refusals surface as `LlmError.kind === 'content_filter'` whenever we have a recorded structured signature, and stop documenting HTTP 403 as definitionally `invalid_auth`.
- **Why:** Hosts route on `kind` (ledger `status`/`errorKind`, Sentry, Temporal `nonRetryableErrorTypes`). A safety 403 ledgered as auth is the wrong operational path.
- **Who:** Callers of `generate()` / `runStructured()` that catch `LlmError` or persist `LlmCallRecord`. Secondary: readers of the packaged skill and READMEs.
- **Constraints:** Closed `LlmErrorKind` union (ADR-003). Never scan free-form `Error.message` for provider-body signatures. Structured parsed bodies only. Do not invent unrecorded provider shapes. Do not make non-idempotent store mutations retryable (ADR-024).
- **Non-goals:** New `LlmErrorKind` members. New record `status` values. Persisting `issues` on the ledger. Changing retry policy. Streaming. Host-side Temporal / Sentry mappings. CLI heuristic rewrite. xAI `countTokens` (the adapter does not implement it).

## 2. Assumptions (labeled)

- **Issue-supplied, not an in-repo live capture:** #65 reports the 2026-08-14 xAI 403 body as `Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER`, hoisted by the openai SDK onto `err.error` as a **plain string**, `err.status = 403`, `err.code` undefined. Fixture 15 records that report. Other `SAFETY_CHECK_TYPE_*` suffixes are assumed to share that prefix.
- **Issue-supplied, not repo-verified:** a consumer (cited in #65) maps `invalid_auth` vs `content_filter` onto distinct Temporal non-retryable types.
- A bare 403 with no safety-check structured body remains a genuine permission/auth problem (key lacks model access, team blocked, etc.).
- Gemini safety blocks already arrive as HTTP 200 + `promptFeedback.blockReason` / empty candidates, not as HTTP 403. Google's 403 default stays `invalid_auth` unless a live Google 403 safety body is later recorded.
- xAI Files endpoints have no recorded `SAFETY_CHECK_TYPE_*` body. Generic Files 403 stays `invalid_auth`. If a Files 403 ever carries the same structured prefix, `classifyStoreError` → `classifyXaiError` will pick it up automatically.
- `content_filter` already exists and is the cross-provider kind. No new kind.

## 3. Observed gaps (current `main`, Codex-verified)

| #   | Gap                                                                         | Where                                                                                      | Status after review                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | `classifyHttpStatus(403)` → `invalid_auth` unconditionally                  | `packages/core/src/errors.ts` `classifyHttpStatus`                                         | **Confirmed.** Default stays; docs must stop calling it definitional.                                                                                                                                                                                                         |
| G2  | `classifyXaiError` has no 403 safety overlay                                | `packages/xai/src/adapter.ts` `classifyXaiError`                                           | **Confirmed. In scope.**                                                                                                                                                                                                                                                      |
| G3  | Unknown xAI `status`/`incomplete_details` → `finishReason: 'other'` success | `mapFinishReason`                                                                          | **Hypothetical only.** No recorded 200 safety fixture. Existing tests already cover `max_output_tokens` → `length` and unrecognized → `other`. **Out of scope.** Do not add work.                                                                                             |
| G4  | Google file/cache stores need the same overlays as `generate()`             | `file-store.ts` upload + polling-get; `cache-store.ts` create                              | **In scope: stores classify through `classifyGoogleError` (section 6.6).** ADR-024 still holds: a malformed upload/create response and a polling timeout stay `server`, `retryable: false`, because the resource may exist and a retry would orphan or duplicate it.          |
| G5  | Docs encode 403 = auth; `content_filter` described as output-only           | SPEC, architecture, skill, Google README, `LlmErrorKind` / `LlmCallRecord.status` comments | **Confirmed. In scope.** Google README is in the set unconditionally.                                                                                                                                                                                                         |
| G6  | Fixture 09 has no 403 cases                                                 | `09-error-taxonomy.json`                                                                   | **Confirmed. In scope** — add the recorded string-body 403 only.                                                                                                                                                                                                              |
| G7  | CLI classification                                                          | `claude-cli`, `codex-cli`                                                                  | **Partially refuted.** Claude is stderr heuristics. Codex parses JSON `{error, status}` and calls `classifyHttpStatus` before text fallback — it _can_ see HTTP 403. No recorded implicated 403 fixture. **Out of scope.** Do not claim "CLI adapters do not speak HTTP 403." |

Additional review findings that constrain the design (not new product gaps to "fix" in this PR):

- **`classifyXaiError` passthrough:** an already-constructed `LlmError` is returned unchanged, including one with no `provider`. Do not silently change that in this PR. Overlay only raw (non-`LlmError`) throws.
- **`classifyGoogleError` rebuild is lossy:** it copies kind/retryable/http/retryAfter/provider/cause and optional extra `servedServiceTier`; it drops `issues`, `callId`, `attemptId`, and an existing `servedServiceTier` when no extra is passed. Another reason not to route more surfaces through it here.
- **xAI has no `countTokens`.** Only Google implements `ProviderAdapter.countTokens`. Core rejects adapters that omit it. `classifyXaiError`'s JSDoc currently claims a transport overlay "this adapter's `countTokens` path already uses" (`adapter.ts` ~405). That sentence is false and must be deleted in this PR (see 6.10).
- **Propagation differs by surface:** `generate`/`runStructured` get sink + telemetry + retry middleware. `countTokens` logs only (no sink, no telemetry). Stores are not in the engine pipeline.

## 4. Design rule (the missing invariant)

**HTTP status is a hint, not a kind.**

`classifyHttpStatus` maps status → a _default_ kind when no provider overlay has spoken. Provider overlays exist because providers overload status codes:

- xAI invalid API key = HTTP **400** + structured body prefix `Incorrect API key provided` → `invalid_auth` (already shipped; runtime matches **prefix only** — the SDK may drop `code`. Docs currently claim `code` + prefix; fix that drift).
- xAI content policy = HTTP **403** + structured body prefix `Content violates usage guidelines` → `content_filter` (this change).
- Gemini safety = HTTP **200** + `promptFeedback.blockReason` → `content_filter` (not an HTTP overlay). A candidate-less 200 without a block reason is a retryable `server` error with metered usage recorded when reported.

Core stays provider-agnostic. It does **not** grow xAI string prefixes. It **must** stop documenting 403 as definitionally auth.

`content_filter` means: the provider refused the call for safety / acceptable-use / moderation reasons. That includes **input** blocks (this 403) and **output** blocks (Gemini `promptFeedback`). Update comments that say "refused output".

## 5. Approaches considered

### A. Issue-local xAI special case only, docs unchanged

Add `isXaiSafetyCheckBody`. Leave core/docs saying 403 = auth.

Rejected as the _only_ change: the overlay is required, but leaving the documented contract wrong recreates the bug for the next overloaded 403.

### B. Split 401 vs 403 in core (403 → `unknown` or new `forbidden`)

Rejected. `unknown` is Temporal-fatal for a common permission status. A new kind is an unnecessary union break; `content_filter` / `invalid_auth` already cover the two 403 meanings we have evidence for.

### C. Recommended — keep 403 default as `invalid_auth`; overlay recorded xAI safety body; fix the documented contract; do not rewrite store classifiers

HTTP 403 without a recognized structured body stays `invalid_auth`. The recorded safety prefix reclassifies to `content_filter`. Docs and comments state the default-vs-overlay rule. Google stores classify through `classifyGoogleError` (6.6); the CLI adapters keep their own contracts.

## 6. Final design

### 6.1 Core (`@gullabs/core`) — comments only, no runtime kind-table change

`classifyHttpStatus` keeps:

| Status   | Default kind   | Retryable |
| -------- | -------------- | --------- |
| 401      | `invalid_auth` | no        |
| 403      | `invalid_auth` | no        |
| 408      | `timeout`      | yes       |
| 429      | `rate_limited` | yes       |
| 400, 422 | `bad_request`  | no        |
| 5xx      | `server`       | yes       |
| other    | `unknown`      | no        |

Rewrite comments on `LlmErrorKind`, `classifyHttpStatus`, and `LlmCallRecord.status` so:

- 403 is **the default when the adapter has not reclassified**.
- 403 is overloaded (permission vs content policy).
- Adapters MUST overlay when a **structured body** (never `Error.message`) proves a different kind.
- `content_filter` is the uniform kind for provider safety/moderation refusals on **input or output**.

No new `LlmError` fields. No new kinds. `errorKindToStatus('content_filter')` already maps to record `status: 'content_filter'`.

**Core changeset:** none, unless a published `packages/core` artifact actually changes. Repo policy: docs-only / comment-only PRs do not need a core changeset (`CONTRIBUTING.md`). SPEC / architecture / ADR live at the repo root and ride with the xAI/any-llm changesets.

### 6.2 Propagation (generate / runStructured only — already correct)

Do not change engine / retry / record code.

1. Adapter catch → `classifyXaiError` → `LlmError` (new overlays are tagged `provider: 'xai'`).
2. Engine `runAttempt` catch → `classifyError` (passthrough if already `LlmError`) → sink error record from `err.kind` → `attachCallContext` → rethrow.
3. Call-level epilogue → `classifyError` again → `telemetry.onError` + `llm.call.error`.
4. Default retry middleware treats `retryable: false` as terminal. `content_filter` is not retryable.
5. Pre-attempt refusals write `attemptNumber: 0` (ADR-025). Side-effect sink failures stay fail-open (ADR-002).

`countTokens` (Google only): adapter overlay survives engine passthrough; engine attaches `callId`; **no sink record, no telemetry** — log only. Out of this issue's live path.

Stores: not in the engine pipeline. xAI Files already classify via `classifyXaiError` (see 6.4). Google stores classify through `classifyGoogleError` (see 6.6).

### 6.3 xAI `run()` — third overlay in `classifyXaiError`

xAI implements `run()` only. There is no xAI `countTokens`.

Detection order after `if (rawErr instanceof LlmError) return rawErr` and `const base = classifyError(rawErr)`:

1. `base.httpStatus === 400` && structured body starts with `Incorrect API key provided` → `invalid_auth` (existing).
2. `base.httpStatus === 403` && structured body starts with `Content violates usage guidelines` → `content_filter`, `retryable: false`, keep `httpStatus: 403`, `provider: 'xai'`, `cause: base.cause ?? rawErr`. Copy `retryAfterMs` if present (should not be, on a 403).
3. `base.kind === 'unknown'` && transport signature → `server` / retryable (existing).
4. Else rebuild with `provider: 'xai'` (existing).

**Passthrough stays unchanged:** a pre-built `LlmError` is returned as-is, even if untagged. Do not start forcing `provider` onto injected errors in this PR.

Body extraction stays `extractXaiErrorBodyText` (parsed `.error` string, or `.error.error` / `.error.message` on an object — never `Error.message`). The **positive** path is proven only for the recorded string hoist. Object-body extraction remains in the helper because the 400 auth overlay already uses it; do not add _positive safety_ tests for object bodies until one is captured.

Negative cases that must stay `invalid_auth`:

- `{ status: 403 }` with no body.
- `{ status: 403, error: 'Permission denied' }` or any 403 whose structured text does not start with the prefix.
- Existing file-store generic 403 (`textResponse('nope', 403)`).
- `{ status: 403, message: 'Content violates usage guidelines…' }` where that text lives only on free-form `Error.message` / a `message` own-property that is **not** the structured `.error` body (anti-echo).

Positive case (recorded only):

- openai SDK shape: `{ status: 403, error: "Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER" }`.
- Match the prefix, not a specific `SAFETY_CHECK_TYPE_*` suffix.

Lossless overlay for this new branch: construct `LlmError` with message + kind + retryable + httpStatus + provider + cause, and forward `retryAfterMs` if `base` had it. The raw SDK throw will not carry `issues` / `callId` / `attemptId`; those are attached later by the engine. Do not drop fields `base` actually has.

### 6.4 xAI Files store

`classifyStoreError` already calls `classifyXaiError`. No Files-specific code change. Existing generic-403 test stays `invalid_auth`. Do not add a Files safety-403 test without a Files capture.

### 6.5 Google generate / countTokens

Unchanged. Safety is a 200-path throw. Bare 403 stays `invalid_auth`. Existing `{ status: 403 } → invalid_auth` tests remain correct.

### 6.6 Google file-store and cache-store

`GoogleFileStore` and `GoogleCacheStore` classify every SDK failure through `classifyGoogleError`, the function
`generate()` uses, so the structured overlays (`invalid_auth` for a bad key, `daily_quota`, `cache_not_found`,
`RetryInfo`) apply to stores too and the errors carry `provider: 'google'`. What each surface does:

| Surface                                             | What classifies                                                                                                                      | Retryable                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `GoogleFileStore.upload`, building the client       | **Unclassified.** `getClient()` runs outside the `try`, so a construction failure propagates raw.                                    | n/a                                                                                           |
| `GoogleFileStore.upload`, SDK `upload(...)`         | `classifyGoogleError`                                                                                                                | As classified (a transport failure is a retryable `server`; a per-day quota is not).          |
| `GoogleFileStore.upload`, a response with no name   | `server`                                                                                                                             | No: the file may exist and there is no handle to clean up (ADR-024).                          |
| `GoogleFileStore.upload`, polling `get`             | `classifyGoogleError`                                                                                                                | As classified.                                                                                |
| `GoogleFileStore.upload`, a file that ends `FAILED` | The provider's `File.error`: `DEADLINE_EXCEEDED`, `INTERNAL` or `UNAVAILABLE` is `server`; any other code, or none, is `bad_request` | Only the transient codes: a new upload can succeed.                                           |
| `GoogleFileStore.upload`, polling timeout           | `server` (not `timeout`, which ADR-036 makes retryable)                                                                              | No: the upload succeeded, and a retry would upload the bytes again and orphan the first file. |
| `GoogleFileStore.delete`                            | Not-found is success; any other failure is `classifyGoogleError`, passed to `onDeleteError` (default) or thrown (`failClosed`)       | n/a                                                                                           |
| `GoogleCacheStore.create`, preflight                | Its own `bad_request` when the counted tokens are below the minimum                                                                  | No                                                                                            |
| `GoogleCacheStore.create`, building the client      | **Unclassified.** `getClient()` runs outside the `try`.                                                                              | n/a                                                                                           |
| `GoogleCacheStore.create`, SDK `create(...)`        | `classifyGoogleError`                                                                                                                | As classified.                                                                                |
| `GoogleCacheStore.create`, a response with no name  | `server`                                                                                                                             | No: the cache may exist (ADR-024).                                                            |
| `GoogleCacheStore.delete`                           | The raw error goes to `onDeleteError`; the method never throws                                                                       | n/a                                                                                           |
| `getOrCreate` factory                               | The host's factory may throw anything; it propagates as thrown                                                                       | n/a                                                                                           |

### 6.7 CLI adapters — **out of scope**

Leave Claude stderr heuristics and Codex `classifyHttpStatus` JSON path unchanged. If a live Codex 403 safety body is later captured, overlay there in a separate change. Do not document "CLI adapters do not speak HTTP 403."

### 6.8 Fixtures and tests

Add a dedicated live-capture fixture, e.g. `packages/xai/src/__fixtures__/15-safety-check-403.json` (keep 09 as the 400/422 taxonomy; do not invent extra keys on 09):

```json
{
  "safety_check_cyber": {
    "status": 403,
    "error": "Content violates usage guidelines. Failed check: SAFETY_CHECK_TYPE_CYBER",
    "xRequestId": "cc8fa455-cfde-9a5e-a4c3-58f5afca4f14",
    "captured": "2026-08-14",
    "model": "grok-4.5",
    "note": "openai PermissionDeniedError: err.status=403, err.code=undefined, err.error=plain string. Prompt was the 17-char phrase recorded in issue #65."
  }
}
```

Tests (and only these positives):

- Fixture-backed: `{ status, error: <string> }` → `kind: 'content_filter'`, `retryable: false`, `httpStatus: 403`, `provider: 'xai'`.
- Bare 403 / non-prefix 403 → `invalid_auth`.
- Free-form message containing the prefix, no structured `.error` → `invalid_auth`.
- Adapter `run()` e2e: fake client throws that shape → same classification.
- Engine e2e (xai adapter + `RecordingSink`): record `status === 'content_filter'`, `errorKind === 'content_filter'`.
- Existing file-store generic 403 remains `invalid_auth`.
- Existing `max_output_tokens` / unrecognized-incomplete tests stay; do not add duplicates.

Do **not** add object-body `.error.error` / `.error.message` _positive_ safety tests without a capture.

### 6.9 Semver and packages

| Package            | Bump      | Why                                                                                                                                                                                                                                                |
| ------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@gullabs/xai`     | **patch** | Repairs classification to the existing `content_filter` contract. Precedent: transport `unknown` → `server` shipped as xAI `0.2.4` / Google `0.8.2` patches. No new public type.                                                                   |
| `@gullabs/any-llm` | **patch** | Packaged skill documentation (`skills/any-llm/SKILL.md`). This package does **not** re-export `@gullabs/xai`.                                                                                                                                      |
| `@gullabs/google`  | **none**  | No code change. README 403 wording updates are docs-only; if we touch the published README, a google patch is acceptable but not required. Prefer editing README in the same PR without a google version bump if the file is considered docs-only. |
| `@gullabs/core`    | **none**  | Comment/SPEC/architecture/ADR only. No published runtime change.                                                                                                                                                                                   |
| `@gullabs/testing` | **none**  | Construct the throw in xai tests.                                                                                                                                                                                                                  |

One changeset: `xai` + `any-llm` patch.

### 6.10 Docs to update (same PR)

- `SPEC.md` error line: 401 → `invalid_auth`; 403 → `invalid_auth` **unless a provider overlay reclassifies**; safety → `content_filter` (HTTP or 200-path).
- `docs/architecture.md` kind table + classification section.
- `packages/any-llm/skills/any-llm/SKILL.md` error table (403 is a default, not a definition; `content_filter` covers input and output refusals).
- `packages/xai/README.md`: add the 403 safety overlay next to the 400 auth overlay; correct the stale "code + prefix" claim to "structured-body prefix only (SDK may drop `code`)".
- `packages/xai/src/adapter.ts` JSDoc on `classifyXaiError` / `isXaiAuthFailureBody`: same `code` drift fix; **delete** the sentence that cites "this adapter's `countTokens` path" (there is no such path). Rephrase the transport overlay as standing on its own (provider-side failure with no HTTP status).
- `packages/google/README.md`: stop saying `401/403`→`invalid_auth` as if definitional; say 401/bare 403 default to auth, Gemini safety is the 200-path `content_filter`.
- `packages/core/src/errors.ts` and `packages/core/src/record.ts` comments: `content_filter` is input or output safety refusal.
- `DECISIONS.md` ADR-028 recording this rule.
- Historical plan docs that still say "HTTP 401/403 → `invalid_auth`" as a hard Files rule (`docs/archive/PLAN-xai-files-store.md`, `docs/archive/PLAN-file-store-fail-closed-delete.md`): one-line clarification that a structured safety body overlays to `content_filter`. Do not rewrite those plans for technical revisions; anonymization and shipped-status updates are fine.
- This file remains the design source; ADR is the accepted decision.

### 6.11 Overlay field contract (this PR, xAI only)

When `classifyXaiError` **rebuilds** (steps 1, 2, 4, and the transport branch):

Copy from `base` when present: `message`, `kind` (or the overlay kind), `retryable`, `httpStatus`, `retryAfterMs`, `cause`. Set `provider: 'xai'`.

Do not invent `issues` / `callId` / `attemptId` / `servedServiceTier` on a raw SDK throw.

When the input **is** already an `LlmError`: return it unchanged (current behavior). Tests already cover passthrough identity.

Do not change `classifyGoogleError` in this PR.

## 7. Decision log

| Decision                                                         | Alternatives                                          | Why                                                                                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep 403 default as `invalid_auth`                               | Default 403 → `unknown` or new `forbidden`            | Unknown is Temporal-fatal; new kind is an unnecessary union break. Bare 403 without a body is still permission.                                      |
| Overlay on structured prefix `Content violates usage guidelines` | Match `SAFETY_CHECK_TYPE_` only; scan `Error.message` | Prefix is the recorded sentence; check-type suffix varies. Message scan violates the anti-echo rule.                                                 |
| Do not throw on unrecognized xAI 200 incomplete                  | Treat all non-completed as `content_filter`           | No live fixture; existing tests already pin current behavior.                                                                                        |
| Route Google stores through `classifyGoogleError`                | Keep the generic `classifyError` in the stores        | Stores then get the same overlays as `generate()`; the stores keep ADR-024's non-retryable malformed-response and polling-timeout errors themselves. |
| xAI **patch**, not minor                                         | Minor because hosts observe a kind change             | Precedent is patch for classification repairs onto an existing kind. No new public type.                                                             |
| No core/google changeset                                         | Patch core for comment edits                          | CONTRIBUTING: docs-only does not need a changeset.                                                                                                   |
| No new `LlmErrorKind`                                            | Add `forbidden` / `policy`                            | `content_filter` is the cross-provider kind Google already uses.                                                                                     |
| Positive tests = recorded string body only                       | Also test object `.error` / `.message` variants       | Those shapes are not captured for this 403. Helper already reads them for the 400 overlay.                                                           |
| Leave `LlmError` passthrough untagged                            | Force `provider: 'xai'` on injected errors            | Out of scope; would change existing identity-passthrough tests.                                                                                      |

## 8. Risks

- **Prefix drift:** xAI may reword the 403 body. Classification then falls back to `invalid_auth`. Mitigation: fixture + comment pointing at the live capture; fail-closed on unrecognized bodies.
- **False positive:** a genuine permission 403 whose structured body starts with that sentence. Unlikely; that sentence is the safety copy. Today's bug is the opposite misclassification.
- **Host Temporal branding:** hosts that map `invalid_auth` → an auth error type will start seeing `content_filter` for this case. That is the intended repair. Document in the changeset. Host mappings themselves are outside this repo.
- **Usage Guidelines Violation Fee:** xAI may bill on these 403s. Out of scope; we do not invent usage on error records (ADR-027 `raw_usage` null).

## 9. Implementation plan (after signoff)

1. ADR-028 + SPEC / architecture / skill / README / comment edits listed in 6.10.
2. `classifyXaiError` overlay + fixture 15 + unit / fixture / adapter e2e / engine+sink tests listed in 6.8.
3. Changeset: `@gullabs/xai` patch + `@gullabs/any-llm` patch.
4. PR → Claude gate + Codex review → merge → Release workflow publishes.

## 10. Explicit non-goals (restate)

- Do not add compatibility aliases for the old `invalid_auth` classification of this 403.
- Do not parse `Error.message` for the safety signature.
- Do not change retry policy or the record status union.
- Do not invent xAI `countTokens`.
- Do not add 200-path incomplete throws or duplicate existing finish-reason tests.
- Do not add object-body positive safety tests without a capture.
- Do not "fix" CLI classifiers in this PR.
- Do not implement until this document is signed by Codex.
