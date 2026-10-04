# PLAN: xAI feature expansion — search tools, first-class citations, function-calling seam, countTokens

Status: APPROVED — Codex sign-off 2026-08-24 after 3 review rounds (r1: 7 required changes; r2: 2 remaining; r3: approved, no findings)
Date: 2026-08-24
Basis: full read of docs.x.ai (2026-08-24) vs current core/google/xai surface.

## Scope

In scope (this plan, four workstreams + one probe):

- **WS-0** — resolved 2026-08-24: grok-4.5 admits `low|medium|high`. `xhigh` stays rejected (model-refresh D2, 2026-09-25).
- **WS-A** — xAI server-side Live Search tools (`web_search`, `x_search`) via `providerOptions.xai.tools`, with per-invocation pricing lanes.
- **WS-B** — first-class `citations` on `LlmResult` (core, generic; populated by google + xai adapters).
- **WS-C** — generic function-calling seam (tools in, tool-call parts out; **no agent loop**). ADR required.
- **WS-D** — `xaiAdapter.countTokens` via `POST /v1/tokenize-text`.

Explicitly OUT of scope (deferred by owner decision 2026-08-24): response chaining / `previous_response_id` / encrypted reasoning (B-007 stays parked), streaming/WebSocket, Batch API (unsupported on grok-4.5/4.6), deferred completions (chat-completions-only; we are Responses-only), context compaction, `code_execution`/remote-MCP/`collections_search` server tools, multi-agent models, image/video/voice generation.

Ground rules that bind every workstream:

- **P0 no-legacy**: breaking changes are fine; no compat shims, no deprecated aliases. Closed unions may be widened/changed without migration lanes.
- **Reject, don't map** (memory/ADR discipline): unsupported or ill-formed input → `bad_request` with issues; never clamp, never silently drop. Adapters fail closed when `modelDescriptor` is absent.
- Strict Zod per-model config schema is the runtime gate; JSON Schema derived via `toConfigJsonSchema`; unknown keys fail.
- Adapters never validate output, price, persist, or retry.
- CI: `pnpm typecheck` runs separately from vitest — both must pass; dist-d.ts compile test guards `ProviderOptionsMap` augmentation.

Sequencing: WS-0 → WS-D → WS-B (core) → WS-A (uses WS-B) → WS-C (own PR, largest). WS-0/WS-D/WS-B+A can land as one PR train; WS-C is a separate PR with its own ADR.

---

## WS-0: grok-4.5 reasoning-effort re-probe

Resolved 2026-08-24. `Grok45ConfigSchema` admits `low|medium|high`. `xhigh` stays rejected (model-refresh D2, 2026-09-25): an echo does not prove a distinct level. `none` stays rejected. The 2026-07-09 probe that rejected `medium` is historical.

## WS-D: xAI `countTokens`

`ProviderAdapter.countTokens?` (core `ports.ts:200`) exists and google implements it; xai does not — `client.countTokens` on an xai model currently fails.

Core precondition — machine-readable accuracy semantics (per review round 1): xAI's `/v1/tokenize-text` omits inference-added framing tokens, so its count is a lower bound; ADR-024 expects `countTokens` to be representative of the generation call. A docs-only caveat is not acceptable.

1. Core `ports.ts`: extend `TokenCount` with a **required** `accuracy: 'exact' | 'lower-bound'` field (clean breaking change, P0 — no optional-with-default shim). `client.countTokens` return type carries it through. Google adapter sets `accuracy: 'exact'` (its API counts the real request). Update core engine tests + testing fakes.
2. `packages/xai/src/adapter.ts`: implement `countTokens(req: TokenCountRequest, ctx)` calling `POST https://api.x.ai/v1/tokenize-text` with `{model, text}` via raw `fetch` (same pattern as `XaiFileStore` — the endpoint is not in the openai SDK surface). Reuse the xai error classifier for failures (400-as-auth quirk etc.). Returns `accuracy: 'lower-bound'`.
3. Input mapping: concatenate `system` + text parts in message order, separated by `\n`. **Reject** (`bad_request`) every non-text part kind explicitly: `inline-media`, `file-uri`, and `file-ref` — tokenize-text is text-only; counting a request whose media/attachments the endpoint cannot see would be a silent lie even as a lower bound (attachments change what the generation call tokenizes).
4. Result: `TokenCount { totalTokens: token_ids.length, accuracy: 'lower-bound', details: { textTokens: n }, raw }`. README + tsdoc explain the semantics.
5. Tests: fixture for tokenize-text response; rejection tests for all three non-text part kinds; error-classification test; core test that google reports `exact` and the field is required at compile time (dist-d.ts surface test).

