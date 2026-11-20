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
- **Plan:** [`docs/archive/PLAN-xai-files-store.md`](./docs/archive/PLAN-xai-files-store.md)
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
- **Plan:** [`docs/archive/PLAN-file-store-fail-closed-delete.md`](./docs/archive/PLAN-file-store-fail-closed-delete.md)
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
- **Status:** shipped. `packages/testing/README.md` § "Wiring fakes through a host-owned factory"
  (with the injected `scheduler` beside `clock`) and the pointer in
  `packages/any-llm/skills/any-llm/SKILL.md` describe it; the helpers a host needs instead of
  `vi.mock` (`FakeClient`, `fakeLlmResult`, error factories, recorders, fake stores and CLI runner)
  shipped with it (ADR-041).
- **Origin:** several hosts hand-roll `vi.mock` fakes instead of `@gullabs/testing`; many
  inject adapters via a host-owned factory, not a bare `createClient()` call site.

---

## B-004 — Input-validation middleware (pre-dispatch input contracts)

- **Priority:** P2
- **Status:** IMPLEMENTED as ADR-025 (PR #30, 2026-07-10) — strict interpolation
  default, `CallSite.inputSchema`, `LlmRequest.inputContract`, `requireInputContract`,
  callId⇒ledger-row rule. See `docs/archive/input-contracts-plan.md`.
- **Origin:** host pipeline incident and proposal in
  `docs/archive/input-validation-middleware-proposal.md`.
- **Next step:** none — done.

---

## B-006 — Dependency review: pending dependabot PRs, notably `@google/genai` 2.x major

- **Priority:** P3
- **Status:** done. The routine devDeps, `openai@7` (peer `^7`), `@google/genai@2` (peer `^2`),
  `@changesets/cli@3`, Vitest 5 and `actions/setup-node@v7` are on `main`, and `pnpm quality`
  passes against them. TypeScript stays on 6.x: 7 is a separate plan. `@google/genai` moved to
  3.x on 2026-11-20 (peer `^3.6.1`, ADR-048).
- **Origin:** open dependabot PRs.
- **Next step:** none; re-run the review when Dependabot opens the next major.

---

## B-007 — Response chaining (`previous_response_id` passthrough) — proposal triage

- **Priority:** TBD
- **Status:** proposal dropped by owner, awaiting triage.
- **Origin:** `docs/archive/response-chaining-enhancement.md`.
- **Next step:** owner triage decision.

---

## B-008 — xAI fixture re-capture script

- **Priority:** P2
- **Status:** shipped: `scripts/recapture-fixtures.mjs` (see `scripts/README.md`).
- **Origin:** `packages/xai/src/__fixtures__/*.json` are live captures that back the contract
  tests, including the only external check on cost math (`pricing.test.ts` reconciles
  `XAI_PRICING` against xAI's own `/v1/models` prices and against `cost_in_usd_ticks` from a
  real billed call). They prove the adapter handled the API _as of the capture date_, not as
  of today; silent provider drift stays green.
- **Shipped:** a manual, key-gated script (`XAI_API_KEY`; it refuses to run in CI or without
  the key) that repeats the probes listed in it (fixtures 02, 09, 13 and 14), redacts the
  result, writes it to `.recapture/` and prints the drift against the recorded fixture
  (shape, status and stable values; ids, times, text and token counts are ignored).
  `--write` overwrites the fixture so `git diff` carries the change. Offline tests cover the
  refusals, the redaction and the diff.
- **Left open:** most older fixtures do not record their request and cannot be replayed. A
  new fixture should record its request and get a probe; the existing ones can gain probes
  as their requests are rebuilt. A Google counterpart is not written. Whether the diff runs
  on a release cadence or ad hoc is the maintainer's call (it spends real money, so not CI).

---

## Model refresh deferrals (2026-09-25)

- **2027-01-01 Gemini intro-price re-snapshot.** `gemini-3.6-flash` and `gemini-3.8-flash` ship at the published intro rates $0.75 / $0.075 / $3.75 per million (input / cached / output; flex half). On 2027-01-01 those become $1.50 / $0.15 / $7.50 (re-read 2026-11-20 at <https://aistudio.google.com/docs/pricing>: "$0.75 through December 31, 2026. $1.50 starting January 1, 2027."). Re-snapshot `GEMINI_PRICING` and bump `pricingVersion` on that date. The owner chose a dated backlog item instead of date-windowed pricing (plan D1). (`gemini-3.7-flash`, once in this item, was removed on 2026-11-20, ADR-048.)
- **2027-05-07 `gemini-3.1-flash-lite` shutdown.** Google's deprecations page (read 2026-10-03) lists the date and `gemini-3.5-flash-lite` as the replacement. The descriptor warns from 2027-02-06 (`shutdownDate`, ADR-043). After the date, delete the descriptor, its pricing row, config schema and fixtures in one change; do not keep an alias to the replacement. Re-read the page before each release: a new shutdown date is a one-line descriptor change.
- **`gemini-3.5-flash` status.** The README and `docs/architecture.md` say it is deleted (a live 404 when the registry was refreshed); Google's pricing and deprecations pages still listed it when read 2026-10. Re-read both pages and re-probe the id before the next release; if it serves, it is a registry decision, not an alias.
- Gemini `priority` tier. A live flex call (2026-09-26) echoed `usageMetadata.serviceTier`, and the adapter reads the served tier. Priority still needs live admission, pricing, and downgrade accounting before the schema admits it. Read 2026-11-20 (<https://aistudio.google.com/docs/priority-inference>): priority costs 75-100% more than standard (1.8x on every token line checked, Gemini 4 included), and a downgrade is signalled by the response header `x-gemini-service-tier: standard`; the downgrade accounting must read it before priority is admitted.
- Other Gemini features: built-in tools beyond `googleSearch` (URL context, Maps, code execution, file search); `media_resolution: ultra_high`; `gemini-3.1-pro-preview-customtools`.
- xAI models not in this refresh: grok-4.3, the grok-4.20 family (including multi-agent), grok-build-0.1.
- xAI tools not supported: code execution, collections, remote MCP.
- xAI US regional endpoint (1.1×).
- Undocumented xAI ids (`grok-4.5-cloud`, `grok-4.5-sp`, `grok-orca-oa0917`) are never registered.
- Vision on the CLI providers (`codex exec -i`; `claude -p --input-format stream-json`).
- Non-text models (image, video, TTS, STT, live, music, embeddings).
- **xAI `attachment_search` counter.** Blocked by the current xAI Zero Data Retention key: file upload returned 403 and public URL attachment returned 400 (`docs/model-config-provider-evidence.md`). A non-ZDR key is needed to pin the usage counter, price it at $5 per 1,000 calls (pricing page, read 2026-10-02) and delete `attachment_search_unpinned`. Until then the lane stays estimated.

## Follow-ups from the xAI server tool-choice release (2026-10-02)

- **Gemini search + schema: opt-in built, default stays off.** `providerOptions.google.allowSchemaWithSearch` (with `requireGrounding` on by default) shipped; a 2026-10-03 probe (ADR-035, `docs/grounded-structured.md`) found no Gemini 3.x model that returned grounding metadata with a query on 3 of 4 schema calls (best: 3.1 Pro, 2 of 4), so `structuredOutputWithTools` stays `false`. Re-probe when a new Gemini model ships or Google changes the schema + Search behaviour; a model that reaches 3 of 4 can be set on by default.
- **xAI `safety_identifier`.** New Responses request field (September 2026 release notes, <https://docs.x.ai/developers/faq/security>): an opaque, hashed end-user id. Candidate `providerOptions.xai.safetyIdentifier` for multi-tenant hosts on one key. Needs a live probe before admission.
- **xAI `POST /v1/responses/compact`.** Documented transcript compaction (<https://docs.x.ai/developers/advanced-api-usage/context-compaction>). grok-4.7 replay resends the full wire input; compaction would be the cost control. Needs a design: a second endpoint plus an opaque `compaction` input item.
- **xAI `include: ["no_inline_citations"]`.** Suppresses inline `[[N]](url)` links in the text (<https://docs.x.ai/developers/tools/citations>). Expose only if a host needs citation-free text.
- **xAI `max_turns` enforcement.** Exposed as `providerOptions.xai.maxTurns`; not enforced by xAI on 2026-10-02 (fixture 33, ADR-030), and described as applied in xAI's tool usage guide read 2026-11-20 (<https://docs.x.ai/developers/tools/tool-usage-details>), which is documentation, not a probe. **Probe:** repeat the fixture 33 call (`web_search`, `tool_choice: 'required'`, `max_turns: 1`) on grok-4.5, 4.6 and 4.7 and read the search counters. Enforced: drop the "open" wording from the schema description, `types.ts`, the package README, `SPEC.md` and ADR-030. Still ignored: say so and decide whether the option stays.
- Not exposed on purpose (xAI docs mark them compatibility-only, unsupported, or silently ignored): `reasoning.summary`, function `strict`, `metadata`, `truncation`, `background`, `logprobs`, `search_parameters`, `service_tier: 'fast'`.

## xAI observed 2026-11-20, not modelled

Read on 2026-11-20 from xAI's public documentation (<https://docs.x.ai/developers/models>, <https://docs.x.ai/developers/pricing>, <https://docs.x.ai/developers/release-notes>, <https://docs.x.ai/developers/rest-api-reference/inference/responses>, <https://docs.x.ai/openapi.json>). None is admitted, priced or sent by `@gullabs/xai`; each needs a design and, where it changes a request or a bill, a live probe first.

- New Responses request fields: `min_p`, `top_k`, `guidelines` (custom moderation controls), `safety_identifier`, `context_management`, `prompt_cache_key` beyond today's `promptCacheKey` option.
- The US regional endpoint `https://us.api.x.ai/v1` (grok-4.7 and grok-4.6), billed at 1.1x the global token rates. The client pins `https://api.x.ai/v1`; a host that points elsewhere would be under-priced by 10%.
- `usage.cost_in_nano_usd` and `usage.context_details`, beside the `cost_in_usd_ticks` the adapter already reads.
- Tool types `shell` and `tool_search` (OpenAPI `ModelTool`), with no usage counter and no price row; code execution ($5 per 1,000 calls) and collections search ($2.50 per 1,000 calls) have published rates but stay unpriced here.
- Models not registered: `grok-4.3` and the `grok-4.20-*` family, listed on the models page with their own rates.

## Gemini refresh deferrals (2026-11-20, ADR-048)

Every Gemini 4 fact below is documented and not live-verified; no call was made for this release.

- **2026-12-01: Gemini 4 Carbon / Argon re-snapshot.** The snapshot `gemini-2026-11-20` carries the rates Google bills from 2026-12-01 ($4.00 / $0.20 / $20.00, flex half) and marks every Carbon and Argon cost `estimated` with a warning, because through 2026-11-30 Google bills half. On 2026-12-01: re-read <https://aistudio.google.com/docs/pricing>, remove the two entries of `GEMINI_ESTIMATED_RATE_REASONS` (and nothing else), bump `pricingVersion`, update ADR-048 and the changeset. No date logic is added.
- **Confirm `store: false` live.** The first thing to check with a key: that `store: false` is accepted on every registered model and that the request is not logged (Google's request-level logging field, `GenerateContentRequest.store`).
- **Resumable long decode.** The adapter sends `automaticContinuation: false` and returns a `CONTINUATION` finish as `length` (one dispatch per attempt, ADR-031). Resuming with `continuationToken` ("contents ... must identically replicate the prompt", cumulative `maxOutputTokens`) would be a second billed request: it needs a design (one ledger row per hop, the token kept out of the ledger) and a live probe of the per-hop usage before it can be offered.
- **Gemini 4 schema + Search.** The Gemini 4 descriptors have no `structuredOutputWithTools` and their schemas no `allowSchemaWithSearch`, so the pair is rejected. Google documents the combination as a preview; run the P4 probe (four schema calls per model, ADR-035) and admit the opt-in where it shows Search running.
- **Gemini 4 Search + flex.** Rejected before dispatch: no page shows it and the Gemini 4 flex price tab has no grounding row. Probe one grounded flex call per model and read the bill before admitting it.
- **Gemini 4 JSON Schema profile.** Documentation only: `pattern`, `minLength`, `maxLength`, `items: false` and the `email` format are rejected on Gemini 4 because the structured-output guide does not list them. Run the P3 probe on the four models and widen the profile to what it shows enforced.
- **Gemini 4 grounding instruction tokens.** The pricing page says Gemini 4 bills grounding's internal tool instructions and function declarations as tokens; whether `promptTokenCount` includes them is not documented. A grounded call is therefore `estimated` even with zero queries. Reconcile one grounded call against a billing export.
- **Gemini 4 fields admitted on the general API reference only.** `stopSequences` and `safetySettings` are admitted on Gemini 4 because the generateContent reference documents them and the Gemini 4 migration notes do not remove them; probe both.

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
  `anyllm_call_<name>_<n>` as the tool call's id for the host, and never sends it to Gemini: the
  replayed `functionCall` and `functionResponse` carry no `id` (the 2026-10-03 capture replayed the
  provider's parts as returned). If a host needs Gemini to see the id, that needs a probe first.

## Follow-ups from Gemini grounding usage and price (2026-10-03)

- **Do repeated Gemini queries and tool-use tokens bill?** The grounding fee counts query occurrences
  (a repeated query counts each time) and `usage.details.tool_use_prompt` is recorded unpriced. Gemini
  2.5 reported a query three times and `toolUsePromptTokenCount` 77 / 141 on a grounded call; Gemini 3.x
  deduplicated its queries in 14 of 14 attempts and reported no tool-use tokens. Whether Google bills a
  repeat, or bills tool-use tokens as input, needs a billing export reconciled against a call with a
  repeated query. Until then the cost stays `'estimated'` and counts occurrences (ADR-035).
- **`googleSearch` options.** Google documents `excludeDomains` and `timeRangeFilter` on the Search
  tool. The strict schema accepts `googleSearch: {}` only. Probe what each does (and whether the
  response reports them) before admitting them.
- **Request-side search intent.** One provider-neutral way to say "search" (today: `providerOptions.google.tools`
  or `providerOptions.xai.tools`) is deferred to its own decision. Usage reports search the same way on
  both providers already.
- **Grounding free allowance.** Google publishes a free grounding allowance (read 2026-10:
  5,000 requests per month shared across Gemini 3.x, 1,500 per day on Gemini 2.5). It is shared across a
  project, so a single call cannot know it was free and the fee is charged in full. A host that tracks
  its own volume can subtract it from the ledger.
- **`providerMetadata` namespace.** Grounding metadata and `promptFeedback` sit at the top of
  `providerMetadata`; `searchEntryPoint` is under `providerMetadata.google`. Decide one shape for provider
  metadata before more keys are added.

## Follow-ups from output limits, thinking budgets and spend (2026-10-03)

- **`GenConfig.answerTokens` is rejected by measurement.** A 336-call measurement of Gemini thinking
  tokens (`docs/thinking-token-distribution.md`) found p95 two to six times the p50 at `high` effort,
  driven by the prompt more than by the model or the effort. No per-model answer allowance would be
  stable, so a cap that reserves room for the answer cannot be computed from the descriptor. The warning
  for a budget at or above `maxOutputTokens` (and, on 3.x, `high` effort under 4,096), and the one for
  reasoning that used up the cap, are the final state. Re-measure only if Google changes how thinking is bounded.
- **Enforced spend ceiling.** `spendPreflightMiddleware` is advisory: its read and the dispatch are not
  atomic, so concurrent workers can overshoot, and billed calls with unknown usage are not counted
  unless the host's ledger counts them. A ceiling that holds needs an atomic reservation before
  dispatch and a reconciliation against the billed cost after it, across processes. Own design; needs a
  shared store port (the quota package's store is the nearest precedent).
- **xAI search ceiling in flight.** `providerOptions.xai.searchBudget` reports an exceeded budget after
  the call is billed, and ADR-040 keeps it that way: xAI calls now stream internally, so the search counters
  are visible mid-call, but whether xAI stops its search loop and its billing when a stream is aborted
  (probe P9b) could not be tested without console billing access. An abort that saves nothing only loses
  the result, so nothing aborts. Run P9b first (abort a streamed search call, read the console for the
  charge); only if the billing stops, add the abort, the `rate_limited` / `retryable: false` error with
  partial text (the usage estimate of a failed stream already exists, ADR-040 Amendment A) and its
  `LlmErrorReason` member together. Keep `maxTurns` and re-probe
  whether xAI enforces it at each model refresh.
- **xAI tool-using calls past 300 s.** Streaming removed the need for the undici transport on long
  reasoning calls (live, 17 to 28 minutes, 15 s worst gap between events). A streamed call that itself runs
  server tools past 300 s was not tested (the longest, 99 s, had the same 15 s gap). Capture one, then tell
  hosts with tool-using calls whether they can drop the transport. Until then they set
  `transport.idleTimeoutMs` and a `bodyTimeout` near their longest quiet gap, not the whole deadline.
- **xAI billing of a cut stream.** A stream that fails after output began is not retried and carries a
  lower-bound usage estimate (ADR-040 Amendment A) because whether xAI bills a cut call is unknown (P9b).
  When it is measured, replace the estimate with the real rule and revisit whether a cut stream may retry.
- **xAI streamed reasoning item.** In two live search runs the streamed final object, and the stream, carried
  no `reasoning` item where the non-streamed call had one. The adapter reconciles what the stream announces
  with the final object but cannot rebuild an item nobody announced. Re-probe with
  `include: ['reasoning.encrypted_content']` and a stateless replay to learn whether the missing item
  matters for the `'state'` continuation. (Later live runs agreed with the stream every time: a grok-4.5
  low-effort search again announced no reasoning item, and three grok-4.7 medium-effort searches carried
  theirs in both the stream and the final object; no run had a final object that lacked an announced item.)
- **Output limits for providers that document none.** Gemma 4 and xAI Grok 4.x publish no maximum
  output size, so `limits.maxOutputTokens` is `null` and the schemas apply no cap. Set the real figure
  when a provider documents one (a live probe of an oversized value would also pin it).
- **Gemma 4 input media types.** The Gemma pages name no media types; `image/*` and `video/*` are
  admitted (the model card lists image input and video as frames). Probe whether the Gemini API's Gemma
  endpoint accepts a video part, and which image types it decodes, before tightening or widening.
- **Gemini document types.** Google's document page lists no closed set ("TXT, Markdown, HTML, XML,
  etc."), so `text/*` is admitted as a family. Probe `text/csv`, `application/json` and
  `text/x-python` against the Files API to see which Google actually takes.

## `@gullabs/openai` first slice (2026-11-20, ADR-047)

The package was built from OpenAI's documentation and the `openai` 7.60.0 typings only; no OpenAI call
was made. Each item names the live probe that closes it. A probe spends money and needs the owner's
authorization.

Deferred capabilities (rejected by the schema or the adapter today):

- **Document and file-id inputs.** `file-ref` parts and non-image media are `bad_request`. Probe: a PDF as
  `input_file` (`file_data` and a `user_data` upload) on each model, recording usage and the accepted types.
- **`countTokens`.** `POST /v1/responses/input_tokens` exists in the SDK; whether it is billed or rate-limited
  is undocumented. Probe: count the same request twice and compare with a real call's `input_tokens`.
- **A public fake in `@gullabs/testing`.** Hosts inject an `OpenAiClientLike` today. Build one once a live
  capture of a streamed response exists to replay.
- **Built-in tools** (web search, file search, code interpreter, hosted shell, computer use, MCP, tool
  search) and their tool fees. Probe: one call per tool, recording output items and `tool_usage`.
- **A file store** (Files API upload, get, delete), after document input.
- **`prompt_cache_options`** (explicit mode, `ttl: '12h'`, breakpoints, prewarm) and `prompt_cache_key`.
  Probe: a 12-hour write and a read, reconciling `cache_write_tokens_details` with the billed amount.
- **`reasoning.mode: 'pro'`.** Probe: one call per model, recording usage and whether the tier echo changes.
- **`text.verbosity`.** Support and default on GPT-6.x are undocumented. Probe: each value on each model.
- **Background windows** (`background_options.completion_window` `2h` / `8h`, 30% and 40% off). Needs a
  non-streamed, polled path.
- **`ultrafast`** (GPT-6.2: promotional 3× through 2027-02-28, then 6×). Needs date-aware rates and a probe of
  the echoed tier.
- **Batch.** No path in this library.
- **`high`, `xhigh` and `max` effort on GPT-6.2.** The pages name only `low` and `medium`. Probe: each value on
  `gpt-6.2-astra` and `gpt-6.2-sol`, then widen the schemas and descriptors to what is accepted.
- **Reasoning summaries** (`reasoning.summary`, `includeThoughts`). Probe: `summary: 'auto'` on each model
  (the reasoning guide says organization verification may be required).
- **A transport option** (`fetch`, `fetchOptions`) for proxies and egress policy, as xAI has.
- **Structured output together with function tools.** Rejected (`structuredOutputWithTools: false`). Probe:
  a strict schema plus a function tool on each model, checking the call and the final answer.

Unverified facts that limit the schema or the cost:

- **GPT-6.2 default effort.** No page states it. Probe: a call without `reasoning`, reading the echoed effort.
- **Sampling on Terra and Luna.** The pages are silent on `temperature` and `top_p`, so they are rejected.
  Probe: one call with each.
- **`reasoning.context` default on GPT-6.x.** Not sent; the replay sends every output item. The stub test
  proves the request payload only. Probe: a two-turn function call with `all_turns` and without, comparing
  `input_tokens` and the answer.
- **The echoed tier on a `fast` request.** For GPT-5.6 and earlier the response says `priority`; GPT-6.x is
  undocumented. Both price at the Fast table; a missing echo is unpriced. Probe: a `fast` call per model.
- **Cached tokens and the 272,000 band.** Whether cached reads count toward the threshold is undocumented
  (the band follows gross input; a call the reads decide is `estimated`). Probe: a warm call just above the
  threshold whose uncached input is below it, reconciled with billing.
- **Ordinary input = input − reads − writes.** Inferred from the caching guide's sentence; every call with
  writes is `estimated`. Probe: a call with writes, reconciled with the usage dashboard.
- **Per-model `parallel_tool_calls` support.** Not sent. Probe: two independent tool calls with and without it.
- **The JSON error body.** The shape `error.{message,type,param,code}` is referenced, not shown; the billing
  codes are matched on `error.code` and `error.type`. Capture a 401, a 429 and a 400 body.
- **Dated snapshot ids.** The model pages list only bare ids, so no alias is declared. Re-read on each refresh.
- **Animated GIF.** Only non-animated GIF is documented; the adapter does not decode images to check.

Not modelled: regional-processing (data residency) and FedRAMP surcharges (+10% each); the
`/v1/prompts` reusable prompt objects (shut down 2026-11-30).

---

## Optional later (not ticketed)

- Tool-invocation fee Cost lane for xAI server tools (`attachment_search`, etc.) once
  public pricing is stable enough to freeze into `computeXaiCost`.
- Collections / chunked upload / public URL minting / xAI context-cache store — explicit
  non-goals unless a new plan opens them.
