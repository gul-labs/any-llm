# Backlog

`BACKLOG.md` tracks concrete, actionable work items with status and priority.
Design-seam deferrals (streaming, tool calling, Vertex, the `Redactor` port, etc.) live
in `ROADMAP.md` and are deliberately not duplicated here — this file is for work that is
scoped enough to plan and build, not for placeholders.

Every item that touches code requires a written plan and review signoff before
implementation (repo process).

**Open-source note:** describe needs in terms of library contracts and generic host
patterns. Do not name private consumer products, internal codenames, or absolute
paths to other repos.

---

## B-002 — `@gullabs/xai` Files store (`XaiFileStore`) + generate attach

- **Priority:** P0 (production document attach without re-sending full corpus tokens)
- **Status:** shipped (`@gullabs/xai@0.3.0+`, `@gullabs/core@0.11.0+` with `FileRefPart`).
- **Plan:** [`docs/PLAN-xai-files-store.md`](./docs/PLAN-xai-files-store.md)
- **Origin:** Hosts need provider-scoped Files upload / `file_id` attach / TTL / idempotent
  delete, parity with `@gullabs/google` `GoogleFileStore`.
- **Scope:** `XaiFileStore` (upload with `expires_after`, get, list, idempotent delete);
  core `FileRefPart` + Responses `input_file.file_id` attach; tests; no Collections in v1;
  no ambient env auth.
- **Host guidance:** prefer explicit TTL on ephemeral uploads; permanent files
  discouraged; cleanup idempotent (404 = success).
- **Next step:** none for library — hosts consume published packages. Follow-on **B-005**
  for fail-closed delete (shipped).

---

## B-005 — File-store fail-closed delete (`XaiFileStore` + `GoogleFileStore`)

- **Priority:** P0 (hosts that gate durable release state on known delete success)
- **Status:** shipped (`@gullabs/xai@0.4.0`, `@gullabs/google@0.9.0`, `@gullabs/testing@0.5.0`).
- **Plan:** [`docs/PLAN-file-store-fail-closed-delete.md`](./docs/PLAN-file-store-fail-closed-delete.md)
- **Origin:** Fail-open-only delete cannot gate host DB “released” markers on 5xx/network;
  empty `fileId` should throw.
- **Scope (P0):** per-call `delete(id, { failClosed?: boolean })` on xAI + Google; 404 success
  both modes; empty id → `bad_request`; tests/README. Default remains fail-open (P5).
- **Also shipped:** attachment_search counters on `usage.details`; `FakeXaiFileStore`;
  multi-provider install docs.
- **Next step:** none — shipped. Optional later: tool-fee Cost lane when pricing is stable.

---

## B-001 — `@gullabs/anthropic` provider package

- **Priority:** P1
- **Status:** proposed, awaiting owner approval; plan not yet written.
- **Origin:** hosts still calling Anthropic SDKs directly for production features want a
  first-class any-llm provider plugin (cost ledger / retry / structured output).
- **Scope:** a Claude Messages API adapter mirroring `@gullabs/xai`'s plugin shape —
  adapter, model descriptors (start with a current Haiku-class default), pricing source,
  `ProviderOptionsMap` augmentation, and an `anthropicProvider()` `ProviderPlugin` factory.
  Live verification probes before shipping.

  Explicitly includes a multi-provider composition integration test:
  `composeProviders([googleProvider(), anthropicProvider()])` combining two
  live-API-backed providers into one client — exercising multi-provider
  `Middleware`/`RateLimiter` interaction and `pricingSources` keyed per adapter id.

- **Next step:** owner approval, then a written plan (adapter shape, descriptor list,
  pricing source, live-probe checklist) with review signoff before any code lands.

---

## B-003 — `@gullabs/testing` host-owned-factory documentation

- **Priority:** P2
- **Status:** docs drafted on a docs branch; merge pending further requirements.
- **Origin:** several hosts hand-roll `vi.mock` fakes instead of `@gullabs/testing`; many
  inject adapters via a host-owned factory, not a bare `createClient()` call site.
- **Scope:** README section showing fake wiring through a host-owned factory plus a
  skill pointer in `packages/any-llm/skills/any-llm/SKILL.md` if applicable.
- **Next step:** merge when requirements are stable.

---

## B-004 — Input-validation middleware (pre-dispatch input contracts)

