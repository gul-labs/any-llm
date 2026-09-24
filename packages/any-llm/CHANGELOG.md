# @gullabs/any-llm

## 0.10.1

### Patch Changes

- cb4980f: Raise runtime dependency floors: `zod` `^4.6.5` (was `^4.4.3`) in core, google, xai,
  claude-cli and codex-cli, and `@google/genai` `^2.23.0` (was `^2.19.0`) in any-llm. No API
  changes.
- Updated dependencies [cb4980f]
  - @gullabs/core@0.14.1
  - @gullabs/google@0.12.1

## 0.10.0

### Minor Changes

- 79bac18: Raise the supported runtime and narrow provider peer ranges.

  - **Breaking:** `engines.node` is now `>=22.12.0` on every published package. Node 20
    reached end of life in April 2026 and is no longer supported.
  - **Breaking:** `@gullabs/google` requires `@google/genai` `^2` (was `^1 || ^2`), and
    `@gullabs/any-llm` now depends on `@google/genai` `^2.19.0`.
  - **Breaking:** `@gullabs/xai` requires `openai` `^7` (was `^6 || ^7`).

  Development moves to Node 24 (`.nvmrc` pins 24.20.0) and pnpm 11.24.0; pnpm settings
  now live in `pnpm-workspace.yaml` rather than `package.json` and `.npmrc`.

### Patch Changes

- 79bac18: Point `repository.url`, `homepage`, and `bugs` at the canonical GitHub org path
  `gul-labs/any-llm`. The org was renamed from `GulLabs`; the old path still
  redirects in a browser, but npm provenance matches `repository.url` literally
  against the attestation's `sourceRepositoryURI`, so a redirect does not satisfy
  it and the next provenance publish would have failed the same way the earlier
  lowercase-casing incident did.

  The npm scope `@gullabs` is a separate namespace and is unchanged.

- Updated dependencies [79bac18]
- Updated dependencies [79bac18]
  - @gullabs/core@0.14.0
  - @gullabs/google@0.12.0

## 0.9.3

### Patch Changes

- Updated dependencies [6a5a662]
  - @gullabs/core@0.13.1
  - @gullabs/google@0.11.1

## 0.9.2

### Patch Changes

- 0521973: Breaking (pre-1.0): required `TokenCount.accuracy`, required `Cost.details.tools`, first-class `citations` on generate results and call records, and xAI Live Search tools.

  - `TokenCount.accuracy` is `'exact' | 'lower-bound'` (Google exact; xAI tokenize-text lower-bound). Non-text parts on xAI `countTokens` are `bad_request`.
  - `Cost.details` is `{ input, cached, output, tools }` with invariant `microUsd = input + cached + output + tools`. Google/CLI token pricing sets `tools: 0`.
  - `LlmResult` / `AdapterResult` / `LlmCallRecord` / drizzle persist `citations?: { url, title?, sourceName? }`. Empty arrays are omitted. Public `normalizeGroundingCitations` is deleted.
  - grok-4.5 admits `reasoning.effort` `low|medium|high` (live 2026-08-24). `providerOptions.xai.tools` admits `web_search` / `x_search`. xAI prices `web_search_calls` / `x_search_calls` / `document_search_calls` from live usage details.

- 0521973: Breaking (pre-1.0): function-calling seam (ADR-029). `FinishReason` includes `tool_calls`; `tool-call` / `tool-result` parts; `LlmRequest.tools` / `toolChoice`; `toolCalls` on results and records.

  No agent loop. `runStructured` + tools is `bad_request`. Google and grok-4.5/4.6 implement and gate on `functionCalling`. CLI adapters reject `tools` and the new part kinds. Google `countTokens` stays `exact` with tools; xAI `countTokens` rejects tools. xAI store:false replay is live-verified.

- Updated dependencies [0521973]
- Updated dependencies [0521973]
  - @gullabs/core@0.13.0
  - @gullabs/google@0.11.0

## 0.9.1

### Patch Changes

- 90a47a1: Classify xAI safety-check HTTP 403 (`Content violates usage guidelines` / `SAFETY_CHECK_TYPE_*`) as `content_filter` instead of `invalid_auth`. HTTP status is a hint; adapters overlay from the structured body only. A bare 403 stays `invalid_auth`. Core JSDoc and the packaged skill document the default-vs-overlay rule.
- Updated dependencies [90a47a1]
  - @gullabs/core@0.12.1
  - @gullabs/google@0.10.1

