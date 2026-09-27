# Model Config Provider Evidence

Checked on 2026-07-05 for the strict model-config work tracked in
[`docs/model-config-strict-schema-implementation-plan.md`](./model-config-strict-schema-implementation-plan.md).

This file freezes the public-doc and live-probe evidence for the built-in
`generateContent` descriptors that the strict schema work is allowed to ship.
The table records the contract the library should admit, not every alias or
legacy field the provider may still accept.

The July 2026 matrix below is a historical freeze. `gemini-3.5-flash` and
`gemini-3-flash-preview` were deleted on 2026-09-25 and do not resolve. The
current catalog is the **2026-09-25 refresh** section.

## Evidence Matrix

| Model                    | API mode          | Reasoning API    | Admitted efforts for strict contract | Budget range / disable semantics                                                                                                       | Sampling mutability                                                         | Structured output | Structured output + tools                                          | Service tiers admitted by strict contract | Source / evidence notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------ | ----------------- | ---------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gemini-2.5-pro`         | `generateContent` | `thinkingBudget` | `low`, `medium`, `high`              | `128..32768`; disable not supported; provider default remains dynamic `-1` when unset                                                  | Tunable: `temperature`, `topP`, `topK`                                      | Yes               | No exact `generateContent` evidence; strict contract should reject | `flex`, `standard` only                   | Thinking budgets from [thinking guide](https://ai.google.dev/gemini-api/docs/generate-content/thinking). Model capabilities and current tier docs from [model page](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-pro). Provider docs also list `priority`, but the library keeps it out of schema until served-tier recording and pricing policy exist.                                                                                                                                                                                                                        |
| `gemini-2.5-flash`       | `generateContent` | `thinkingBudget` | `none`, `low`, `medium`, `high`      | `0..24576`; disable with `thinkingBudget = 0`; provider default remains dynamic `-1` when unset                                        | Tunable: `temperature`, `topP`, `topK`                                      | Yes               | No exact `generateContent` evidence; strict contract should reject | `flex`, `standard` only                   | Thinking budgets from [thinking guide](https://ai.google.dev/gemini-api/docs/generate-content/thinking). Model capabilities and current tier docs from [model page](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash). Provider docs also list `priority`, intentionally not admitted by the library yet.                                                                                                                                                                                                                                                                    |
| `gemini-2.5-flash-lite`  | `generateContent` | `thinkingBudget` | `none`, `low`, `medium`, `high`      | `512..24576`; disable with `thinkingBudget = 0`; provider default remains dynamic `-1` when unset                                      | Tunable: `temperature`, `topP`, `topK`                                      | Yes               | No exact `generateContent` evidence; strict contract should reject | `flex`, `standard` only                   | Thinking budgets from [thinking guide](https://ai.google.dev/gemini-api/docs/generate-content/thinking). Model capabilities and current tier docs from [model page](https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite). Provider docs also list `priority`, intentionally not admitted by the library yet.                                                                                                                                                                                                                                                               |
| `gemini-3.5-flash`       | `generateContent` | `thinkingLevel`  | `none`, `low`, `medium`, `high`      | No `budgetTokens` in strict contract; provider still documents legacy `thinkingBudget` compatibility, but the library should reject it | Fixed by contract; sampling knobs omitted from schema                       | Yes               | Yes                                                                | `flex`, `standard` only                   | Thinking levels and legacy-budget warning from [Gemini 3 guide](https://ai.google.dev/gemini-api/docs/generate-content/gemini-3). Model capabilities and current tier docs from [model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash). Structured-output-with-tools scope from [structured output guide](https://ai.google.dev/gemini-api/docs/generate-content/structured-output). Provider docs list `priority`; strict contract still rejects it.                                                                                                                |
| `gemini-3.1-flash-lite`  | `generateContent` | `thinkingLevel`  | `none`, `low`, `medium`, `high`      | No `budgetTokens` in strict contract; strict contract rejects the provider's legacy budget alias                                       | Fixed by contract; sampling knobs omitted from schema                       | Yes               | No exact `generateContent` evidence; strict contract should reject | `flex`, `standard` only                   | Stable model id and model capability page now exist at [model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite). Thinking levels from [Gemini 3 guide](https://ai.google.dev/gemini-api/docs/generate-content/gemini-3). Structured-output-with-tools guide only names `gemini-3.1-pro-preview` and `gemini-3.5-flash`, so Flash-Lite stays rejected for that combined path. Provider docs list `priority`; strict contract still rejects it.                                                                                                                     |
| `gemini-3.1-pro-preview` | `generateContent` | `thinkingLevel`  | `low`, `medium`, `high`              | No `budgetTokens` in strict contract; `minimal` / `effort: 'none'` not admitted                                                        | Fixed by contract; sampling knobs omitted from schema                       | Yes               | Yes                                                                | `flex`, `standard` only                   | `minimal` not supported and legacy-budget note from [Gemini 3 guide](https://ai.google.dev/gemini-api/docs/generate-content/gemini-3). Model capability and current tier docs from [model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview). Structured-output-with-tools scope from [structured output guide](https://ai.google.dev/gemini-api/docs/generate-content/structured-output). Provider docs list `priority`; strict contract still rejects it.                                                                                                       |
| `gemini-3-flash-preview` | `generateContent` | `thinkingLevel`  | `none`, `low`, `medium`, `high`      | No `budgetTokens` in strict contract; strict contract rejects the provider's legacy budget alias                                       | Fixed by contract; sampling knobs omitted from schema                       | Yes               | No exact `generateContent` evidence; strict contract should reject | `flex`, `standard` only                   | Thinking levels for Gemini 3 Flash from [Gemini 3 guide](https://ai.google.dev/gemini-api/docs/generate-content/gemini-3). Model capabilities and current tier docs from [model page](https://ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview). Structured-output-with-tools guide does not name this preview id, so the combined path stays rejected. Provider docs list `priority`; strict contract still rejects it.                                                                                                                                                       |
| `gemma-4-31b-it`         | `generateContent` | `thinkingLevel`  | `none`, `high`                       | On/off only; `thinkingLevel = minimal` disables, `thinkingLevel = high` enables; no `budgetTokens` lane                                | Tunable per live probe; keep re-verification note until strict schema lands | Yes               | Blocked pending exact evidence; do not admit by schema yet         | None admitted until verified              | Supported ids and on/off thinking model from [Run Gemma with the Gemini API](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api). Repo live-probe notes in `packages/core/CHANGELOG.md` and `packages/google/CHANGELOG.md` record that only `gemma-4-31b-it` and `gemma-4-26b-a4b-it` are callable, `thinkingBudget` returns HTTP 400, native structured output works, grounding works, and only `MINIMAL`/`HIGH` are accepted. Public Gemma docs do not currently provide the same evidence shape for service tiers or structured-output-with-tools, so those stay out of schema. |
| `gemma-4-26b-a4b-it`     | `generateContent` | `thinkingLevel`  | `none`, `high`                       | On/off only; `thinkingLevel = minimal` disables, `thinkingLevel = high` enables; no `budgetTokens` lane                                | Tunable per live probe; keep re-verification note until strict schema lands | Yes               | Blocked pending exact evidence; do not admit by schema yet         | None admitted until verified              | Supported ids and on/off thinking model from [Run Gemma with the Gemini API](https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api). Repo live-probe notes in `packages/core/CHANGELOG.md` and `packages/google/CHANGELOG.md` record that only `gemma-4-31b-it` and `gemma-4-26b-a4b-it` are callable, `thinkingBudget` returns HTTP 400, native structured output works, grounding works, and only `MINIMAL`/`HIGH` are accepted. Public Gemma docs do not currently provide the same evidence shape for service tiers or structured-output-with-tools, so those stay out of schema. |

## 2026-09-25 refresh

The [GenerateContent structured-output guide](https://ai.google.dev/gemini-api/docs/generate-content/structured-output)
explicitly names `gemini-3.8-flash` and `gemini-3.1-pro-preview` for structured
output with built-in tools including Google Search. The [Google pricing page](https://ai.google.dev/gemini-api/docs/pricing)
supplies the per-tier rates and the January 2027 expiry for the Flash intro
prices. The [xAI September 21 release notes](https://docs.x.ai/developers/release-notes)
publish Grok 4.7's short- and long-context rates and efforts; the [xAI pricing page](https://docs.x.ai/developers/pricing)
states the inclusive 200k long-context boundary and 2× priority rate.

Registered after the 2026-09-25 catalog refresh. Hosts migrate deleted ids themselves:
`gemini-3-flash-preview` and `gemini-3.5-flash` → `gemini-3.6-flash`; `gpt-5.x` →
`gpt-6-astra` / `gpt-6-sol` / `gpt-6-luna`; `claude-fable-5` → `claude-fable-5-1`;
`claude-opus-4-8` → `claude-opus-5-5`. There is no alias.

| Model                                                    | Efforts                                 | SO + search | caching.minTokens | Tiers          | Notes                                                                                                                                                             |
| -------------------------------------------------------- | --------------------------------------- | ----------- | ----------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gemini-3.8-flash`                                       | `low`, `medium`, `high`                 | yes         | 1024              | flex, standard | Intro rates. Never emits `thinkingLevel` MINIMAL.                                                                                                                 |
| `gemini-3.7-flash`                                       | `low`, `medium`, `high`                 | yes         | 1024              | flex, standard | Same intro rates. Never emits MINIMAL.                                                                                                                            |
| `gemini-3.6-flash`                                       | `none`, `low`, `medium`, `high`         | yes         | 1024              | flex, standard | Same intro rates.                                                                                                                                                 |
| `gemini-3.5-flash-lite`                                  | `none`, `low`, `medium`, `high`         | yes         | 1024              | flex, standard | Live cache minimum 1024 (P-G5).                                                                                                                                   |
| `gemini-3.1-pro-preview`                                 | `low`, `medium`, `high`                 | yes         | 1024              | flex, standard | Live cache minimum 1024 (P-G5).                                                                                                                                   |
| `gemini-3.1-flash-lite`                                  | `none`, `low`, `medium`, `high`         | yes         | 1024              | flex, standard | Live cache minimum 1024 (P-G5).                                                                                                                                   |
| `gemini-2.5-pro`                                         | `low`, `medium`, `high`                 | no          | 2048              | flex, standard | Still registered. Budget API. Sampling stays tunable.                                                                                                             |
| `gemini-2.5-flash`                                       | `none`, `low`, `medium`, `high`         | no          | 2048              | flex, standard | Still registered. Budget API. Sampling stays tunable.                                                                                                             |
| `gemini-2.5-flash-lite`                                  | `none`, `low`, `medium`, `high`         | no          | 2048              | flex, standard | Still registered. Budget API. Sampling stays tunable.                                                                                                             |
| `gemma-4-31b-it`                                         | `none`, `high`                          | no          | n/a               | none           | Still registered. Unpriced.                                                                                                                                       |
| `gemma-4-26b-a4b-it`                                     | `none`, `high`                          | no          | n/a               | none           | Still registered. Unpriced.                                                                                                                                       |
| `grok-4.5`                                               | `low`, `medium`, `high`                 | n/a         | n/a               | priority       | `xhigh` rejected; priority live-verified 2026-09-25 at 2×. Long-context starts at ≥200,000.                                                                       |
| `grok-4.6`                                               | `low`, `medium`, `high`, `xhigh`        | n/a         | n/a               | priority       | Long-context starts at ≥200,000. Priority 2×.                                                                                                                     |
| `grok-4.7`                                               | `low`, `medium`, `high`, `xhigh`        | n/a         | n/a               | priority       | Live priority 200 and effort-none 400 fixtures (2026-09-25); P-X3 stateless encrypted-reasoning replay live-verified 2026-09-26. Long-context starts at ≥200,000. |
| `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`                 | `low`, `medium`, `high`, `xhigh`, `max` | n/a         | n/a               | n/a            | `--strict-config` is invariant. `ultra` and `none` excluded.                                                                                                      |
| `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5` | `low` through `max`                     | n/a         | n/a               | n/a            | `--settings {"switchModelsOnFlag":false}` is best-effort; `modelUsage` enforces the served id.                                                                    |
| `claude-haiku-4-5-20251001`                              | none                                    | n/a         | n/a               | n/a            | No reasoning key. The CLI drops `--effort`.                                                                                                                       |