- **Priority:** P2
- **Status:** IMPLEMENTED as ADR-025 (PR #30, 2026-07-10) — strict interpolation
  default, `CallSite.inputSchema`, `LlmRequest.inputContract`, `requireInputContract`,
  callId⇒ledger-row rule. See `docs/input-contracts-plan.md`.
- **Origin:** host pipeline incident and proposal in
  `docs/input-validation-middleware-proposal.md`.
- **Next step:** none — done.

---

## B-006 — Dependency review: pending dependabot PRs, notably `@google/genai` 2.x major

- **Priority:** P3
- **Status:** largely done on branch `chore/dependabot-upgrades-careful` — routine
  devDeps + `openai@7` (peer `^6 || ^7`) + `@google/genai@2.16` (peer already `^1 || ^2`)
  - `actions/setup-node@v7` + pglite 0.5.4. `pnpm quality` green against new majors.
- **Origin:** open dependabot PRs.
- **Next step:** merge upgrade PR; close Dependabot PRs as superseded. Skipped
  `@changesets/cli@3` and TypeScript 7 / Vitest 4 (out of Dependabot scope; separate plan).

---

## B-007 — Response chaining (`previous_response_id` passthrough) — proposal triage

- **Priority:** TBD
- **Status:** proposal dropped by owner, awaiting triage.
- **Origin:** `docs/response-chaining-enhancement.md`.
- **Next step:** owner triage decision.

---

## B-008 — xAI fixture re-capture script

- **Priority:** P2
- **Status:** open, plan not yet written.
- **Origin:** `packages/xai/src/__fixtures__/*.json` are live captures (grok-4.5 on
  2026-07-09, grok-4.6 on 2026-08-12) backing 63 contract tests, including the only
  external check on cost math — `pricing.test.ts` reconciles `XAI_PRICING` against xAI's
  own `/v1/models` prices and against `cost_in_usd_ticks` from a real billed call. They
  were captured by hand and there is no way to refresh them, so they prove the adapter
  handled the API _as of the capture date_, not as of today. Silent provider drift stays
  green.
- **Scope:** a manual, key-gated dev script in the shape of `scripts/probe-capabilities.mjs`
  (not in CI, documented cost warning): replay each recorded request against the live
  Responses API, strip Authorization/Bearer/API-key-shaped strings, write the response
  back to `__fixtures__/`, and diff so drift shows up as a reviewable change. Fixtures are
  Prettier-ignored so a re-capture produces no formatting noise.
- **Next step:** write the plan; decide whether the diff runs on a release cadence or
  ad hoc.

---

## Model refresh deferrals (2026-09-25)

- **2027-01-01 Gemini intro-price re-snapshot.** `gemini-3.6-flash`, `gemini-3.7-flash`, and `gemini-3.8-flash` ship at the published intro rates $0.75 / $0.075 / $3.75 per million (input / cached / output). On 2027-01-01 those become $1.50 / $0.15 / $7.50. Re-snapshot `GEMINI_PRICING` that day. Until then the snapshot under-records by 50% from that date.
- Gemini `priority` tier. `usageMetadata.serviceTier` is now reported. Still needs downgrade accounting before the schema admits it.
- Other Gemini features: built-in tools beyond `googleSearch` (URL context, Maps, code execution, file search); `media_resolution: ultra_high`; `gemini-3.1-pro-preview-customtools`.
- xAI models not in this refresh: grok-4.3, the grok-4.20 family (including multi-agent), grok-build-0.1.
- xAI tools not supported: code execution, collections, remote MCP.
- xAI US regional endpoint (1.1×).
- Undocumented xAI ids (`grok-4.5-cloud`, `grok-4.5-sp`, `grok-orca-oa0917`) are never registered.
- Vision on the CLI providers (`codex exec -i`; `claude -p --input-format stream-json`).
- Non-text models (image, video, TTS, STT, live, music, embeddings).
- P-G5: pin `caching.minTokens` for `gemini-3.5-flash-lite` and `gemini-3.1-flash-lite` with an explicit cache create at 2,048 vs 4,096. Both stay at 2048 until that probe.
- P-X2: pin the `attachment_search` usage counter name, then price it at $10/1k and delete `attachment_search_unpinned`.
- P-X3: capture a grok-4.7 `store: false` function-call replay fixture, including reasoning items. The adapter already replays function-call items unchanged; no fixture values were invented.

## Optional later (not ticketed)

- Tool-invocation fee Cost lane for xAI server tools (`attachment_search`, etc.) once
  public pricing is stable enough to freeze into `computeXaiCost`.
- Collections / chunked upload / public URL minting / xAI context-cache store — explicit
  non-goals unless a new plan opens them.