## 0.9.0

### Minor Changes

- 2ab1ea6: Add `grok-4.6` with live-verified reasoning (`low`/`medium`/`high`/`xhigh`) and `serviceTier: 'priority'`. Widen core `ReasoningEffort` with `'xhigh'`. Refresh xAI pricing (`xai-2026-08-12`: 4.5 cached $0.30/$0.60; 4.6 $2/$0.50/$6 and $4/$1/$12) and re-verify Gemini snapshot (`gemini-2026-08-12`; registered-model rates unchanged). xAI `price()` now receives the served tier (`'default'` | `'priority'`) instead of `undefined`; custom xAI pricing sources must price `'default'` at the standard list.

### Patch Changes

- Updated dependencies [2ab1ea6]
  - @gullabs/core@0.12.0
  - @gullabs/google@0.10.0

## 0.8.7

### Patch Changes

- Updated dependencies [4458ce7]
  - @gullabs/google@0.9.1

## 0.8.6

### Patch Changes

- Updated dependencies [09010db]
  - @gullabs/google@0.9.0

## 0.8.5

### Patch Changes

- Updated dependencies [d46fd27]
  - @gullabs/core@0.11.0
  - @gullabs/google@0.8.4

## 0.8.4

### Patch Changes

- Updated dependencies [a3f74be]
  - @gullabs/core@0.10.0
  - @gullabs/google@0.8.3

## 0.8.3

### Patch Changes

- Updated dependencies [c89f6f3]
  - @gullabs/google@0.8.2

## 0.8.2

### Patch Changes

- 20453fc: Input contracts: strict template interpolation, opt-in `inputSchema`/`inputContract`
  validation, and pre-attempt ledger rows for refused calls (ADR-025).

  **Breaking changes:**

  - Strict template interpolation is now the unconditional default. Every `{{var}}`
    placeholder referenced by `callSite.system`/`callSite.userTemplate` must have a
    string-typed value present in `vars`, or `runStructured` refuses the call with
    `LlmError('bad_request')` before any request is built — templates that previously
    dispatched with literal `{{placeholder}}` text left in place now fail locally instead.
    There is no opt-out and no preserved fallback.
  - Pre-attempt refusals now write zero-usage `attemptNumber: 0` ledger rows. Any
    `LlmError` thrown inside `runPipeline` after `callId` allocation but before the first
    attempt runs — including `@gullabs/quota` denials, with no `@gullabs/quota` code
    changes — produces a synthetic `LlmCallRecord` (`attemptId` derived by the existing
    first-attempt idempotency rule: `request.idempotencyKey` when supplied, minted
    otherwise). Refusals that previously left no ledger row now appear as one.

  **New features:**

  - `CallSite.inputSchema?: StandardSchemaV1` — validates `vars` before interpolation,
    so a missing business field surfaces as the schema's own error.
  - `LlmRequest.inputContract?: { schema: StandardSchemaV1; value: unknown }` — the
    equivalent opt-in contract for the `generate()` path; validated once per logical
    call, before `@gullabs/quota` and before the retry middleware.
  - `createClient({ requireInputContract: true })` — fleet-wide toggle requiring every
    call to carry a contract (`inputSchema` on `runStructured`, `inputContract` on
    `generate()`).
  - `LlmErrorOptions.issues` / `LlmError.issues` — structured `{ path, message }[]`
    validation failures, populated by both input-contract paths and by model-config
    validation.

  See ADR-025 in `DECISIONS.md` for the full design and the row-less/ledgered boundary
  table.

- b2b7f8c: docs: host-owned factory wiring example
- Updated dependencies [20453fc]
  - @gullabs/core@0.9.0
  - @gullabs/google@0.8.1

## 0.8.1

### Patch Changes

- af00325: Updates the `any-llm` skill (`packages/any-llm/skills/any-llm/SKILL.md`) with a new section documenting the 2026-07-09 live-verified finding that xAI's structured-output `strict: true` performs no OpenAI-style compile-time schema validation, and describing `@gullabs/codex-cli`'s opt-in `toOpenAiStrictOutputSchema` transformer and local `assertOpenAiStrictOutputSchema` preflight for its own `--output-schema` backend contract — making clear that contract is specific to codex-cli and not applied to xai.

