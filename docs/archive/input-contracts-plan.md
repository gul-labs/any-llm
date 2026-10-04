# Plan: Input contracts — strict interpolation, callsite/request input validation, pre-dispatch ledger rows

Status: APPROVED by codex in 3 rounds (final session 019f4a84-e2e5-7af1-91e4-db2c11891f4d, 2026-07-10). Implementation in progress on this branch.
Date: 2026-07-10
Branch: `feat/input-contracts`
Origin: `docs/archive/input-validation-middleware-proposal.md` (a host application incident 2026-07-09/10),
triaged and ruled in that doc's "Maintainer ruling (2026-07-10)" section. This plan
implements the four-piece reshaped design plus the two rulings. If approved, the design
becomes ADR-025 in `DECISIONS.md`.

## 0. Settled design rulings (from the proposal doc — not re-litigated here)

1. The middleware shape is withdrawn. Validation is engine-level: the middleware seam
   sees the post-render `ResolvedRequest` and never the raw inputs that break.
2. Schema format is `StandardSchemaV1` only (`packages/core/src/standard-schema.ts`).
   No JSON Schema input contracts — no JSON-Schema-to-validator runtime exists in the
   tree and none will be added.
3. Violations classify as the existing `bad_request` kind (`retryable: false`) with a
   new structured `issues` array on `LlmErrorOptions` — no new `LlmErrorKind` member.
4. Ledger rule: **if a call got a `callId`, it leaves a ledger row.** Any `LlmError`
   thrown inside `runPipeline` after callId allocation but before the first attempt
   produces a synthetic zero-usage record. This is generic (covers input-contract
   refusals, `@gullabs/quota` refusals, and future pre-dispatch middleware) with zero
   changes to `@gullabs/quota`. Errors thrown before callId allocation (unregistered
   model, missing provider, callsite prologue failures) stay row-less.

## 1. Deliverables

All code changes are contained to `packages/core`. D7 touches docs and
`packages/any-llm` (SKILL.md).

### D1. Strict template interpolation (BREAKING DEFAULT — no opt-out)

Current behavior (`interpolate`, `packages/core/src/engine.ts:338-342`): a placeholder
whose key is absent from `vars`, or whose value is `null`/`undefined`, is silently left
as the literal `{{name}}` in the rendered prompt. This is a reject-don't-map violation
in our own default path and is the exact incident failure class.

New behavior, applied in `runStructured` to **both** `callSite.userTemplate` and
`callSite.system` before any request is built:

- Collect every `{{\w+}}` placeholder across both templates. For each placeholder, the
  key must be present in `vars` AND `typeof vars[key] === 'string'`. Any placeholder
  failing either check is a violation.
- On violation: throw `LlmError` `bad_request`, `retryable: false`, message naming the
  callsite id and ALL violating placeholders (not just the first), with one `issues`
  entry per placeholder (D6). Zero tokens spent; the request is never built.
- Non-string non-null values (numbers, objects — off the `Record<string, string>` type
  but reachable from untyped callers) are violations, not coerced. Reject, don't map.
- Variables provided in `vars` but unused by any template are ALLOWED and not an error:
  a shared context bag across call sites whose templates use different subsets is a
  legitimate pattern, and an unused variable cannot corrupt the rendered prompt. This
  boundary is documented.
- Literal `{{...}}` text in templates is not supported (no escape syntax). Documented.
- A `CallSite` with no `userTemplate`/`system` keeps its existing behavior unchanged;
  strict checking applies only to templates that exist.
- `interpolate` itself becomes total over the now-guaranteed inputs; the old
  leave-placeholder fallback branch is DELETED, not kept behind a flag (P0 no-legacy).

This throws in the `runStructured` prologue, before `runPipeline`, therefore before
callId allocation: **row-less by the §0.4 rule**, same layer as unregistered-model.
Deliberate and documented — see §3 boundary note.

### D2. `CallSite.inputSchema` — opt-in callsite input contract

