# Implementation Plan: Provider-Plugin Architecture + xAI Grok 4.5 Provider

Provider-surface snapshot for the later Grok 4.6 announcement (2026-08-12):
[`docs/grok-4-6-vs-4-5.md`](../grok-4-6-vs-4-5.md). That note is research
only — this plan stays the 4.5 implementation record.

Status: IMPLEMENTED — Phase 1, Phase 2, and Phase 3 have landed on
`feat/provider-plugin-architecture`. Plan originally approved via codex
adversarial review, 3 rounds (final: VERDICT APPROVED, codex session
019f4937-2cd9-7d03-b970-15a83aed8446); every implementation commit received
individual codex signoff per §4. This docs-closeout commit finalizes Phase
1/2/3 documentation (§5 item 4 resolved with live-verified answers; new §6
added for Phase 3, which was not originally scoped in this document).

Full commit sequence landed (`git log --oneline --reverse ba21620..HEAD`):

```
8a9134f docs: codex-approved plan — provider-plugin architecture + @gullabs/xai grok-4.5

# Phase 1 — core refactor (§2)
a5f422c feat!: ProviderOptionsMap module augmentation; google owns its options type
da3ac61 feat: ProviderPlugin + composeProviders composition helper
1080ee2 feat!: provider-neutral service tiers; flexFallback into providerOptions.google; drop engine guard
d13bad2 feat!: move all Google model configs, descriptors, pricing, types into @gullabs/google

# Phase 3 — adoption-gap closures (new §6; not originally scoped in this plan)
fea6496 feat: countTokens adapter port + client API; GoogleCacheStore token pre-flight
e969d7f feat(google): geminiContentToMessages migration utility — exhaustive genai Content[] conversion
51dd5ce feat: shared assertRegistryInvariants in @gullabs/testing; provider-payload error taxonomy fixes

# Phase 2 — @gullabs/xai + grok-4.5 (§3)
5809828 feat: @gullabs/xai package skeleton — client port, provider options augmentation, wiring
2fc3080 feat: xai adapter — Responses API mapping, error classifier, usage accounting
171d2fc feat: grok-4.5 descriptor, strict config schema, pricing (live-verified), provider plugin, fixtures
```

Note: `assertRegistryInvariants` (§2.5, Phase 1 scope) shipped as part of the
51dd5ce commit alongside Phase 3 error-taxonomy fixes — the commit sequence
above reflects actual landing order, not the original phase grouping.

Branch: `feat/provider-plugin-architecture`.
Date: 2026-07-09 (plan approval). Implementation completed: 2026-07-09
(same day; `171d2fc` — Phase 2/xai final commit — and this docs-closeout
commit both land 2026-07-09).

## 0. Goals

1. Fix the design gaps that force core edits when onboarding a provider: after this
   plan, a new provider ships as one self-contained package (adapter + model
   descriptors + strict per-model Zod config schemas + pricing source + typed
   provider options) and registers at `createClient` with zero `@gullabs/core`
   changes.
2. Onboard xAI as the first provider built on that shape: `@gullabs/xai` with
   `grok-4.5` on xAI's Responses API.

Both phases are breaking. Per the P0 rule there are no shims, aliases, or
compatibility re-exports: old surfaces are deleted outright.

## 1. Verified research inputs (2026-07-09)

### 1.1 Grok 4.5 (released 2026-07-08, docs.x.ai)

- Model id `grok-4.5`; aliases `grok-4.5-latest`, `grok-build-latest`. No mini/fast
  variants, no dated snapshot. Context 500k tokens; text + image input → text.
  Max output tokens undocumented (~30k per press, unofficial).
- Pricing (µUSD/M, standard): input $2.00, cached input $0.50, output $6.00.
  Reasoning tokens billed as output. A >200k long-context tier ($4/$1/$12) is
  reported by third-party trackers only — **must be verified with a live API call
  before it is added to the pricing table** (§5.4).
- Reasoning: always-on reasoning model; Responses API `reasoning: { effort }` with
  `low | high | none` documented per endpoint — `none` is documented for
  grok-4.3+; whether grok-4.5 accepts it must be live-verified (§5.4). Default
  effort `high`. Usage exposes `reasoning_tokens`.
  `presence_penalty`, `frequency_penalty`, `stop` are rejected by xAI on
  reasoning models.
- Structured output: native `response_format: json_schema` (constraint caps:
  string length ≤ 2048, array items ≤ 256, properties ≤ 64; empty enum/anyOf →
  400).
- Tool calling: native + parallel. Server-side agentic tools (`web_search`,
  `x_search`, `code_interpreter`, file/collections search, remote MCP) are
  Responses-API-only and billed per invocation (e.g. web_search $5/1k) — out of
  scope for v1 (§5.5).