## 0.8.0

### Minor Changes

- 0b44a5e: Provider-plugin architecture: `@gullabs/core` becomes provider-agnostic (zero Google/Gemini/Gemma knowledge), provider packages own their model configs, pricing, and options types, and wiring goes through a new `composeProviders()` seam. New `@gullabs/xai` package adds a Grok provider (breaking, pre-1.0).

  **Breaking changes:**

  - `ProviderOptions` is removed as a closed type. It is replaced by an extensible `ProviderOptionsMap` interface; provider packages declare their own options via module augmentation (`declare module '@gullabs/core' { interface ProviderOptionsMap { google?: GoogleProviderOptions } }`).
  - `GenConfig.serviceTier` widens from Google's literal union `'flex' | 'standard'` to an opaque provider-defined `string`; `ModelDescriptor.capabilities.serviceTiers` widens to `readonly string[]`. Retry tier pinning (`revalidatePinnedServiceTier`) is now descriptor-driven instead of hardcoding Google's tier vocabulary.
  - `GenConfig.flexFallback` is removed from core. It now lives under `providerOptions.google.flexFallback`, admitted only by the flex branch of each Gemini model's config schema.
  - `@gullabs/core` no longer exports any Google/Gemini/Gemma-named symbol: `GoogleProviderOptions`, `GoogleSafetySetting`, `GoogleSearchTool`, the Gemini/Gemma model descriptors and config schemas, `GEMINI_PRICING`, `TIER_FACTOR`, `geminiPricingSource`, and `defaultGeminiRegistry` all move to `@gullabs/google`. They remain available from `@gullabs/any-llm`, which re-exports both `@gullabs/core` and `@gullabs/google`.
  - `ClientConfig.modelRegistry` is now required — there is no default registry. Build one via `composeProviders()`.
  - `GeminiClientLike.countTokens` is now a required method on the structural client interface. Anyone building a custom fake against this interface (including via `@gullabs/testing`) must implement it.

  **New features:**

  - New `@gullabs/xai` package: an xAI Grok provider adapter (`xaiProvider()`) with `grok-4.5` on the Responses API — reasoning (`low`/`high` effort), native structured output, vision, automatic caching via `promptCacheKey`, and live-verified pricing including the >200k long-context tier.
  - New `ProviderPlugin` interface and `composeProviders()` helper in `@gullabs/core` — the standard way to wire one or more provider packages into `createClient`: `createClient({ ...composeProviders([googleProvider(), xaiProvider()]) })`.
  - New `Client.countTokens()` — dry-run token counting with no generation and no billing, implemented for Google via `@google/genai`'s `models.countTokens`.
  - `GoogleCacheStore` gains an optional token-count preflight gate before cache creation.
  - New `geminiContentToMessages()` migration utility in `@gullabs/google` for converting hand-authored `@google/genai` prompts into any-llm's normalized message shape.
  - New `assertRegistryInvariants()` shared test helper in `@gullabs/testing` for provider-package model-onboarding tests (schema-artifact completeness, JSON-schema staleness, pinned model-id lists, pricing coverage, fixture-list membership).
  - New `claudeCliProvider()` / `codexCliProvider()` plugin factories for the existing dev-only CLI provider packages, so they compose the same way as API-backed providers.

  **Migration notes:**

  Wire providers through `composeProviders()` instead of constructing `adapters`/`modelRegistry`/`pricingSources` by hand:

  ```ts
  import { createClient, composeProviders } from '@gullabs/core'
  import { googleProvider } from '@gullabs/google'

  const client = createClient({
    ...composeProviders([googleProvider()]),
  })
  ```

  Flex-fallback configuration moves to `providerOptions.google.flexFallback` on the request.

### Patch Changes

- Updated dependencies [0b44a5e]
  - @gullabs/core@0.8.0
  - @gullabs/google@0.8.0

## 0.7.0

### Minor Changes