## WS-B: first-class citations (core, generic)

Both providers now produce citations (google groundingMetadata; xAI `response.citations` from search tools). Today they are buried in raw `providerMetadata`, with a google-only opt-in shaper (`normalizeGroundingCitations`). Users write per-provider spelunking code — this is the abstraction gap.

Core (`packages/core/src`):

1. `types.ts`: add
   ```ts
   interface Citation {
     url: string
     title?: string
     sourceName?: string
   }
   ```
   and `citations?: Citation[]` on `LlmResult`. `ports.ts`: `citations?: Citation[]` on `AdapterResult`; engine passes through verbatim (no core normalization — adapters own the shaping, consistent with ADR-023).
2. `record.ts` (`LlmCallRecord`): add `citations?: Citation[]` (persisted as JSON). `packages/drizzle`: add the column + mapping. No back-compat migration lane (P0 greenfield): regenerate schema, breaking drizzle minor.
3. Semantics: `undefined` = provider produced none / feature unused. Empty array is not emitted (omit instead). Raw provider payloads remain in `providerMetadata` untouched — `citations` is a normalized convenience projection, lossy by design.

Google (`packages/google/src`):

4. Adapter populates `result.citations` from groundingMetadata using the existing normalization logic (`grounding.ts`).
5. **Delete** the public `normalizeGroundingCitations` export (P0 no-legacy: the opt-in shaper is now redundant); the logic becomes adapter-internal. Update README/adoption guides.

xAI: populated in WS-A.

Tests: engine passthrough; drizzle round-trip; google adapter populates from grounding fixture; compile test that `Citation` is exported from core index.

## WS-A: xAI Live Search tools (`web_search`, `x_search`)

Mirrors the google grounding pattern (`providerOptions.google.tools` + `capabilities.grounding` + citations). Server-side tools only — no client-side function calling here (that is WS-C) and no `code_execution`/MCP/collections (out of scope).

### Types & schema

1. `packages/xai/src/types.ts` — extend `XaiProviderOptions`:
   ```ts
   type XaiWebSearchTool = {
     type: 'web_search'
     allowedDomains?: string[] // max 5, mutually exclusive with excludedDomains
     excludedDomains?: string[] // max 5
     enableImageUnderstanding?: boolean
     enableImageSearch?: boolean
   }
   type XaiXSearchTool = {
     type: 'x_search'
     allowedXHandles?: string[] // max 20, mutually exclusive with excludedXHandles
     excludedXHandles?: string[] // max 20
     fromDate?: string // ISO-8601 date, inclusive
     toDate?: string
     enableImageUnderstanding?: boolean
     enableVideoUnderstanding?: boolean
   }
   interface XaiProviderOptions {
     promptCacheKey?: string
     tools?: Array<XaiWebSearchTool | XaiXSearchTool>
   }
   ```
   camelCase in our lane; adapter maps to snake_case wire form.
