# @gullabs/xai

## 0.7.1

### Patch Changes

- cb4980f: Raise runtime dependency floors: `zod` `^4.6.5` (was `^4.4.3`) in core, google, xai,
  claude-cli and codex-cli, and `@google/genai` `^2.23.0` (was `^2.19.0`) in any-llm. No API
  changes.
- Updated dependencies [cb4980f]
  - @gullabs/core@0.14.1

## 0.7.0

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

## 0.6.1

### Patch Changes

- 6a5a662: Fix Codex WS-C follow-ups: file-ref attachment pricing is estimated until the counter is live-pinned; Google toolCallId uses provider `functionCall.id` (or a unique per-name suffix) and replays it; requested tool names/count persist alongside generationConfig.
- Updated dependencies [6a5a662]
  - @gullabs/core@0.13.1

## 0.6.0

### Minor Changes

- 0521973: Breaking (pre-1.0): required `TokenCount.accuracy`, required `Cost.details.tools`, first-class `citations` on generate results and call records, and xAI Live Search tools.

  - `TokenCount.accuracy` is `'exact' | 'lower-bound'` (Google exact; xAI tokenize-text lower-bound). Non-text parts on xAI `countTokens` are `bad_request`.
  - `Cost.details` is `{ input, cached, output, tools }` with invariant `microUsd = input + cached + output + tools`. Google/CLI token pricing sets `tools: 0`.
  - `LlmResult` / `AdapterResult` / `LlmCallRecord` / drizzle persist `citations?: { url, title?, sourceName? }`. Empty arrays are omitted. Public `normalizeGroundingCitations` is deleted.
  - grok-4.5 admits `reasoning.effort` `low|medium|high` (live 2026-08-24). `providerOptions.xai.tools` admits `web_search` / `x_search`. xAI prices `web_search_calls` / `x_search_calls` / `document_search_calls` from live usage details.

- 0521973: Breaking (pre-1.0): function-calling seam (ADR-029). `FinishReason` includes `tool_calls`; `tool-call` / `tool-result` parts; `LlmRequest.tools` / `toolChoice`; `toolCalls` on results and records.

  No agent loop. `runStructured` + tools is `bad_request`. Google and grok-4.5/4.6 implement and gate on `functionCalling`. CLI adapters reject `tools` and the new part kinds. Google `countTokens` stays `exact` with tools; xAI `countTokens` rejects tools. xAI store:false replay is live-verified.

### Patch Changes

- Updated dependencies [0521973]
- Updated dependencies [0521973]
  - @gullabs/core@0.13.0

## 0.5.1

### Patch Changes

- 90a47a1: Classify xAI safety-check HTTP 403 (`Content violates usage guidelines` / `SAFETY_CHECK_TYPE_*`) as `content_filter` instead of `invalid_auth`. HTTP status is a hint; adapters overlay from the structured body only. A bare 403 stays `invalid_auth`. Core JSDoc and the packaged skill document the default-vs-overlay rule.
- Updated dependencies [90a47a1]
  - @gullabs/core@0.12.1

## 0.5.0

### Minor Changes

- 2ab1ea6: Add `grok-4.6` with live-verified reasoning (`low`/`medium`/`high`/`xhigh`) and `serviceTier: 'priority'`. Widen core `ReasoningEffort` with `'xhigh'`. Refresh xAI pricing (`xai-2026-08-12`: 4.5 cached $0.30/$0.60; 4.6 $2/$0.50/$6 and $4/$1/$12) and re-verify Gemini snapshot (`gemini-2026-08-12`; registered-model rates unchanged). xAI `price()` now receives the served tier (`'default'` | `'priority'`) instead of `undefined`; custom xAI pricing sources must price `'default'` at the standard list.

### Patch Changes

- Updated dependencies [2ab1ea6]
  - @gullabs/core@0.12.0

## 0.4.1

### Patch Changes

- 4458ce7: Dependency upgrades: test against `openai@7` and `@google/genai@2.16`; widen xAI peer to `openai ^6 || ^7`.

## 0.4.0

### Minor Changes