- ba21620: Provider-qualified model identity — explicit `(provider, model)` everywhere (breaking, pre-1.0).

  - `LlmRequest`, `CallSite`, and `ResolvedRequest` now require a top-level `provider: string`; `model` stays the bare provider-native string forwarded verbatim to SDKs/CLIs. Bare requests without a provider, unregistered `(provider, model)` pairs, and slash-style `'provider/model'` strings are rejected with `bad_request`.
  - `ModelRegistry` is keyed by `(provider, model)`: `resolve(provider, model)`, `ModelDescriptor.id` renamed to `model`, duplicate exact pairs throw, the same bare model may exist under multiple providers with different config schemas, and prefix matching never crosses providers.
  - Routing is always by `req.provider`: the single-adapter bypass is removed, custom `route(provider, model, adapters)` results are checked against `adapter.id === req.provider`, and `createClient` verifies every registry descriptor's provider has a matching adapter.
  - Pricing composes per provider: `ClientConfig.pricing` is replaced by `pricingSources: Record<provider, PricingSource>`; the port shape is unchanged and `geminiPricingSource()` is the google-scoped source. A provider without a source yields an unpriced result with a warning.
  - Telemetry events carry `provider`; quota's `providerQuotaMiddleware` reads `req.provider` from the request (the `provider` option is removed).

### Patch Changes

- Updated dependencies [ba21620]
  - @gullabs/core@0.7.0
  - @gullabs/google@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [e3da339]
  - @gullabs/core@0.6.0
  - @gullabs/google@0.6.1

## 0.6.0

### Minor Changes

- b39ceac: Document the breaking strict model-config contract ahead of release.

  Built-in descriptors are moving to a descriptor-owned schema boundary:
  `descriptor.configSchema` is the runtime source of truth, `descriptor.configJsonSchema`
  is derived from it for forms, and callers should stop depending on exported
  repair helpers or broad JSON-schema-only config flows.

  The docs now call out the related behavior changes that must be handled at the
  same boundary:

  - omit `serviceTier` to use provider-default request behavior, and set `flex`
    explicitly when Flex is required;
  - use `reasoning.effort` for Gemini 3 and Gemma level-based models instead of
    `reasoning.budgetTokens`;
  - remove `effort: 'none'` on models that cannot disable thinking, such as
    `gemini-3.1-pro-preview`;
  - stop using `providerOptions.google` as an override lane for descriptor-owned
    fields;
  - continue treating `priority` as rejected until the library ships verified
    pricing, served-tier recording, and tests for it.

### Patch Changes

- Updated dependencies [b39ceac]
  - @gullabs/core@0.5.0
  - @gullabs/google@0.6.0

## 0.5.1

### Patch Changes