- `CallSite` (`packages/core/src/callsite.ts`) gains `inputSchema?: StandardSchemaV1`.
- In `runStructured`, after resolving `vars` and BEFORE strict interpolation (D1) and
  before the request is built: if `callSite.inputSchema` is present, validate `vars`
  against it via the `~standard.validate` seam — the same machinery
  `validateResolvedConfig` uses (`engine.ts:618-670`). Ordering rationale: the schema
  error names the business field with the caller's own vocabulary; running it first
  means a missing field surfaces as a schema violation, not as a downstream unresolved
  placeholder.
- On violation: `bad_request`, `retryable: false`, message listing every failing path,
  `issues` populated (D6). Async validators (StandardSchema permits `Promise` results)
  are supported — `runStructured` is already async.
- `runStructured` does NOT auto-populate `LlmRequest.inputContract` from `inputSchema`
  — no double validation, one contract per path.
- Row-less (prologue, pre-callId), same as D1.

### D3. `LlmRequest.inputContract` — opt-in request input contract (the `generate()` path)

- `LlmRequest` (`packages/core/src/types.ts`) gains:

  ```ts
  inputContract?: {
    schema: StandardSchemaV1
    value: unknown
  }
  ```

- Validated inside `runPipeline`, immediately AFTER callId allocation and BEFORE the
  middleware chain is entered. Ordering consequences (both deliberate):
  - runs before `@gullabs/quota` middleware — a contract violation never consumes
    RPM/RPD budget (resolves the proposal's quota open question);
  - runs before the retry middleware — validated exactly once per logical call, never
    per attempt.
- On violation: `bad_request`, `retryable: false`, `issues` populated (D6),
  `callId` attached. Because this is post-callId, **it produces a ledger row via D5**.
- `inputContract` is consumed by the engine and MUST NOT reach adapters: it is not
  copied onto `ResolvedRequest` and no adapter sees it. A test pins this.
- `runStructured` builds its `LlmRequest` internally and never sets `inputContract`;
  callsite consumers use D2. Documented.

### D4. `createClient({ requireInputContract: true })` — opt-in fleet-wide strict mode

- New optional boolean on `ClientConfig`, default absent/off.
- When on: `generate()` refuses any request without `inputContract`, and
  `runStructured` refuses any call whose `callSite` lacks `inputSchema`. Both refuse
  with `bad_request`, `retryable: false`, message naming the option and the missing
  contract.
- Placement and error precedence, defined exactly:
  - `runStructured` path: the missing-`inputSchema` refusal is the FIRST check in the
    prologue — before D2 validation, D1 interpolation, and request building. Row-less
    (pre-callId).
  - `generate()` path: the existing prologue checks (provider presence, model
    registration, descriptor resolution, `validateResolvedConfig`) run first and WIN —
    a request that is both missing its contract and misconfigured fails with the
    existing prologue error, row-less, exactly as today. The missing-`inputContract`
    refusal happens inside `runPipeline`, immediately after callId allocation and
    before D3 validation (trivially ordered: the require-check fires only when
    `inputContract` is absent, D3 only when present). Post-callId → ledger row via D5.
- `countTokens` is out of scope for this flag: it dispatches no generation and spends
  no tokens on producing output; contracts guard generation inputs.

### D5. Generic pre-attempt ledger record (BREAKING for observed ledger contents)

- New wiring in `runPipeline`'s call-level error path (`engine.ts:1456` region): when
  the middleware chain throws and NO attempt ran (no attempt record was written — the
  engine tracks whether `runAttempt` started), build and write a synthetic
  `LlmCallRecord`:
  - `status` derived from the error kind via the EXISTING `errorKindToStatus`
    mapping (`packages/core/src/record.ts` — `bad_request` → `'api_error'`,
    `rate_limited` → `'api_error'`, etc.); no new status value is introduced and
    `recordSchemaVersion` stays `1`. `errorKind`/`errorMessage` come from the thrown
    `LlmError` (non-`LlmError` throws are classified `unknown`, mirroring existing
    behavior). The `status` doc table in `record.ts` gains a note that pre-attempt
    refusals also land in these buckets, distinguished by `attemptNumber: 0`.
  - `usage: EMPTY_USAGE`, `cost` OMITTED (matches the existing `buildErrorRecord`
    convention for never-dispatched work; the proposal's literal `cost: 0` is
    superseded — a zero-usage record with no `cost` field is the existing "nothing was
    priced" representation and introduces no new convention),
  - `attemptNumber: 0`, with `attemptId` following the EXISTING first-attempt
    idempotency rule verbatim: `request.idempotencyKey` when supplied, a freshly
    minted id otherwise (mirrors how attempt 1 derives its `attemptId` today —
    `types.ts:265`, `docs/ledger.md`, pinned in `engine.test.ts:1837`). This keeps
    the refusal path ledger-idempotent: a caller-retried refused call with the same
    `idempotencyKey` upserts the same row rather than accumulating duplicates. No
    change to the idempotency contract. Real attempts start at 1, so `attemptNumber:
0` unambiguously denotes "refused before any attempt". The `@gullabs/drizzle`
    column is `integer().notNull()` with no check constraint, so storage accepts it
    unchanged; but this IS a public-contract revision of `LlmCallRecord`, not a
    free rider: `record.ts` documents `attemptNumber` as a 1-based ordinal and
    `attemptId` as the ID of "this specific attempt". Both doc contracts are
    REWRITTEN (attemptNumber: "0 = refused before any attempt ran; real attempts
    are 1-based"; attemptId: "on attemptNumber 0, derived by the same rule as
    attempt 1 — `idempotencyKey` when supplied, minted otherwise; remains the
    idempotency key"), the semantic widening is stated in the core
    changeset as part of the ledger behavior break, and ADR-025 records it.
    `recordSchemaVersion` stays `1` — no field shape changes.
  - Telemetry contract is deliberately UNCHANGED: `CallErrorEvent.attemptId` stays
    absent when no attempt ran (its documented semantics, `ports.ts:479`). The
    synthetic record's minted `attemptId` therefore has no telemetry counterpart;
    ADR-025 and the record docs state this divergence explicitly.
  - all identity fields (`callId`, `callSiteId`, `provider`, `model`, timestamps via
    `Clock`) populated exactly as error records are today.
- Sink write is fail-open per ADR-021, same leveled logging as existing sink writes.
- Covers D3/D4 refusals AND existing `@gullabs/quota` refusals with one code path and
  zero quota-package changes. INTENTIONAL OBSERVABLE BEHAVIOR CHANGE (stated in the
  changeset): quota refusals that previously left no ledger row now appear as
  `error_kind: 'rate_limited'`, `attemptNumber: 0`, zero-usage rows.
- Boundary pinned by tests: errors thrown before callId allocation produce no row;
  errors thrown by middleware pre-attempt produce exactly one row; errors thrown after
  an attempt ran keep today's per-attempt records unchanged (no duplicate synthetic
  row).
- Three refusal sources are each covered by a dedicated fixture (per the proposal's
  accepted ledger ruling): (1) a D3 input-contract refusal, (2) a quota-style
  `rate_limited` refusal thrown by middleware pre-attempt, and (3) a GENERIC custom
  middleware throwing pre-attempt (any `LlmError`, e.g. the retry middleware
  refusing before its first attempt) — proving the path is source-agnostic.

### D6. `LlmErrorOptions.issues` — structured violation payload

- New optional field on `LlmErrorOptions`/`LlmError` (`packages/core/src/errors.ts`):

  ```ts
  issues?: readonly LlmErrorIssue[]
  // where
  interface LlmErrorIssue {
    path: string // dotted path, '' for root — e.g. 'context.photographer'
    message: string
  }
  ```

  Normalized from `StandardSchemaV1.Issue[]` by the existing path-flattening logic in
  the config-validation formatter (`engine.ts:618-647`), extracted into a shared
  helper so the message-string builder and the `issues` builder cannot drift.

- Producers in this plan: D1 (one issue per violating placeholder, path = placeholder
  name), D2, D3, D4 (single issue naming the missing contract).
- `validateResolvedConfig` (model-config validation) is upgraded to attach `issues` to
  the `bad_request` it already throws — same normalized shape, one taxonomy for all
  caller-fault validation errors. No message-format change beyond the added field.
- Serialization: `issues` is plain JSON data (no `PropertyKey` symbols — symbol path
  segments are stringified), safe for ledgers and postmortems. It is NOT persisted to
  `LlmCallRecord` in this plan (the record keeps `errorMessage`; a structured
  `errorIssues` column is a potential follow-up, not in scope).

### D7. Docs, ADR, changesets

- `DECISIONS.md`: new ADR-025 recording §0's four rulings, the D1 breaking default,
  the opt-in surfaces (D2/D3/D4), the callId⇒ledger-row rule and its
  quota-observability consequence, and the row-less prologue boundary.
- `docs/architecture.md`: pipeline diagram/description updated — where input contracts
  run relative to interpolation, callId, middleware, quota, retry, attempts.
- `docs/archive/input-validation-middleware-proposal.md`: Status updated to point at ADR-025
  and this plan (record only; no content rewrite).
- `packages/any-llm/skills/any-llm/SKILL.md`: new section — strict interpolation
  default, `inputSchema`/`inputContract`/`requireInputContract` usage, `issues` payload,
  ledger semantics of refusals (`attemptNumber: 0`).
- Root `README.md` and/or core README surface: brief input-contracts mention where
  output contracts are described (match existing depth; no new doc pages).
- `BACKLOG.md` (on this branch when merged forward): B-003 status → implemented,
  pointer to ADR-025. NOTE: BACKLOG.md currently exists only on the unmerged
  `docs/backlog-and-testing-factory-example` branch — if that branch is still unmerged
  when this lands, B-003's status update happens there or at merge time; do not
  cherry-pick it into this branch.
- Changesets:
  - `@gullabs/core` **minor** (breaking-as-minor pre-1.0). Must state BOTH intentional
    behavior breaks explicitly: (1) strict interpolation — templates that previously
    dispatched with literal `{{placeholder}}` text now fail locally with a typed
    `bad_request` before dispatch; (2) pre-attempt refusals (including
    `@gullabs/quota` denials) now write zero-usage `attemptNumber: 0` ledger rows.
  - `@gullabs/any-llm` patch (SKILL.md ships in this package).
  - No `@gullabs/quota` release: its code is untouched; the ledger change ships from
    core and is documented in core's changeset.

## 2. Explicitly out of scope

- No JSON Schema input contracts, no schema-format autodetection.
- No changes to any provider package or adapter; `inputContract` never reaches
  adapters.
- No changes to `@gullabs/quota` code.
- No `errorIssues` column on `LlmCallRecord` / `@gullabs/drizzle` schema.
- No validation of rendered `system`/`messages` content (the rejected
  "rendered-parts" alternative from the proposal).
- No `countTokens` contract enforcement.
- No compatibility flags, no opt-out for D1, no preservation of the old interpolate
  fallback (P0 no-legacy).

## 3. Documented boundary: which refusals get ledger rows

| Failure                                          | Where it throws                      | Ledger row                     |
| ------------------------------------------------ | ------------------------------------ | ------------------------------ |
| Strict interpolation (D1)                        | `runStructured` prologue, pre-callId | No                             |
| `CallSite.inputSchema` (D2)                      | `runStructured` prologue, pre-callId | No                             |
| `requireInputContract` on callsite path (D4)     | `runStructured` prologue, pre-callId | No                             |
| `LlmRequest.inputContract` (D3)                  | `runPipeline`, post-callId           | Yes (`attemptNumber: 0`)       |
| `requireInputContract` on `generate()` (D4)      | `runPipeline`, post-callId           | Yes (`attemptNumber: 0`)       |
| `@gullabs/quota` refusal (existing)              | middleware, post-callId              | Yes (`attemptNumber: 0`) — NEW |
| Unregistered model / missing provider (existing) | prologue, pre-callId                 | No (unchanged)                 |

Rationale for the asymmetry: callsite prologue failures are deterministic call-site
code defects caught on first execution in dev/tests, in the same layer as
unregistered-model; the ledger-visibility requirement in the proposal came from the
`generate()` consumer (a host application), whose path is fully covered. The rule "callId ⇒
row" stays simple and exceptionless. ADR-025 records this table.

## 4. Tests (all in `packages/core`; coverage gates 93/91/96/93 hold)

- D1: unresolved placeholder (user template, system template, both), null value,
  undefined value, non-string value, multiple violations all reported in one error,
  unused extra var allowed, no-template callsite unchanged, `{{`-less template
  unchanged, error carries kind/retryable/issues, zero adapter invocations (FakeAdapter
  never called).
- D2: valid vars pass; invalid vars throw with every failing path in `issues`;
  async validator supported; validation runs before D1 (a missing field surfaces as
  the schema's error, not the placeholder error); no double validation (schema
  validator invoked exactly once).
- D3: violation throws `bad_request` with `issues` + `callId`; runs before middleware
  (a quota middleware in the chain observes zero invocations on refusal); runs once,
  not per retry attempt; valid contract dispatches normally; `inputContract` absent →
  no validation; adapter never receives `inputContract` (pinned on the
  `ResolvedRequest` the adapter sees).
- D4: on → `generate()` without contract refused (with ledger row), `runStructured`
  without `inputSchema` refused (row-less); off/absent → unchanged behavior;
  precedence pinned: a `generate()` request that is both missing its contract AND
  references an unregistered model fails with the existing unregistered-model error,
  row-less.
- D5: D3 refusal writes exactly one record — `status: 'api_error'` (via
  `errorKindToStatus('bad_request')`), `errorKind: 'bad_request'`, `usage` all-zero,
  no `cost`, `attemptNumber: 0`, `attemptId` = `idempotencyKey` when the request
  supplied one and a minted id otherwise (both cases tested), correct
  `callId`/provider/model/timestamps; quota-style middleware refusal (`rate_limited`
  thrown pre-attempt) also writes one such row; a generic custom middleware throwing
  any pre-attempt `LlmError` (third fixture, e.g. retry-middleware refusal before its
  first attempt) also writes one such row; post-attempt errors produce no synthetic
  row (no duplicates); pre-callId errors produce no row; sink failure on this path is
  fail-open (call still throws the original error, logged per ADR-021);
  `@gullabs/drizzle` accepts an `attemptNumber: 0` record (verified — the column is
  unconstrained `integer().notNull()`; add a drizzle fixture only if an invariant
  test exists to extend).
- D6: issue normalization from StandardSchema paths (nested paths, array indices,
  symbol segments stringified, root-level issue → `path: ''`); config-validation
  errors now carry `issues`; message string and `issues` derive from the shared helper
  (drift-pinning test).
- Type-level: new public surface (`inputSchema`, `inputContract`,
  `requireInputContract`, `issues`, `LlmErrorIssue`) exported and visible in dist
  types (extend the existing dist-d.ts compile test if applicable).

## 5. Process

- Branch `feat/input-contracts` (off local main at `36d0e8c`, which contains the
  proposal + ruling doc; note local main is currently unpushed — pushing main or
  including those commits in this branch's PR is a merge-time decision for the owner).
- This plan requires codex signoff BEFORE implementation.
- Implementation by sonnet agents, sequential (all core work concentrates in
  `engine.ts`/`errors.ts` — no parallel-worktree value):
  - **C1** (one agent): D6 + D1 + D2 — errors/issues plumbing, shared normalizer,
    strict interpolation, callsite inputSchema, with tests.
  - **C2** (same or new agent): D3 + D4 + D5 — inputContract, requireInputContract,
    pre-attempt ledger record, with tests.
  - **C3**: D7 docs/ADR/changesets.
- Every commit codex-reviewed before the next starts; whole-branch codex review at the
  end. Gates per commit: `pnpm quality` AND explicit `pnpm typecheck`.
- STOP after the branch is complete and reviewed — no merge/PR without owner
  go-ahead (owner has signaled more requirements may be incoming).

## 6. Risks / verification points

- `attemptNumber: 0` — drizzle storage verified unconstrained (`integer().notNull()`,
  no check constraint); the real change is the `record.ts` doc-contract revision
  spelled out in D5. Implementation must still sweep core record invariants/tests for
  any `>= 1` assumption before relying on it.
- Interpolation placeholder syntax is `\w+` only; templates in the wild using other
  syntaxes (spaces, dashes) are untouched text and now — as before — dispatch as-is.
  Strictness applies only to what `interpolate` recognizes. Documented.
- The engine currently validates config twice on the happy path (public method +
  per-attempt); input-contract validation must NOT copy that duplication — validated
  exactly once (test-pinned).