Recorded with this refresh:

- P-G4: structured JSON plus `googleSearch` returned HTTP 200 and valid JSON on all six registered Gemini 3.x models. The first 3.8 Flash call returned a billed HTTP 200 without a candidate; retrying with `LOW` thinking and 1024 max output tokens returned valid JSON. The adapter now classifies candidate-less responses without a safety `blockReason` as retryable provider failures and records their usage and cost. Search-requested structured responses on the four newly admitted models did not include `groundingMetadata`; successful configuration does not prove Search was actually used or provide citations. Deleted ids do not resolve or alias.
- July 21, 2026: Google deprecated the sampling parameters `temperature`, `top_p`, and `top_k` (changelog). Gemini 3.x descriptors already omit those knobs (`sampling: 'fixed'`). The changelog does not say the deprecation covers Gemini 2.5 or Gemma, so those descriptors stay `sampling: 'tunable'`.
- P-G8: on 2026-09-26, two paid development keys reached 2.5 Pro and Flash; one reached 2.5 Flash-Lite and the other got HTTP 404 `NOT_FOUND` with a structured "no longer available to new users" error. All three ids stay registered. This structured 404 is classified as non-retryable `bad_request`; model access is project-specific.
- P-G7: live flex calls to Gemini 3.5 Flash-Lite, 3.6 Flash, 3.7 Flash, and 3.8 Flash returned `usageMetadata.serviceTier: flex`. The adapter now uses this actual-tier echo for `servedServiceTier`, falling back to the dispatched tier when absent. `priority` remains out of schema until admission, pricing, and downgrade accounting are tested.
- P-G1: Gemini 3.7 Flash and 3.8 Flash returned HTTP 400 `INVALID_ARGUMENT` for `thinkingLevel: MINIMAL`.
- P-G5: all six registered Gemini 3.x ids rejected a 103-token cache create with `min_total_token_count=1024` and accepted an exact 1024-token create. Fixture `packages/google/src/__fixtures__/provider-live-2026-09-26.json` records P-G1, P-G4, P-G5, P-G7, and P-G8.
- Google's 4096-token table in its caching guide concerns implicit caching. `caching.minTokens` in these descriptors gates explicit cache creation, for which the live endpoint reported 1024.
- P-X2: the available xAI key has Zero Data Retention; file upload returned 403 and public URL attachment returned 400. Counter verification needs a non-ZDR key. Fixture `29-attachment-zdr-blocked.json` records the errors.
- P-X3: live grok-4.7 `store:false` returned encrypted reasoning and a function call; replaying the full response output unchanged in the adapter's exact input shape with the function result returned the correct answer. The adapter retains all wire output items in transient provider state outside the ledger. Fixture `28-grok-4-7-replay.json` records both turns. A follow-up live call replayed the full history ending with an assistant message and containing a `web_search_call` item, without re-supplying tools, and returned HTTP 200; fixture `30-grok-4-7-search-replay.json` records both calls and a hash of the replayed input. A live third turn replayed the full fixture 28 history ending in the function answer's assistant message and returned HTTP 200; fixture `31-grok-4-7-third-turn.json` records that result and an input hash.
- xAI `long_context_threshold` is inclusive: gross input at or above 200,000 uses the long-context rates. The xAI lookup owns `>=`; core's selector stays `>`.
- P-X1: live grok-4.7 X Search calls on 2026-09-26 emitted `x_posts_fetched` and `x_users_fetched`, including explicit zeroes. Posts-only (10 posts) and users-only (12 profiles) snapshot costs matched provider `cost_in_usd_ticks` exactly; fixtures `26-x-posts.json` and `27-x-users.json` preserve the usage blocks.
- P-A1: Claude Code 2.1.282 completed the adapter's invariant argv plus `--json-schema` on all four registered ids on 2026-09-26. Each success envelope's `modelUsage` contained exactly the requested id; sanitized selected response fields are in `packages/claude-cli/src/__fixtures__/model-refresh-p-a1.json`.