- Vision: jpg/png, ≤ 20 MiB/image, unlimited count, base64 data URL or public URL.
- Caching: automatic; `prompt_cache_key` (Responses body) or `x-grok-conv-id`
  header (equivalent) strongly recommended for reliable cache routing.
- API: base `https://api.x.ai/v1`, `Authorization: Bearer`. Endpoints:
  `/v1/responses` (primary, recommended), `/v1/chat/completions` (documented as
  legacy), `/v1/messages` (Anthropic-compatible migration shim). Rate limits:
  150 RPS / 50M TPM default. Regions us-east-1/us-west-2; no EU at launch.
- No first-party TypeScript SDK. xAI's quickstart recommends the `openai` npm
  package with a base-URL override (or Vercel AI SDK, which does not support
  advanced server-side tools).

### 1.2 SDK decision: `openai` as peerDependency

Verified against openai-node (v6.x) README and xAI docs:

- Request side is non-validating: xAI-only body params pass through as-is (and
  `reasoning`, `prompt_cache_key` are in OpenAI's own types already).
- Per-request custom headers supported via `RequestOptions`.
- Response side never strips unknown fields: xAI usage extensions
  (`reasoning_tokens`, `cached_tokens`, `num_server_side_tools_used`, citations)
  survive; the adapter layers its own xAI-typed interfaces over the SDK types.
- Retries/timeouts disableable (`maxRetries: 0`, own `AbortSignal`) — no conflict
  with the engine owning retry/timeout (adapter contract, DESIGN.md P3).
- Error classes expose `.status`, `.headers` (retry-after), raw `.error` body —
  maps onto `classifyHttpStatus`/`LlmError` trivially.
- `client.responses` works against api.x.ai and is xAI's recommended TS path.
- Zero runtime dependencies; majors rare (v6 since 2025-09); pinned as `^6` peer.

Decision: `openai@^6` as peerDependency of `@gullabs/xai`; Responses API
(`client.responses.create`); `maxRetries: 0`; adapter passes the engine's
attempt signal. Raw fetch rejected (would re-implement SSE parsing — the
highest-defect-density part — for zero benefit). Anthropic-compat endpoint
rejected (migration shim; lags features; we have no Anthropic-SDK code to reuse).

## 2. Phase 1 — Provider-plugin architecture (core refactor)

Design authority: this plan supersedes the current layout; new ADR-023 records it.
Precedent: `packages/claude-cli` / `packages/codex-cli` already prove
self-contained descriptors work with zero core edits (claude-cli
`src/models.ts:1-11`).

### 2.1 `ProviderOptionsMap` via module augmentation

- `packages/core/src/types.ts` (~187): delete the closed
  `type ProviderOptions = { google?: GoogleProviderOptions }`. Replace with:

  ```ts
  export interface ProviderOptionsMap {}
  export type ProviderOptions = ProviderOptionsMap
  ```

- `GoogleProviderOptions` moves to `packages/google`, which augments:

  ```ts
  declare module '@gullabs/core' {
    interface ProviderOptionsMap {
      google?: GoogleProviderOptions
    }
  }
  ```

- Runtime enforcement is unchanged and remains solely the per-model strict Zod
  schemas (ADR-010) — the closed TS type never provided runtime safety.
- **Entrypoint-loading rule** (augmentation only takes effect if the declaring
  module is loaded into the program): the `declare module '@gullabs/core'`
  augmentation lives in a module that `packages/google/src/index.ts` imports
  unconditionally (the module also exports `GoogleProviderOptions`, so it is a
  real import, not a bare side-effect). Root typecheck and vitest resolve
  `@gullabs/*` to each package's `src/index.ts` (tsconfig.json:5,
  vitest.config.ts:9), and published consumers resolve to `dist` types whose
  entry d.ts re-exports the same module — both paths therefore load the
  augmentation whenever anything is imported from `@gullabs/google`.
- Type tests (compile-time, in `packages/google`): importing ONLY from the
  `@gullabs/google` entrypoint (never a deep path), assert
  `providerOptions.google` infers as `GoogleProviderOptions` at a `generate()`
  call site, and that an unknown provider key is an excess-property error.
  A post-build check (`tsc` against the packed `dist` d.ts or attw) verifies the
  published-artifact path in CI before release. Documented limitation: a
  consumer importing only `@gullabs/core` sees an empty `ProviderOptionsMap` —
  correct by design (no provider loaded, no options).

### 2.2 `ProviderPlugin` + `composeProviders`

New `packages/core/src/plugin.ts`:

