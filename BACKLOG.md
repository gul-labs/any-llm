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

- **2027-01-01 Gemini intro-price re-snapshot.** `gemini-3.6-flash`, `gemini-3.7-flash`, and `gemini-3.8-flash` ship at the published intro rates $0.75 / $0.075 / $3.75 per million (input / cached / output). On 2027-01-01 those become $1.50 / $0.15 / $7.50. Re-snapshot `GEMINI_PRICING` and bump `pricingVersion` before that date. The owner chose a dated backlog item instead of date-windowed pricing (plan D1).
- Gemini `priority` tier. P-G7 captured a `usageMetadata.serviceTier` flex echo and the adapter now reads served tier. Priority still needs live admission, pricing, and downgrade accounting before the schema admits it.
- Other Gemini features: built-in tools beyond `googleSearch` (URL context, Maps, code execution, file search); `media_resolution: ultra_high`; `gemini-3.1-pro-preview-customtools`.
- xAI models not in this refresh: grok-4.3, the grok-4.20 family (including multi-agent), grok-build-0.1.
- xAI tools not supported: code execution, collections, remote MCP.
- xAI US regional endpoint (1.1×).
- Undocumented xAI ids (`grok-4.5-cloud`, `grok-4.5-sp`, `grok-orca-oa0917`) are never registered.
- Vision on the CLI providers (`codex exec -i`; `claude -p --input-format stream-json`).
- Non-text models (image, video, TTS, STT, live, music, embeddings).
- P-G5 completed 2026-09-26: cache create at 1024 tokens succeeded, 103 tokens failed with `min_total_token_count=1024`, on all six registered Gemini 3.x ids.
- P-X2 blocked by the current xAI Zero Data Retention key: file upload returned 403 and public URL attachment returned 400. A non-ZDR key is needed to pin the `attachment_search` usage counter, price it at $10/1k, and delete `attachment_search_unpinned`.
- P-X3 completed 2026-09-26: live grok-4.7 `store: false` two-turn function call captured the encrypted reasoning item; `result.transientProviderState` and `request.transientProviderState` preserve the full wire history while the next request supplies only new messages. The state stays out of ledger rows. Fixture `28-grok-4-7-replay.json` pins the round trip.
- P-X1 completed 2026-09-26: live posts-only and users-only X Search responses emitted both item counters, including explicit zeroes, and snapshot cost reconciled to billed ticks. Fixtures `26-x-posts.json` and `27-x-users.json` pin the behavior. The 2026-08-24 fixture predates per-item billing; its billed ticks remain in usage while snapshot cost is unpriced.

## Follow-ups from the xAI server tool-choice release (2026-10-02)

- **Gemini search + schema: decided, opt-in not built.** Structured output plus `googleSearch` is off by default on all six Gemini 3.x models (`structuredOutputWithTools: false`); the adapter rejects it with `bad_request` and points at the two-call recipe in `docs/grounded-structured.md`, which also holds the 2026-10-02 probe table. Still open: sending `responseJsonSchema` instead of `responseSchema` when `googleSearch` is present, and a per-call opt-in guarded by checks that Search actually ran (grounding evidence required), after which a model proven by probes could be on by default.
- **xAI `safety_identifier`.** New Responses request field (September 2026 release notes, <https://docs.x.ai/developers/faq/security>): an opaque, hashed end-user id. Candidate `providerOptions.xai.safetyIdentifier` for multi-tenant hosts on one key. Needs a live probe before admission.
- **xAI `POST /v1/responses/compact`.** Documented transcript compaction (<https://docs.x.ai/developers/advanced-api-usage/context-compaction>). grok-4.7 replay resends the full wire input; compaction would be the cost control. Needs a design: a second endpoint plus an opaque `compaction` input item.
- **xAI `include: ["no_inline_citations"]`.** Suppresses inline `[[N]](url)` links in the text (<https://docs.x.ai/developers/tools/citations>). Expose only if a host needs citation-free text.
- **xAI `attachment_search` price.** The pricing page lists it at $5 per 1,000 calls (read 2026-10-02), not the $10 noted under P-X2 above. The counter name is still unpinned (ZDR key), so the lane stays estimated.
- **xAI `max_turns` enforcement.** Exposed as `providerOptions.xai.maxTurns`; not enforced by xAI on 2026-10-02 (fixture 33, ADR-030). Re-probe when xAI changes the agentic loop, then update the README.
- Not exposed on purpose (xAI docs mark them compatibility-only, unsupported, or silently ignored): `reasoning.summary`, function `strict`, `metadata`, `truncation`, `background`, `logprobs`, `search_parameters`, `service_tier: 'fast'`.

## Follow-ups from Gemini 3 thought signatures (2026-10-03)

- **Google dummy thought signature.** Google documents `skip_thought_signature_validator` as a value
  that bypasses signature validation for a replayed function call. The 2026-10-03 capture
  (`packages/google/src/__fixtures__/thought-signatures-2026-10-03.json`) shows all six Gemini 3.x
  models accepting it (HTTP 200). The library does not offer it: Google warns a missing or dummy
  signature degrades tool-use quality, and the overlay already covers every history the library
  produced. It would be the only way to replay a hand-authored or other-provider function-call
  history into Gemini 3, so build it only as an explicit per-call opt-in with a warning, never as a
  fallback.
- **`countTokens` with function-call history on Gemini 3.** The adapter sends no signatures to
  `countTokens`. Whether the Developer API accepts an unsigned function call there is unprobed.
- **Function-call ids on replay.** When Google returns no `functionCall.id`, the adapter assigns
  `call_<name>_<n>` and replays it as `functionCall.id` / `functionResponse.id`. The 2026-10-03
  capture replayed the provider's parts as returned. Confirm with a probe that the API accepts a
  library-assigned id.

## Optional later (not ticketed)

- Tool-invocation fee Cost lane for xAI server tools (`attachment_search`, etc.) once
  public pricing is stable enough to freeze into `computeXaiCost`.
- Collections / chunked upload / public URL minting / xAI context-cache store — explicit
  non-goals unless a new plan opens them.