## Contract Notes

- `descriptor.configSchema` is the runtime source of truth for persisted and
  request-time config. `descriptor.configJsonSchema` is derived from that exact
  schema for UI/form generation.
- `LlmRequest.output.jsonSchema` is a separate output-formatting surface. It is
  not the model-config contract and should not be used as a substitute for
  model config validation.
- The provider still documents `priority` and some legacy reasoning aliases.
  The strict contract intentionally rejects those paths until they have
  complete schema, served-tier, pricing, and test coverage.
- Public docs for `gemini-3.1-flash-lite` are now stable enough to remove the
  earlier "verify exact id before shipping" blocker. Public docs for the two
  Gemma 4 ids still need supplemental live-probe notes for several fields.

## Deletion Inventory Before Signoff

**Status: shipped.** The strict-schema rollout landed in `feat: enforce strict
model config schemas` and the subsequent provider-plugin-architecture split —
Gemini/Gemma config schemas, descriptors, and pricing now live in
`@gullabs/google` (`packages/google/src/models.ts`, `packages/google/src/cost.ts`,
`packages/google/src/pricing.ts`); `packages/core/src/reasoning.ts` and the
public reasoning helper are deleted; `packages/core/src/registry.ts` retains
only the generic `ModelDescriptor` / `ModelRegistry` / `createModelRegistry`
machinery with zero provider knowledge. The list below is kept as the
historical record of what the rollout removed — treat every item as done, not
as an outstanding TODO.