```ts
export interface ProviderPlugin {
  adapter: ProviderAdapter
  modelDescriptors: ModelDescriptor[]
  pricingSource?: PricingSource
}

export function composeProviders(
  plugins: ProviderPlugin[],
): Pick<ClientConfig, 'adapters' | 'modelRegistry' | 'pricingSources'>
```

- Pure composition over existing injection; `createClient` invariants
  (duplicate adapter id, descriptor.provider ↔ adapter.id, strictPricing) are
  unchanged and still fire.
- `composeProviders` throws `LlmError('bad_request')`-style config errors on
  duplicate plugin adapter ids (fail at composition, earliest point).
- Each provider package exports one factory: `googleProvider(opts?)`,
  `claudeCliProvider()`, `codexCliProvider()`, later `xaiProvider(opts?)`.
- Host usage: `createClient({ ...composeProviders([googleProvider()]), ... })`.

### 2.3 De-Google `serviceTier`; move `flexFallback` into `providerOptions.google`

Gemini-only billing concepts leaked into shared `GenConfig` (types.ts:205-218)
and — worse — into a generic engine guard (engine.ts:641-646) that runs for every
provider. Requested-vs-served tier is also an observability contract: it flows
into call records (engine.ts:702 → record.ts:54) and the Drizzle `serviceTier`
column (packages/drizzle/src/schema.ts:23), which must keep working.

- **`GenConfig.serviceTier` STAYS, retyped as an opaque provider-defined
  `string`** (was the Google literal union `'flex' | 'standard'`). Semantics:
  "provider-defined service/billing tier vocabulary; admitted values are
  constrained by each model's strict config schema" — Gemini schemas admit
  `'flex' | 'standard'`; models without tiers simply never admit the key
  (strict schemas reject it). This keeps the requested-tier path through
  costing (engine.ts ~1262 `servedServiceTier ?? config.serviceTier`), records,
  and Drizzle completely unchanged and provider-agnostic. No
  `requestedServiceTier` echo on `AdapterResult` (a request field does not
  belong in a response port).
- **`GenConfig.flexFallback` is DELETED from core** and moves to
  `providerOptions.google.flexFallback` (pure Google capacity-retry behavior,
  ADR-013 precedent).
- Delete the engine-level flexFallback-requires-flex guard (engine.ts:641-646)
  — redundant: the Gemini per-model schema unions enforce it precisely, now
  inside the `providerOptions.google` block.
- Gemini model-config schemas: the flex/standard union branching keys on the
  top-level `serviceTier` as today, with `flexFallback` relocated under
  `providerOptions.google` in the flex branch only.
- Google adapter and `flex-fallback.ts` retry logic read `flexFallback` from
  `providerOptions.google`. `PricingSource.price(model, usage, tier)` keeps
  tier opaque (already does). `TIER_FACTOR` moves to google (§2.4).
- Record/persistence surfaces (`LlmCallRecord.serviceTier`, drizzle column):
  type widens from the Google literal union to `string` where narrowed;
  otherwise untouched.