2. Zod (`model-config/grok-4-5.ts`, `grok-4-6.ts`): strict discriminated union for the tools array; all constraints **structurally representable** in derived JSON Schema — no `superRefine`/`check` for public config constraints (the strict-schema design requires derived JSON Schema to be exact, not a structural subset). Encoding: each tool is a union of exclusive shapes — e.g. `web_search` = `strictObject({type, allowedDomains: array.max(5), enable…})` | `strictObject({type, excludedDomains: array.max(5), enable…})` | `strictObject({type, enable…})` — so allowed⊕excluded exclusivity, max lengths (5 domains / 20 handles), and date format (`z.iso.date()`) are all plain structure. "At most one tool of each type" is enforced the same way: `tools` is a union of the admitted combinations (`[web]`, `[x]`, `[web, x]` tuples) rather than an open array with a refinement. **Parity test gate**: a table-driven test asserting the derived JSON Schema rejects every invalid config the Zod schema rejects (both-allowed-and-excluded, >5 domains, duplicate tool types, unknown keys).
3. `packages/xai/src/models.ts`: set `grounding: true` on both descriptors (same capability key google uses; adapter gates on it, fail-closed without descriptor).

### Adapter

4. `packages/xai/src/adapter.ts`:
   - `mapXaiProviderOptions` (`adapter.ts:134-169`): replace the hardcoded `key !== 'promptCacheKey'` check with an explicit allowlist `{promptCacheKey, tools}`; unknown keys still throw `bad_request` naming them.
   - Request build: emit `tools: [{type:'web_search', allowed_domains, ...}, {type:'x_search', allowed_x_handles, from_date, ...}]`. Gate on `descriptor.capabilities.grounding`; absent descriptor → fail closed (`bad_request`).
   - Structured output + search: docs confirm combinable on Grok 4-family — no gate; add a live-verified fixture proving it.
   - Response: map `response.citations` (and `output_text` `annotations` if populated) → `AdapterResult.citations` (WS-B shape: url; title/sourceName when present) AND keep the raw payload in `providerMetadata`.
   - **Usage-counter field names are UNPINNED** (review round 1 flagged the plan's `server_side_tool_usage_details.web_search_calls` naming as possibly stale — current docs also describe `server_side_tool_usage` with `SERVER_SIDE_TOOL_*` category strings, and Responses `web_search_call` output items). **Hard pre-implementation gate**: run a live search-tools probe, capture the real usage/response payload as fixtures, and pin the exact field names in `client.ts` (`XaiResponseShape`) and the pricing lanes from those fixtures — not from docs. The existing rule stands: numeric usage extras flow into `usage.details` under their raw provider names, whatever those turn out to be.
5. `packages/xai/src/client.ts`: extend `XaiResponseCreateParams` with `tools`; add `citations` + the fixture-pinned server-tool usage typings.

### Pricing

6. Core contract revision — `Cost.details` gains a **required** `tools: number` lane (micro-USD): `details: { input; cached; output; tools }`. Clean break, no optional field (an optional field whose absence means "old shape" is a compatibility-preserving smell — P0). Google and CLI adapters' pricing sources set `tools: 0`. The documented invariant becomes `microUsd = input + cached + output + tools`; update the invariant text, core cost tests, testing fakes, and drizzle cost-detail persistence.
7. `packages/xai/src/pricing.ts`: per-invocation lanes read from `usage.details` (the `PricingSource.price(model, usage, tier)` signature already receives Usage — no port change), using the fixture-pinned counter keys from the WS-A probe gate:
   - web search invocations × $5.00 / 1,000 calls
   - X search invocations × $5.00 / 1,000 calls
   - attachment-search invocations × $10.00 / 1,000 calls (**fixes the existing silent under-report**: we already record server-tool counters but never price file attachments). Which counter attributes attachment_search is part of the same live-probe gate.
   - Bump `xaiPricingVersion`.
   - **Confidence semantics + plumbing** (round-2 fix — `PricingSource.price(model, usage, tier)` has no request context and no warnings channel, and the engine must stay provider-ignorant, so the ADAPTER signals): when the xai adapter builds a request with billable server tools in play (`providerOptions.xai.tools` present, or `file-ref` parts attached → auto attachment_search), it sets a documented **synthetic** usage-detail flag `usage.details.server_tools_requested = 1` (the `details` lane is `Record<string,number>` and documented as open; the xai README documents this key as adapter-synthetic, not a provider payload field). If the expected per-tool counters are then absent from the response usage, the adapter additionally pushes an `AdapterResult.warnings` entry naming the missing counters — warnings are the adapter's existing channel; `Cost` gets none. The pricing source needs only `Usage`, unchanged signature: tool lanes priced from the fixture-pinned counters; if `server_tools_requested` is set but the counters are absent, token lanes are priced, `tools: 0`, and `confidence: 'estimated'`. `'exact'` requires counters present or no server tools requested. Contract tests cover all three states.
8. README pricing table + `grok-4-6-vs-4-5.md` update.

### Tests

- Schema: exclusivity, max-lengths, unknown-key rejection, both models.
- Adapter: request wire-shape snapshot; grounding-gate fail-closed; citations mapping fixture; structured+search fixture.
- Pricing: per-lane math incl. `gt200k` interaction; attachment_search lane; missing-counter warning path.
- Live verification run (fixtures + master-config artifact) before publish, per house rule.

## WS-C: function-calling seam (generic; separate PR + ADR-029)

The one deliberate scope expansion. Both providers support client-side function calling; today we reject it everywhere (`geminiContentToMessages` throws on `functionCall`; xai has no lane). Without it, agentic callers bypass the library entirely and lose cost/usage/ledger on their most expensive calls. Scope: **tools in, tool-call parts out, tool results back in. No agent loop, no tool execution, no retry-on-tool-error semantics.** "No framework, no magic" stands.

### Core contract

1. `types.ts` — new `Part` variants (the reserved discriminants from DESIGN.md:287):
   ```ts
   interface ToolCallPart {
     kind: 'tool-call'
     toolCallId: string
     toolName: string
     args: JsonValue
   }
   interface ToolResultPart {
     kind: 'tool-result'
     toolCallId: string
     toolName: string
     result: JsonValue
     isError?: boolean
   }
   ```
   Guards `isToolCallPart`/`isToolResultPart`. Placement rule (validated in engine prologue, `bad_request` on violation): `tool-call` parts only in `assistant` messages; `tool-result` parts only in `user` messages. No new `tool` role — keeps `Message` binary and maps cleanly onto both wire formats (Gemini functionResponse rides a user turn; xAI Responses items are role-less `function_call_output` entries).
2. `types.ts` — request additions:
   ```ts
   interface ToolDefinition {
     name: string
     description: string // REQUIRED — xAI documents description as required; reject-don't-map means we don't let one provider's optionality leak into the generic contract
     inputJsonSchema: JsonValue
   }
   type ToolChoice = 'auto' | 'required' | 'none' | { name: string }
   ```
   `LlmRequest.tools?: ToolDefinition[]`, `LlmRequest.toolChoice?: ToolChoice` (only valid when `tools` present → else `bad_request`). Engine prologue validation: tool names non-empty and **unique** within the array; `toolChoice.name` must be a member of `tools` (else `bad_request` with issues); `description` non-empty; `inputJsonSchema` an object schema. `parallelToolCalls` is **not** generic (Gemini has no knob; parallel is default-on both sides) → `providerOptions.xai.parallelToolCalls?: boolean` only.
3. `FinishReason`: widen closed union with `'tool_calls'`. Breaking; no compat lane (P0).
4. `LlmResult` / `AdapterResult`: `toolCalls?: Array<{ toolCallId: string; toolName: string; args: JsonValue }>` — a projection of the assistant turn's tool-call parts for ergonomic dispatch. `text` may coexist (some models emit prose + calls).
5. `registry.ts` capabilities: `functionCalling?: boolean`. Adapters gate fail-closed.
6. Engine: `tools` on `generate` only. `runStructured` + `tools` → `bad_request` in this iteration (structured-final-answer-with-tool-loop is an app-layer loop; revisit only with evidence). Tool-call/tool-result pairing (every `tool-result.toolCallId` must match a prior `tool-call`) validated in prologue alongside the definition checks from (2).
   6b. `countTokens` reconciliation (round-2 fix — tool declarations are token-bearing request context, and ADR-024 requires counts representative of the generation call): WS-C extends `TokenCountRequest` with `tools?: ToolDefinition[]` (`toolChoice` excluded — it selects behavior, it is not materially token-bearing prompt content). Google's `countTokens` forwards the mapped `functionDeclarations` to the Gemini countTokens call, keeping `accuracy: 'exact'` truthful for tool-bearing requests. xAI's `countTokens` **rejects** (`bad_request`) a `TokenCountRequest` carrying `tools` — tokenize-text cannot represent tool declarations, and a lower bound that ignores an unbounded schema payload is not a useful bound (reject-don't-map). Until WS-C lands (PR 2), `TokenCountRequest` stays as-is; the WS-D `accuracy` field ships in PR 1 with unchanged request shape.
7. Full persistence pipeline (every hop, per review round 1): `AdapterResult.toolCalls` → engine → `LlmResult.toolCalls` → `buildSuccessRecord` in `core/src/record.ts` → `LlmCallRecord` fields (`toolCalls?` JSON; tool names + count alongside `generationConfig`) → `packages/drizzle/src/schema.ts` columns → `packages/drizzle/src/sink.ts` mapping → drizzle integration-test DDL. Same full-pipeline treatment for WS-B `citations`. Usage/cost unchanged by WS-C.

### Google adapter

8. Map `ToolDefinition[]` → `tools:[{functionDeclarations:[...]}]`; `toolChoice` → `toolConfig.functionCallingConfig`: `auto→AUTO`, `required→ANY`, `none→NONE`, `{name}→ANY + allowedFunctionNames:[name]`.
9. Response `functionCall` parts → `toolCalls` + `finishReason:'tool_calls'`. Request-side: `ToolCallPart` → model-role `functionCall` part; `ToolResultPart` → user-role `functionResponse` part.
10. Combination gates (reject-don't-map, per live-verified model support): `tools` + `providerOptions.google.tools` (googleSearch) in one request — reject unless the specific model is verified to support mixing; start with reject-always, flip per model with fixtures. `tools` + structured output already rejected at engine level (6).
11. `geminiContentToMessages`: `functionCall`/`functionResponse` now convert to the new parts instead of throwing (`executableCode`/`codeExecutionResult` still throw). Update ADR-024 notes.
12. Descriptors: `functionCalling: true` on Gemini models (per docs), `false`/absent on Gemma until verified.

### xAI adapter

13. Map `ToolDefinition[]` → Responses `tools:[{type:'function', name, description, parameters}]` (strict is implicitly true per docs — forward schema verbatim, no rewriting, consistent with our no-preflight stance; note docs quirk: `additionalProperties` defaults to `false` on xAI). `toolChoice` → `tool_choice`: `'auto'|'required'|'none'` pass as strings; named choice maps to the documented forced shape `{"type":"function","function":{"name":"…"}}` — pin the exact accepted wire shape (this nested form vs the flat Responses form) from the live probe, since docs show the chat-completions form.
14. Request replay (we run `store:false`): assistant `ToolCallPart` → `{type:'function_call', call_id, name, arguments}` input item; `ToolResultPart` → `{type:'function_call_output', call_id, output}`. **HARD pre-implementation gate**: live-verify that `/v1/responses` accepts replayed `function_call` items with `store:false`. If it does not, the xai leg of WS-C STOPS — no storage fallback, no `store:true` compatibility path may be added without a new ADR and an explicit owner decision (storage = 30-day retention, a privacy posture change).
15. Response `function_call` output items → `toolCalls`; `finishReason:'tool_calls'` when present. Multi-item interaction with the existing last-`message`-wins quirk (`adapter.ts:686-706`): function_call items are separate output items — collect all, don't apply the message-collapse rule to them.
16. Descriptors: `functionCalling: true` on grok-4.5 and grok-4.6; schema additions for `providerOptions.xai.parallelToolCalls`.
17. Server-side tools (WS-A) and client-side functions are combinable per docs — allow, with a live fixture.

### ADR + docs

18. ADR-029: the seam contract — placement rules, no-loop stance, `runStructured` exclusion, per-provider gates, `finishReason` widening. Update DESIGN.md (un-reserve the discriminants), SPEC.md scope line, README ("tool-calling seam, no agent loop"), adoption guides with a full request→dispatch→respond example.
19. Tests: engine placement/pairing validation; both adapters' wire-shape snapshots; round-trip (call → result → replay) fixtures from live probes; capability fail-closed tests; `codex-cli`/`claude-cli` adapters explicitly reject `tools` (`bad_request`) — CLI runtimes are out of seam scope.

## `@gullabs/any-llm` facade decision

The batteries-included facade currently re-exports **core + google only** and depends only on those packages (`packages/any-llm/src/index.ts`, `package.json`). Decision for this plan: **facade stays core + google** — `@gullabs/xai` remains an explicitly-installed standalone plugin (consistent with ADR-023's compose-what-you-use posture; pulling `openai` as a transitive dependency into every facade consumer is not worth the convenience). Consequences: no dependency/export/surface-test change in `packages/any-llm`; it version-bumps only as a changesets dependency ripple of the core breaking changes, with no surface delta of its own. If the owner instead wants xai in the facade, that is a separate decision: add the dependency + re-export + dist surface test + README — not smuggled into this plan.

## Rollout / versioning

- PR 1: WS-0 + WS-D + WS-B + WS-A. Core breaking changes: `Cost.details` → `{input, cached, output, tools}` (required), `TokenCount.accuracy` (required), `LlmResult.citations` + record field, `normalizeGroundingCitations` export deleted. Changesets: major-style bumps per repo convention for core, google, xai, drizzle, testing; any-llm ripple-only.
- PR 2: WS-C + ADR-029. Core breaking: `FinishReason` + `'tool_calls'`, new Part kinds, `tools`/`toolChoice` on `LlmRequest`, `toolCalls` on results/records; google, xai, drizzle, testing, and both CLI adapters (explicit `bad_request` rejection of `tools` and the new part kinds, with updated messages/tests).
- Pre-implementation probe gates (block their workstream until fixtures exist): WS-0 effort probe; WS-A search-tools usage/citations payload probe; WS-C xai `store:false` replay probe + forced-`tool_choice` wire-shape probe.
- CI/test gates for BOTH PRs, all mandatory: `pnpm quality` (builds before lint per repo CI), recursive workspace build, `pnpm typecheck` (separate from vitest — vitest skips types), full vitest, dist-d.ts compile tests (ProviderOptionsMap augmentation + new core surface incl. required `accuracy`/`tools` fields), drizzle schema/sink/integration DDL tests, `packages/testing` fakes updated (fake-xai + core fakes for new fields), per-package surface tests, README/adoption-guide updates in the same PR, live-verification fixtures + master-config artifact before publish, changesets present for every touched package.

## Resolved review decisions (round 1)

1. **WS-C replay**: hard gate, probe first; on failure the xai leg stops pending a new ADR/owner decision — no storage fallback (§WS-C.14).
2. **`Cost.details.tools`**: adopted as a required field with updated invariant `microUsd = input + cached + output + tools` (§WS-A.6).
3. **Schema representability**: structural unions only; no refinements for public config; parity test gate (§WS-A.2).
4. **Tool-usage counter keys**: unpinned until the live probe; fixtures are the source of truth, docs are not (§WS-A.4).
5. **countTokens**: machine-readable `TokenCount.accuracy: 'exact' | 'lower-bound'` required field; `file-ref` in the explicit rejection list (§WS-D).
6. **Citation minimalism**: `{url, title?, sourceName?}` accepted (reviewer-approved) — raw payloads stay in `providerMetadata`.