The strict-schema rollout is not complete until the old contract and its
teaching surfaces are removed, not wrapped.

### Source files / exports to delete or rewrite

- `packages/core/src/registry.ts`
  - Delete the Gemini config schema factories.
  - Stop treating built-in `configJsonSchema` / `validateConfig` as optional,
    hand-written artifacts.
- `packages/core/src/reasoning.ts`
  - Delete the public reasoning helper and its exported public types.
- `packages/core/src/index.ts`
  - Remove public exports for the deleted reasoning helper family, the deleted
    Gemini config factory family, and the internal effort-budget table.
- `packages/core/src/engine.ts`
  - Delete the implicit `serviceTier ?? 'flex'` resolution path.
  - Replace projection-only validation with full `descriptor.configSchema`
    parsing.
- `packages/core/src/ports.ts`
  - Remove the required-service-tier wrapper type from the adapter-facing
    `ResolvedRequest` contract.
- `packages/google/src/adapter.ts`
  - Delete raw spread/overwrite semantics that let `providerOptions.google`
    behave like a second config API.
  - Delete stale `googleSearchRetrieval` compatibility once the exact
    model/API-mode tool guard is in place.

### Tests to delete or replace

- `packages/core/src/reasoning.test.ts`
- `packages/core/src/index.surface.test.ts`
- `packages/core/src/config-validation.test.ts` cases that lock in
  deleted Gemini config factories
- `packages/core/src/engine.test.ts` cases asserting Flex default injection
- `packages/google/src/adapter.test.ts` cases asserting
  `providerOptions.google` can override descriptor-owned fields
- `packages/google/src/adapter.test.ts` cases keyed to
  `googleSearchRetrieval` compatibility instead of the exact documented tool
  shape

### Docs / skill surfaces that must stop teaching the old contract

- `DECISIONS.md`
- `README.md`
- `packages/core/README.md`
- `packages/google/README.md`
- `packages/any-llm/README.md`
- `packages/any-llm/skills/any-llm/SKILL.md`
- `docs/architecture.md`
- `docs/grounded-structured.md`

### Legacy behaviors that must disappear

- Optional or hand-authored built-in `configJsonSchema`
- Hand-written built-in schema factories as the public contract
- Public repair helpers that infer config from model strings
- Implicit Flex defaults
- Adapter contracts that require `serviceTier` to already exist
- Broad `providerOptions.google` caller-wins overwrite behavior
- Blanket grounding guard language that ignores exact model and tool evidence