- **Companion seams that also encode the Google vocabulary widen in the same
  commit** (they are the tier feature's other half):
  - `ModelDescriptor.capabilities.serviceTiers?: ('flex' | 'standard')[]`
    (registry.ts:47) widens to `readonly string[]` — provider-defined
    vocabulary, declared per descriptor.
  - Retry tier pinning (retry.ts): `revalidatePinnedServiceTier` drops its
    hardcoded `tier !== 'flex' && tier !== 'standard'` literal check and
    becomes fully descriptor-driven — a served tier is pinnable iff it appears
    in `modelDescriptor.capabilities.serviceTiers`; `pinnedServiceTier` widens
    from the literal union to `string | undefined` (retry.ts:243). Semantics
    for Google are unchanged (its descriptors list exactly
    `['flex', 'standard']`).
  - Tests: retry pinning exercised with a non-Google tier vocabulary (fake
    descriptor with e.g. `['priority', 'default']`) to prove the seam is
    genuinely provider-neutral, plus the existing Google pinning cases.

### 2.4 Move ALL Google-named surface out of core into `packages/google`

Complete export inventory leaving `@gullabs/core` (target: zero provider
knowledge in core — grep for `Google|Gemini|Gemma|GEMINI|flex` in
`packages/core/src` must come back clean, doc examples aside):

- Types (currently types.ts / index.ts): `GoogleProviderOptions`,
  `GoogleSafetySetting`, `GoogleSearchTool`, and any other `Google*`-named type
  → `packages/google/src/types.ts` (with the ProviderOptionsMap augmentation,
  §2.1).
- `packages/core/src/model-config/*` (per-model Gemini/Gemma schema files) →
  `packages/google/src/model-config/` (generic helpers `toConfigJsonSchema`,
  `zodToStandardSchema` stay in core).
- `geminiModelDescriptors`, `gemmaModelDescriptors`, `defaultGeminiRegistry` out
  of `packages/core/src/registry.ts` → `packages/google`. Core registry.ts keeps
  only `ModelDescriptor`, `ModelRegistry`, `createModelRegistry`,
  `assertDescriptorSchemaArtifacts`.
- `GEMINI_PRICING` + `TIER_FACTOR` (pricing.ts) and `geminiPricingSource`
  (cost.ts) → `packages/google`. Core keeps `computeCost` (already pure and
  parameterized) and the `PricingSource` port.
- `ClientConfig.modelRegistry` becomes required (no default registry in core).
- Gemini-specific tests move with the code (registry fixtures, config-validation
  cases, pricing tests). Core keeps generic-machinery tests only.
- Dependency direction: google → core only. No cycles.
- Single-audit-view cost: mitigated — the facade (and any host) can enumerate
  all models via the composed registry; `composeProviders` output exposes the
  merged `modelRegistry`.

Named downstream fallout (fixed in the SAME commit, see §4 sequencing):

- `packages/any-llm` (currently a pure re-export barrel of core + google):
  keeps `export * from '@gullabs/core'` + `export * from '@gullabs/google'` —
  so its consumers still see `googleProvider`, `geminiPricingSource`, etc.; the
  moved symbols change _home package_, not facade availability. Its
  `index.surface.test.ts` is updated to lock the new surface incl.
  `composeProviders`/`googleProvider`. Facade one-liner documented as
  `createClient({ ...composeProviders([googleProvider()]), ... })` — no new
  `createDefaultClient` wrapper (rejected as needless indirection).
- `packages/core/README.md`, `packages/any-llm/README.md`, and
  `packages/any-llm/skills/any-llm/SKILL.md` all hardcode
  `defaultGeminiRegistry`/`geminiPricingSource`/direct `createClient` wiring —
  every snippet is rewritten to the plugin composition in the same commit.
- `packages/core/src/index.ts` surface test and `packages/google`'s
  `index.surface.test.ts` updated for removed/added exports.
- `packages/quota`, `packages/drizzle`, `packages/testing`: audit for imports of
  moved symbols (`makeFakeGemini` in testing references google shapes; drizzle's
  `serviceTier` column widens per §2.3) and fix in the same commit.

### 2.5 Shared onboarding-invariant helper

- Extract `packages/core/src/registry.test.ts` (~163-228) logic into
  `packages/testing/src/registry-invariants.ts`:

  ```ts
  export function assertRegistryInvariants(opts: {
    descriptors: ModelDescriptor[]
    expectedModelIds: readonly string[]
    pricingSource?: PricingSource
    explicitlyUnpriced?: ReadonlySet<string>
    adapterFixtureModelIds: readonly string[]
    negativeContractFixtureModelIds: readonly string[]
  }): void
  ```

- Enforces per provider package: three schema artifacts present and consistent
  (`configJsonSchema === toConfigJsonSchema(configSchema)`), model-id list
  pinned, every model priced or explicitly unpriced, every model has positive
  and negative adapter contract fixtures.
- Wired into `packages/google` (moved registry tests), `claude-cli`,
  `codex-cli`; later `xai`.

### 2.6 Docs, ADR, hygiene

- ADR-023 in DECISIONS.md: "Provider packages as self-contained plugins" —
  decision, drivers (zero core edits per provider; core ships zero provider
  knowledge; CLI packages as precedent), all breaking consequences.
- Update DESIGN.md (package scope, planned seams, config sections) and
  docs/architecture.md wherever they describe core-owned Gemini schemas/pricing
  or `GenConfig.serviceTier`.
- Changeset covering all bumped packages (repo is 0.x — follow existing
  changeset conventions for breaking bumps; inspect prior `feat!` changesets).
- `no-ambient-auth` source scan unchanged in Phase 1 (no new package).

### 2.7 Phase 1 breaking-change inventory

1. `ProviderOptions` closed type removed → `ProviderOptionsMap` augmentation.
2. `GenConfig.serviceTier` widens from `'flex' | 'standard'` to opaque `string`
   (record/drizzle narrowings widen accordingly);
   `ModelDescriptor.capabilities.serviceTiers` widens to `readonly string[]`;
   retry tier pinning becomes descriptor-driven (no tier literals in core);
   `GenConfig.flexFallback` removed (now `providerOptions.google.flexFallback`).
3. Engine flexFallback guard removed.
4. Core no longer exports ANY Google-named symbol: `GoogleProviderOptions`,
   `GoogleSafetySetting`, `GoogleSearchTool`, Gemini/Gemma descriptors and
   model-config schemas, `GEMINI_PRICING`, `TIER_FACTOR`, `geminiPricingSource`,
   `defaultGeminiRegistry` (all move to `@gullabs/google`; still reachable via
   the `@gullabs/any-llm` facade).
5. `ClientConfig.modelRegistry` required.
6. New core exports: `ProviderPlugin`, `composeProviders`, `ProviderOptionsMap`.

## 3. Phase 2 — `@gullabs/xai` with grok-4.5

Mirrors `packages/google`, built on the Phase 1 plugin shape. Nothing lands in
core.

### 3.1 Package skeleton

- `packages/xai/package.json`: `dependencies: { '@gullabs/core': 'workspace:*' }`,
  `peerDependencies: { openai: '^6' }`, tsup dual CJS/ESM build, same scripts as
  google.
- `src/client.ts`: `XaiClientLike` structural interface over the openai SDK
  Responses surface (only what the adapter uses — enables fakes);
  `buildXaiClient(auth)` = `new OpenAI({ apiKey, baseURL: 'https://api.x.ai/v1', maxRetries: 0 })`
  (only file importing `openai`); `requireApiKey(auth)` narrowing `AuthMaterial`
  (reuses `ApiKeyAuth`; no union change).
- `src/adapter.ts`: `xaiAdapter(opts?): ProviderAdapter`, `id: 'xai'`.
- `src/models.ts` + `src/model-config/grok-4-5.ts`: descriptors + strict schema.
- `src/pricing.ts`: `XAI_PRICING` + `xaiPricingSource()` (provider-scoped; does
  not reuse Gemini's).
- `src/provider.ts`: `xaiProvider(): ProviderPlugin`.
- `src/types.ts`: `XaiProviderOptions` + `declare module '@gullabs/core'`
  augmentation.
- `src/index.ts` + `index.surface.test.ts` locking the public surface.

### 3.2 Adapter mapping (ResolvedRequest → Responses API)

- Messages/system → Responses `input` items + `instructions` (system).
- `Part` mapping: text passes through. `InlineMediaPart` images (jpg/png,
  ≤ 20 MiB) → `input_image` base64 data URL. `FileUriPart` is a
  provider-hosted file reference (e.g. a Gemini Files URI — types.ts:69) and is
  NOT portable to xAI: only explicit public `http`/`https` URLs are admitted as
  `input_image` URLs; any other scheme or provider-scoped URI → `bad_request`.
  Non-image media, oversize images, wrong mime → `bad_request` (reject, don't
  map).
- Structured output: `outputJsonSchema` → `text.format`/`response_format`
  json_schema (exact field per live openai-node types); JSON-parse into
  `rawStructured`; engine still never validates shape (ADR-009).
- Reasoning: `ReasoningIntent.effort` → `reasoning: { effort }` per the model's
  `admittedReasoningEfforts`. `budgetTokens` → `bad_request` (level-style model).
  `includeThoughts` → request reasoning summaries if the API supports it;
  captured into `reasoningText` when present.
- `providerOptions.xai.promptCacheKey` → `prompt_cache_key`.
- Statelessness: `store: false` on every request (our design is stateless; no
  30-day server-side conversation storage). `previous_response_id` unsupported →
  not exposed.
- Sampling: `temperature`/`topP` admitted per schema; penalties/stop never
  admitted (schema rejects — matches xAI hard rejection).
- Usage mapping (GROSS, ADR-004): `input_tokens` (incl. cached),
  `output_tokens` (incl. reasoning); `cachedInputTokens` from
  `input_tokens_details.cached_tokens`; `thinkingTokens` from
  `output_tokens_details.reasoning_tokens`; full raw payload into `Usage.raw`;
  xAI extras (`num_sources_used`, server-side tool counts, `cost_in_usd_ticks`
  if present) into `Usage.details`/`providerMetadata` — captured, not billed.
- Errors: one try/catch around client build + call; openai-node `APIError`
  status/headers (retry-after) → `classifyHttpStatus`/`classifyError`; rethrown
  as `LlmError` tagged `provider: 'xai'`. Mid-generation content-filter/refusal
  finish states → `content_filter`.
- Timeouts: engine-provided `attemptTimeoutMs`/signal only; SDK timeout
  effectively disabled.

### 3.3 Model descriptor `grok-4.5`

```
provider: 'xai', model: 'grok-4.5', pricingFamily: 'grok-4.5'
capabilities: {
  reasoning: true, reasoningApi: 'level',
  admittedReasoningEfforts: pending live check (§5.4): ['low','high'] or incl. 'none',
  structuredOutput: true, nativeStructuredOutput: true,
  vision: true, audioInput: false,
  sampling: 'tunable',
  caching: { explicit: false, minTokens: 0 },  // automatic caching — exact shape
                                               // may need a capabilities tweak;
                                               // decide at implementation, keep
                                               // it in the xai package
  grounding: false,                            // server-side tools deferred
}
```

Strict Zod schema (`z.strictObject`): `temperature`, `topP`, `maxOutputTokens`,
`reasoning` effort enum, `providerOptions.xai.promptCacheKey?: string`. No
penalties, no stop, no serviceTier. `.meta()` titles/descriptions/examples like
the Gemini schemas. Aliases (`grok-4.5-latest`, `grok-build-latest`) are NOT
registered — one canonical id, "reject don't map" (callers use `grok-4.5`).

### 3.4 Pricing

`XAI_PRICING['grok-4.5'] = { inputPerM: 2_000_000, cachedPerM: 500_000,
outputPerM: 6_000_000 }` (µUSD/M convention as core). No tiers (`TIER_FACTOR` is
Google-owned; xAI source prices standard only). `gt200k` long-context lane added
ONLY after live verification (§5.4); until then omitted and documented.
`xaiPricingSource()` versioned with snapshot date.

### 3.5 Explicitly deferred (documented in ADR/plan, not built)

- Server-side agentic tools (web_search/x_search/code_interpreter/MCP) and their
  per-invocation billing — no `Cost` lane exists; usage captured raw for
  backfill. Revisit with the function-calling seam.
- `/v1/chat/completions` (legacy) and `/v1/messages` (Anthropic shim).
- Batch API (grok-4.5 not eligible at launch), image generation models,
  stateful conversations (`store`, `previous_response_id`), streaming (core has
  no streaming seam yet).

### 3.6 Wiring & tests

- vitest alias `@gullabs/xai` → source index; tsconfig references; workspace.
- Add `packages/xai/src` to the `no-ambient-auth` source scan.
- `makeFakeXai` in `@gullabs/testing` (structural fake of `XaiClientLike`),
  mirroring `makeFakeGemini`.
- Tests: adapter unit tests (mapping matrix incl. every reject path), negative
  contract fixtures, adapter-stress parity with google where applicable,
  `assertRegistryInvariants` wiring, surface test, pricing tests
  (cached-token math, unpriced-model null path).
- Coverage must hold global gates (93/91/96/93).
- Changeset; README for the package following google/claude-cli style.

## 4. Process & quality gates (A++ bar)

1. **Plan signoff**: codex adversarial review of this document. No
   implementation until VERDICT is approval.
2. **Commit discipline**: work lands as a sequence of small, logically scoped
   commits on `feat/provider-plugin-architecture` (Phase 1) and a follow-up
   branch/PR for Phase 2. **Every commit gets a codex adversarial review
   (read-only, `git show <sha>`) and must receive signoff before the next commit
   builds on it.** Findings are fixed in place (amend/fixup) until codex
   approves.
3. **Per-commit local gate**: `pnpm quality` (build, eslint, tsc typecheck,
   vitest with coverage thresholds) green before a commit is even submitted for
   codex review. `pnpm typecheck` runs explicitly — vitest does not check types.
4. **Implementation delegation**: all code/doc edits by sonnet subagents with
   file-scoped prompts derived from this plan; the orchestrator reviews diffs,
   runs gates, and drives codex reviews.
5. **Live verification** (§5.4) before pricing/effort decisions are frozen.
6. Final: full-branch codex signoff + PR; CI (gitleaks, audit, quality) green;
   PR references ADR-023 and this plan.

### Planned Phase 1 commit sequence (each codex-signed)

1. `feat!: ProviderOptionsMap module augmentation; google owns its options type`
2. `feat: ProviderPlugin + composeProviders composition helper`
3. `feat!: provider-neutral service tiers (opaque serviceTier, string[] serviceTiers, descriptor-driven retry pinning); flexFallback into providerOptions.google; drop engine guard`
4. `feat!: move all Google model configs, descriptors, pricing, types into @gullabs/google`
   — includes IN THE SAME COMMIT: the any-llm facade surface decision + updated
   `index.surface.test.ts` (any-llm, core, google), and rewrites of
   `packages/core/README.md`, `packages/any-llm/README.md`,
   `packages/any-llm/skills/any-llm/SKILL.md` to the plugin composition, so the
   commit is independently green with no stale public guidance.
5. `feat: shared assertRegistryInvariants in @gullabs/testing; wire all providers`
6. `docs: ADR-023 provider-plugin architecture; DESIGN/architecture updates; changeset`

### Planned Phase 2 commit sequence (each codex-signed)

1. `feat: @gullabs/xai package skeleton, client port, provider options augmentation`
2. `feat: xai adapter — Responses API mapping, errors, usage`
3. `feat: grok-4.5 descriptor, strict config schema, pricing source`
4. `feat: xaiProvider plugin, testing fakes, registry invariants, fixtures`
5. `docs: xai provider docs, README, changeset`

## 5. Risks & open items

1. **Module augmentation resolution** across build/vitest-alias contexts —
   mitigated by explicit type-level tests (§2.1); if augmentation proves
   unreliable, fallback is a core-owned open-but-typed pattern decided with
   codex at review time (not silently).
2. **Coverage displacement**: moving Gemini tests out of core changes package
   coverage distribution; global thresholds still apply — watch for core
   dropping below gates once its largest test surface moves; add generic-machinery
   tests if needed.
3. **openai-node minor churn** (~weekly minors): pin behavior with an
   integration-shaped fixture test against recorded response payloads; `^6`
   range.
4. **Live verifications — RESOLVED.** All five items were live-verified with
   `XAI_API_KEY` before the corresponding Phase 2 commits and are now shipped
   in `packages/xai/src/pricing.ts` and
   `packages/xai/src/model-config/grok-4-5.ts`:
   (a) **>200k long-context pricing tier: CONFIRMED exists.** $4.00/$1.00
   (cached)/$12.00 per million tokens above 200,000 GROSS input tokens (vs.
   $2.00/$0.50/$6.00 standard) — see `XAI_PRICING['grok-4.5'].gt200k` in
   `packages/xai/src/pricing.ts`, selected via `selectRates()` on GROSS
   `inputTokens` strictly greater than `LONG_CONTEXT_THRESHOLD = 200_000`.
   (b) **`reasoning.effort: 'none'` accepted?: REJECTED.** Live verification
   confirmed only `'low'` and `'high'` are accepted by the API; `'none'` and
   `'medium'` are rejected — see `admittedReasoningEfforts`/the
   `reasoning.effort` enum (`z.enum(['low', 'high'])`) in
   `packages/xai/src/model-config/grok-4-5.ts`.
   (c) **Exact Responses structured-output field shape: confirmed as
   `text.format`**, with `{ type: 'json_schema', name, schema, strict: true }`
   — NOT `response_format` (OpenAI's own convention on chat completions). See
   the "Structured output → text.format (NOT response_format)" mapping block
   in `packages/xai/src/adapter.ts`.
   (d) **Usage field names for cached/reasoning tokens: confirmed.**
   `cachedInputTokens` is read from `usage.input_tokens_details.cached_tokens`
   and `thinkingTokens` from `usage.output_tokens_details.reasoning_tokens`
   (both top-level `input_tokens`/`output_tokens` are already GROSS, per
   ADR-004) — see `mapUsage()` in `packages/xai/src/adapter.ts`.
   (e) **Max output tokens: confirmed no artificial ceiling.** xAI accepts
   arbitrarily large `max_output_tokens` values; truncation is surfaced via
   response `status: 'incomplete'` with
   `incomplete_details.reason === 'max_output_tokens'`, mapped to
   `finishReason: 'length'` (not an error) — see `mapFinishReason()` in
   `packages/xai/src/adapter.ts`.
5. **EU unavailability** and region routing: no code impact (host concern);
   documented in package README.
6. **Hallucination-rate regression on grok-4.5** (AA report): not a library
   concern; noted for consumers in README.

## 6. Phase 3 — Adoption-Gap Closures (consumer feedback)

This phase was **not scoped in the original plan above** (§0–§5 describe only
Phase 1 core-refactor and Phase 2 xai work). It closes gaps identified after
Phase 1/2 shipped, driven directly by consumer feedback. Three commits landed
under this phase: `fea6496`, `e969d7f`, `51dd5ce` (see the commit sequence in
the status header above).

### 6.1 P3-1 — countTokens port + GoogleCacheStore pre-flight

Addresses consumer GAP 1 — no way to count tokens for a prospective request
without generating.

- **New optional port**: `ProviderAdapter.countTokens(req, ctx)` in
  `packages/core/src/ports.ts`, alongside new `TokenCountRequest` (`provider`,
  `model`, optional `system`, `messages` — deliberately narrower than
  `ResolvedRequest`: no `config`, no `outputJsonSchema`, no `modelDescriptor`)
  and `TokenCount` (`totalTokens`, optional `details` breakdown, `raw` payload
  verbatim) types.
- **New engine method**: `Client.countTokens` in `packages/core/src/engine.ts`
  mirrors `generate()`'s auth/signal/registry/routing semantics exactly, but
  performs **no cost computation and no sink/record emission** — it is a
  metadata query only. It emits `llm.count_tokens.{start,success,error}`
  logger events (no call-record persistence). Throws if the resolved
  adapter does not implement `countTokens`.
- **Google implementation**: `geminiAdapter` in `packages/google/src/adapter.ts`
  implements `countTokens` via `@google/genai`'s `models.countTokens`,
  sharing the message→contents mapping with `run()` through the extracted
  `mapMessagesToGeminiContents` helper. `ctx.signal` propagates via
  `config.abortSignal`, and SDK errors are classified identically to `run()`.
- **GoogleCacheStore pre-flight gate**: `packages/google/src/cache-store.ts`'s
  `GoogleCacheStore.create()`/`getOrCreate()` gain an optional `preflight`
  option (`{ minTokens, countTokens }`) — a token-count gate enforced **once**
  before any SDK call, covering both the direct `create()` path and the
  coalesced `getOrCreate()` path. If the counted tokens fall below
  `minTokens`, `create()`/`getOrCreate()` reject before ever calling the
  provider.
- **Breaking addition (P0, no compat shim)**: `GeminiClientLike.countTokens`
  becomes a **required** method on the structural fake interface in
  `packages/testing/src/fake-gemini.ts` — all existing fakes must implement
  it; there is no back-compat shim for callers still constructing a fake
  without it.

### 6.2 P3-2 — geminiContentToMessages converter

Addresses consumer GAP 3 — no supported path for migrating hand-authored
`@google/genai` prompts onto any-llm's normalized request shape.

`packages/google/src/content-to-messages.ts` exports
`geminiContentToMessages({ contents, systemInstruction? })`, converting
hand-authored `@google/genai` `Content[]`/`Part[]` prompts into any-llm's
normalized `{ system?, messages }` shape, for migration use cases only (not
used internally by `run()`/`countTokens()`).

Reject-don't-map throughout, exactly per the P0 house rule:

- **Role mapping has no inference**: `Content.role` must be exactly `'user'`
  or `'model'` (mapped to `'user'`/`'assistant'`); a missing or unrecognized
  role throws `LlmError('bad_request')`.
- **`system` is derived only from the explicit `systemInstruction` input** —
  never inferred from `contents`. A `systemInstruction` may be a plain string
  or a `Content` whose only defined key is `parts`, and whose parts must be
  text-only.
- **Unsupported part-kinds and sub-fields throw `LlmError('bad_request')`
  naming the offending field**, via an exhaustive own-defined-key scan of
  each `Part`/`Content` rather than an allowlist-and-ignore pass. The
  documented (non-exhaustive-by-name, but exhaustively enforced) reject list
  includes: `functionCall`, `functionResponse`, `executableCode`,
  `codeExecutionResult`, tool-call/tool-response shapes, thought-flagged
  parts, `thoughtSignature`, `videoMetadata`, `partMetadata`,
  `inlineData.displayName`/`fileData.displayName`,
  `mediaResolution.numTokens`, and unknown `mediaResolution.level` enum
  values (only `MEDIA_RESOLUTION_LOW`/`MEDIUM`/`HIGH` map to
  `'low'`/`'medium'`/`'high'`). Nothing is ever silently dropped.
  _Superseded in part (ADR-029 addendum):_ `functionCall`, `functionResponse` and `thoughtSignature`
  are no longer in the reject list; they convert to tool parts and an imported signature overlay.
- **No runtime SDK dependency**: `@google/genai` types (`Content`, `Part`) are
  imported with `import type` only — the converter has zero runtime coupling
  to the `@google/genai` package.

### 6.3 Error-taxonomy correction (landed alongside P3-1/P3-2 in `51dd5ce`)

`packages/google/src/cache-store.ts` and `packages/google/src/file-store.ts`
previously classified a malformed-provider-payload response (SDK call
succeeds, but the response is missing a required field) as `bad_request`
(caller fault). Per the `errors.ts` taxonomy, a malformed **provider**
payload is a **provider** fault, not a caller fault — both were corrected to
kind `'server'`, `provider: 'google'`. They stay `retryable: false`: the
affected paths are `create()`/`upload()`, which are side-effecting and not
idempotent — the provider may have already created the cache/file
server-side even though the payload carries no handle, so an automatic retry
could orphan or duplicate provider-side resources. This differs from the
read-only `adapter.countTokens` precedent, where a bad payload is safely
retryable. See commit `51dd5ce` ("feat: shared assertRegistryInvariants in
@gullabs/testing; provider-payload error taxonomy fixes") for the full
rationale and test updates.