- 78b7636: Fix bugs found in a second round of independent Codex adversarial review, run
  against the commits from the previous two releases:

  - `@gullabs/core`: `resolveReasoning()` now rejects negative, non-integer, `NaN`,
    and `Infinity` `budgetTokens` with a deterministic `bad_request` `LlmError`
    instead of silently mapping them to a valid reasoning effort. The Gemini
    config JSON Schema's `reasoning.budgetTokens` property now also declares
    `minimum: 0` for defense-in-depth consistency with the same check.
  - `@gullabs/google`: `normalizeGroundingCitations()` now only produces
    citations for `http:`/`https:` URLs with a non-empty hostname, skipping
    malformed/unsafe schemes (e.g. `javascript:`, `mailto:`) instead of
    including them in the returned citation list.
  - `@gullabs/any-llm`: fixed the shipped skill's `Cost.microUsd` nullability
    comment (it's `number | null`, not `number | undefined`).

- Updated dependencies [78b7636]
  - @gullabs/core@0.4.3
  - @gullabs/google@0.5.2

## 0.5.0

### Minor Changes

- c1aa7ad: Open-source documentation pass: rewrote the root README and all package READMEs for
  accuracy and consistency, fixed stale content in DESIGN.md/SPEC.md/docs/architecture.md
  left over from the forward-only structured-output migration, restructured the root
  CHANGELOG.md to point at each package's own changelog, archived internal planning docs
  into `docs/archive/`, and scrubbed a private host name from a `@gullabs/core` source
  comment (no behavior change).

  `@gullabs/any-llm` also ships a new Agent Skill at `skills/any-llm/SKILL.md` teaching AI
  coding assistants (e.g. Claude Code) how to use this library correctly — per-call auth,
  the forward-only structured-output contract, error handling, and common mistakes.

### Patch Changes

- Updated dependencies [c1aa7ad]
  - @gullabs/core@0.4.2
  - @gullabs/google@0.5.1

## 0.4.1

### Patch Changes

- Updated dependencies [dab0792]
  - @gullabs/core@0.4.1
  - @gullabs/google@0.5.0

## 0.4.0

### Minor Changes

- Implement the adoption backlog: add core reasoning resolution exports, pricing-source introspection
  and construction-time strict pricing, unpriced-cost warnings, queue-delay attribution on results and
  records, Drizzle `queue_delay_ms`, hardened quota deny/defer decisions, service-tier re-validation
  after Google provider-options merge, and deterministic testing support for rate-limiter wait time.

  Docs now cover ledger sidecar transaction composition, `metadata.operationId` correlation for
  grounded-to-structured workflows, multi-runtime retry caveats, and caller-owned structured-output
  validation.

### Patch Changes

- Updated dependencies
  - @gullabs/core@0.4.0
  - @gullabs/google@0.4.0

## 0.3.0

### Minor Changes

- ea4b941: Implement the integration-fixes API cleanup across structured output, ledger identity, Gemini Flex fallback, and API-verified Gemma 4 routing.

  Breaking API changes:

  - Replace Standard Schema/Zod output validation with forward-only `output.jsonSchema`. The library forwards the JSON Schema hint to providers, JSON-parses native structured output, surfaces `outputParsed`, and leaves business validation to callers.
  - Remove `InferOutput`, generic `LlmRequest`/`LlmResult` output typing, `output.schema`, `parse_error`, and `zodToGeminiSchema`.
  - Make `attemptId` the durable ledger identity. The drizzle schema now uses `attempt_id` as the primary key, removes the redundant UUID `id`, and adds `external_id`, `served_service_tier`, and `output_parsed`.
  - Add `idempotencyKey` and `externalId` request correlation fields. `idempotencyKey` is ledger idempotency only; provider calls are not deduplicated.
  - Add provider-builtin Gemini Flex fallback to standard tier on capacity pressure, with `servedServiceTier` returned and persisted so cost/retry logic uses the tier actually served.

  Gemini/Gemma routing changes:

  - Add API-verified Gemma 4 routing (`gemma-4-31b-it`, `gemma-4-26b-a4b-it`) with thinking(level), grounding, native structured output, and vision.
  - Add `nativeStructuredOutput`, `serviceTiers`, `vision`, and `audioInput` capability flags with per-model service-tier gating.

  Only two Gemma 4 model IDs are confirmed callable via the live Google Gemini API. All previously listed IDs (e2b, e4b, 12b variants, google/ aliases) return HTTP 404 and are removed. Both verified models support native structured output (responseMimeType + responseSchema), grounding, vision, and thinkingLevel reasoning. thinkingBudget is rejected by the API with HTTP 400 and is not used.

  Gemma 4 reasoning effort is now constrained to `none`/`high` only (`low`/`medium` are rejected at validation time with a `bad_request` error). This reflects live API behaviour: the models only accept MINIMAL and HIGH `thinkingLevel` values; LOW and MEDIUM return HTTP 400.

  gemini-3.1-pro-preview now rejects effort: 'none' at validation time; the model has no MINIMAL thinking level (thinkingLevel MINIMAL returns HTTP 400).

### Patch Changes

- 4e37a05: Derive `ANY_LLM_VERSION` from package.json so it no longer drifts from the package version.
- Updated dependencies [ea4b941]
  - @gullabs/core@0.3.0
  - @gullabs/google@0.3.0

## 0.2.0

### Minor Changes

- 6e246d2: Add the batteries-included `@gullabs/any-llm` package as the default one-package install path for Gemini users.

  The new aggregate package depends on the core engine, Google adapter, Google GenAI SDK, and Zod, then re-exports the common public API from one entrypoint. The Google adapter now also declares its runtime Zod peer dependency explicitly for modular installs.

### Patch Changes

- Updated dependencies [6e246d2]
- Updated dependencies [8f1bf61]
  - @gullabs/google@0.2.0
  - @gullabs/core@0.2.0