- 09010db: File-store fail-closed delete + xAI Files host ergonomics.

  - `XaiFileStore` / `GoogleFileStore`: `delete(id, { failClosed?: boolean, signal? })` — default fail-open; opt-in throw on non-not-found failures; empty id always `bad_request`; 404 success both modes.
  - `@gullabs/testing`: `FakeXaiFileStore` in-memory store with TTL clock and fail-closed delete.
  - Docs: multi-provider install (core + google + xai + peers); attachment_search counters visible on `usage.details` / `usage.raw`.

## 0.3.0

### Minor Changes

- d46fd27: Add xAI Files store (`XaiFileStore`) and core `FileRefPart` for provider-hosted file ids.

  - `@gullabs/core`: new `FileRefPart` (`kind: 'file-ref'`) + `isFileRefPart` guard on the `Part` union.
  - `@gullabs/xai`: `XaiFileStore` (upload with TTL, get, list, idempotent delete, content); adapter maps `file-ref` → Responses `input_file.file_id`; rejects Gemini Files URIs.
  - `@gullabs/google`: reject `file-ref` with clear `bad_request` (Gemini uses `FileUriPart` URIs).

### Patch Changes

- Updated dependencies [d46fd27]
  - @gullabs/core@0.11.0

## 0.2.5

### Patch Changes

- Updated dependencies [a3f74be]
  - @gullabs/core@0.10.0

## 0.2.4

### Patch Changes

- c89f6f3: Fix a live-observed correctness defect: transport-level connection failures (the `openai` SDK's `APIConnectionError` / `APIConnectionTimeoutError`, thrown as `"Connection error."` when the request never reaches xAI's servers, plus Node/undici errno signatures like `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE`, `socket hang up`, and `fetch failed`) previously fell through `classifyXaiError`'s generic HTTP-status classification to `kind: 'unknown', retryable: false`. Temporal treats `retryable: false` as fatal, so a transient network blip was killing host workflow runs outright instead of being retried (observed live 2026-07-10).

  These are now reclassified `kind: 'server', retryable: true` — the same "provider fault, not caller fault, safe to retry" bucket this adapter already uses elsewhere for provider-side failures with no HTTP status. Detection matches the OpenAI SDK's error class by constructor name (avoiding a runtime import of `openai` outside `client.ts`), falls back to message/errno pattern matching, and also inspects a wrapped `.cause`. All prior classifications (auth, rate-limit, bad-request, timeout, content-filter) are unchanged.

## 0.2.3

### Patch Changes

- 8896b06: Fix a live-observed correctness defect: when the xAI Responses API returns multiple `type: 'message'` output items in one response (observed live: strict `json_schema` mode, `grok-4.5`, reasoning effort `high`, two complete JSON documents in two separate message items), the adapter previously concatenated `output_text` across ALL message items, producing corrupted, invalid-JSON text (`...}\n}{\n"..."`). This broke a downstream consumer's parse gate and killed a Temporal host run.

  The adapter now takes only the LAST `type: 'message'` output item's `output_text` parts as the result text, matching the Responses API convention that the final message item is the response and earlier ones are superseded. Joining multiple `output_text` parts _within_ a single message item is unchanged (that is legitimate segmentation, not duplication), and `reasoningText` assembly from `type: 'reasoning'` items is unaffected. When more than one message item is present, a `warnings` entry now names the dropped item count.

## 0.2.2

### Patch Changes

- Updated dependencies [20453fc]
  - @gullabs/core@0.9.0

## 0.2.1

### Patch Changes

- af00325: Docs + fixture + test only — zero adapter behavior change. Codifies the 2026-07-09 live-verified finding that xAI's `strict: true` on `text.format` json_schema performs no OpenAI-style compile-time schema validation (missing `additionalProperties: false`, optional properties, `format`/other keywords, `anyOf`, `$defs`/`$ref`, and nullable unions were all accepted with HTTP 200 across 13 single-variant live probes plus 1 combined probe, 14 calls total). Adds a fixture (`10-non-strict-schema-accepted.json`) and a fixture-backed test proving this adapter forwards schemas to xAI verbatim, and documents in the README that OpenAI-strict schema rewriting is unnecessary for xai as of that verification date.

## 0.2.0

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
