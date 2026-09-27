# Model Config Strict Schema Design

## Status

Draft for implementation.

Historical design snapshot from before the 2026-09-25 model refresh. The
`gemini-3.5-flash` and `gemini-3-flash-preview` rows below describe the
earlier catalog; both ids are now deleted. See
[`model-config-provider-evidence.md`](./model-config-provider-evidence.md#2026-09-25-refresh)
for the current catalog.

Review inputs:

- Local audit: `docs/model-config-contract-audit.md`
- Architecture/API expert: signed off on the boundary direction; requested public
  factory/helper removal and stricter `providerOptions` guardrails.
- Provider-contract expert: changes-requested on current implementation; findings
  incorporated, including Gemma service-tier defaulting and provider-options
  bypasses.
- Claude adversarial review: first pass changes-requested; findings incorporated.
  Second pass approved with no blocking findings.

## Executive Decision

The library boundary for model-owned generation config is the model descriptor's
Zod schema, not hand-written JSON Schema and not adapter-first validation.

Every built-in supported model must publish:

1. An exact model-id Zod schema.
2. Human-readable field documentation in the Zod schema metadata.
3. A derived JSON Schema for UI/form generation.
4. A runtime validator backed by the same Zod schema.
5. Adapter fixtures proving that valid parsed config translates correctly.
6. Negative tests proving invalid config is rejected before provider dispatch.

A supported built-in model without that schema is not supported. No
compatibility translation layer is allowed between caller config and the schema
boundary: no alias normalization, no best-effort coercion, no migration helper,
no fallback parser, and no adapter-side repair path may make invalid public
config valid. No model-conditional config helper is allowed; a model-specific
rule belongs in that model's schema, even when that duplicates nearby model
files.

This intentionally replaces the current split-brain contract:

- `configJsonSchema` is broad and hand-written.
- `validateConfig` is hand-written and narrower than the schema.
- `providerOptions.google` can overwrite already-validated fields.
- The adapter still owns predictable model-contract failures.
- The engine injects a `serviceTier: 'flex'` default even for descriptors that
  declare no supported service tiers, making normal Gemma calls fail in the
  adapter.

## Provider Evidence

Current Google docs matter because these contracts drift.

- Google says the Interactions API is generally available and recommends it for
  latest features and models. This repo still targets `models.generateContent`,
  so this design fixes the current adapter boundary first and separately flags
  Interactions migration as a product/API issue.
- GenerateContent `GenerationConfig` documents `responseMimeType`,
  `responseSchema`, `_responseJsonSchema`, `temperature`, `topP`, `topK`,
  `thinkingConfig`, media resolution, and response format. It also says not all
  generation parameters are configurable for every model.
- GenerateContent `ThinkingConfig` has `includeThoughts`, `thinkingBudget`, and
  `thinkingLevel`; the docs recommend `thinkingLevel` for Gemini 3 or later and
  say using it with earlier models errors.
- Google Search grounding support is model-specific. Current docs list Gemini
  3.5 Flash, Gemini 3.1 Pro Preview, Gemini 3 Flash Preview, and Gemini 2.5
  Pro/Flash/Flash-Lite as supported.
- Current docs say Gemini 3 supports combining structured outputs with built-in
  tools, including Google Search. The repo's current hard ban on grounding plus
  structured output is now too broad for Gemini 3 and should become
  model/API-mode specific.
- Current docs say Flex and Priority inference are model-specific and both now
  list the repo's seven Gemini 2.5/3.x text models. Priority is preview and
  carries different pricing and downgrade semantics, so it must not be enabled
  by a string escape hatch.

Primary docs checked:

- https://ai.google.dev/api/generate-content
- https://ai.google.dev/gemini-api/docs/thinking
- https://ai.google.dev/gemini-api/docs/structured-output
- https://ai.google.dev/gemini-api/docs/google-search
- https://ai.google.dev/gemini-api/docs/flex-inference
- https://ai.google.dev/gemini-api/docs/priority-inference
- https://ai.google.dev/gemini-api/docs/models
- Zod 4 docs via Context7: `z.toJSONSchema()` preserves `.describe()` and
  `.meta()` documentation in generated JSON Schema.

## Current Problems To Fix

### 1. Schema and validator drift

`packages/core/src/registry.ts` currently builds JSON Schema manually with
`additionalProperties: true`, while the old validator factory only rejected a
small subset of invalid configs. This lets invalid configs pass persistence and
UI validation and fail later in `packages/google/src/adapter.ts`.

Examples that currently pass descriptor validation:

- Gemini 3/Gemma level-api model with `reasoning.budgetTokens`.
- Any model with `reasoning.effort` and `reasoning.budgetTokens` together.
- Unknown top-level config keys.
- Unknown nested `reasoning` keys.
- Bad scalar values such as `temperature: -1`, `topP: 'bad'`, `topK: 1.5`,
  `maxOutputTokens: -1`, `stopSequences: 'bad'`, or `serviceTier: 'priority'`.

### 2. Public API encourages repair helpers

The old public reasoning helper turns a numeric budget
into model-specific config, which makes ambiguous persisted config feel normal.
The new contract should make such persisted config impossible to accept for the
wrong model.

The old Gemini config schema factories are also exported.
They are family factories, not exact model contracts, and should not be public.

### 3. Type docs contradict runtime behavior

`ReasoningIntent.budgetTokens` says it overrides `effort` when both are present.
The adapter throws on that combination. The schema, public type comments, and
runtime behavior must all say the same thing: either `effort` or `budgetTokens`,
never both.

### 4. `providerOptions.google` is too powerful

`providerOptions.google` is applied after typed config mapping with
`Object.assign`. Service tier and fixed sampling are rechecked, but the escape
hatch can still overwrite model-owned fields such as:

- `thinkingConfig`
- `responseMimeType`
- `responseSchema`
- `_responseJsonSchema`
- `responseJsonSchema`
- `responseFormat`
- `tools`
- `mediaResolution`
- `speechConfig`
- `imageConfig`
- `responseModalities`

That is not an escape hatch; it is an untyped second config API.

### 5. Service-tier defaulting is not descriptor-aware

Before this change, the engine defaulted missing `serviceTier` to `flex` before
adapter dispatch. That was wrong for models whose descriptor omitted
`serviceTiers`, such as Gemma. The adapter rejects explicit tiers for those
models, so the old standard client path could create invalid config that the
caller did not request.

Target behavior:

- Omitted `serviceTier` stays omitted and uses provider-default request behavior.
- If the caller explicitly supplies `serviceTier`, validate it against that
  descriptor before dispatch.

### 6. Grounding + structured output guard is stale

The repo currently treats Google Search grounding and structured output as
mutually exclusive for Gemini. Current public docs say Gemini 3 supports
structured outputs with built-in tools, including Google Search. The contract
must distinguish:

- GenerateContent vs Interactions API mode.
- Gemini 2.5 vs Gemini 3.
- current `googleSearch` only; older `googleSearchRetrieval` is not a
  compatibility alias.

Until verified against the current GenerateContent adapter, keep the conservative
guard in code but track it as an explicit drift issue, not as a permanent model
truth.

### 7. Priority tier has become a real current-doc feature

The existing comments say `priority` is excluded because its semantics were
unverified. Current docs now describe Priority inference, supported models,
pricing premium, server-side downgrade, and response monitoring responsibility.
This does not mean we should blindly add it. It means the design must explicitly
support a future `priority` tier through schema, pricing, served-tier recording,
and tests, and must keep blocking `providerOptions.google.serviceTier:
'priority'` until those pieces exist.

## Design Principles

1. Exact model id is the public contract boundary.
2. Zod schema is the source of truth.
3. JSON Schema is derived from Zod, never maintained separately.
4. Runtime validation uses the same Zod schema as JSON Schema generation.
5. Unknown model-owned keys fail.
6. Adapters translate parsed config; they do not normalize ambiguous config.
7. Provider escape hatches cannot override model-owned fields.
8. There is no raw SDK config merge in the public client.
9. Adding a model without schema, docs, pricing status, and adapter fixtures
   fails CI.
10. Provider-doc drift becomes an explicit testable maintenance task.

## Target Public API

### ModelDescriptor

Replace optional loose fields with required schema fields for built-ins:

```ts
import type { z } from 'zod'

export interface ModelDescriptor<TConfig = unknown> {
  id: string
  provider: string
  pricingFamily?: string
  capabilities: ModelCapabilities

  /**
   * Exact model-id schema. This is the authoritative public config contract.
   */
  configSchema: z.ZodType<TConfig>

  /**
   * Derived from configSchema with z.toJSONSchema(configSchema).
   * Suitable for UI generation only.
   */
  configJsonSchema: JsonValue

  /**
   * Standard Schema adapter over configSchema.safeParse().
   * Kept for engine/provider-agnostic validation.
   */
  validateConfig: StandardSchemaV1
}
```

`configSchema`, `configJsonSchema`, and `validateConfig` are all required for
built-in and custom descriptors. `createModelRegistry()` must throw if any are
missing.

### Consumer Flow

Consumers should do exactly this:

```ts
const descriptor = registry.resolve(provider, model)
if (!descriptor) throw new Error(`Unknown model: ${provider}/${model}`)

const config = descriptor.configSchema.parse(persistedConfig)
await client.generate({ provider, model, messages, config }, { auth })
```

They should not call the deleted public reasoning helper, `normalizeConfigForModel`,
`buildReasoningConfig`, or any helper that conditionally mutates config by model
string.

### Exports To Remove

Remove these exports as part of the strict schema change. Do not keep deprecated
aliases or compatibility helpers:

- deleted public reasoning helper
- `ResolveReasoningInput`
- `ResolvedReasoning`
- deleted Gemini config schema factory
- deleted Gemini config validator factory

Do not keep a core reasoning repair helper or exported effort-budget table. The
Google adapter owns its provider-local effort-to-budget mapping.

Add public:

- Exact descriptor schemas, exported by name only if there is a strong consumer
  need. Preferred access is through `descriptor.configSchema`.
- A `parseModelConfig(model, config, registry?)` convenience that only resolves
  descriptor and calls `descriptor.configSchema.parse`. It must not transform.

## Zod Schema Rules

Use Zod 4.

Every object must be strict:

```ts
const Gemini25FlashConfigSchema = z.strictObject({
  temperature: z
    .number()
    .min(0)
    .max(2)
    .optional()
    .describe('Sampling temperature. Supported on Gemini 2.5 Flash.'),
  topP: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Nucleus sampling probability mass. Supported on Gemini 2.5 Flash.'),
  topK: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Top-k sampling. Supported on Gemini 2.5 Flash.'),
  maxOutputTokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Maximum generated output tokens.'),
  stopSequences: z
    .array(z.string())
    .max(5)
    .optional()
    .describe('Up to 5 stop sequences.'),
  serviceTier: z
    .enum(['flex', 'standard'])
    .optional()
    .describe(
      'Gemini service tier. Defaulting is descriptor-aware and never injected for models without service-tier support.',
    ),
  reasoning: z
    .union([
      z.strictObject({
        effort: z.enum(['none', 'low', 'medium', 'high']),
        includeThoughts: z.boolean().optional(),
      }),
      z.strictObject({
        budgetTokens: z.number().int().nonnegative(),
        includeThoughts: z.boolean().optional(),
      }),
      z.strictObject({
        includeThoughts: z.boolean(),
      }),
    ])
    .optional()
    .describe('Gemini 2.5 thinkingBudget controls.'),
})
```

Important: do not use schema spreading or shared schema fragments for the final
exported model schemas. The final source should be visually explicit per model.
Small helper functions for messages are acceptable, but field sets should be
copied into each exact model schema so reviewers can inspect a model without
following factory indirection.

Do not rely on `.refine()` for any public contract constraint that must appear
in `configJsonSchema`. If JSON Schema consumers need to see the constraint,
model it structurally with `z.union`, `z.discriminatedUnion`, enums, strict
objects, min/max, or other JSON-Schema-representable constructs. Refinements may
only be used as defensive runtime backstops and must have a separate parity test
that proves the JSON Schema does not falsely advertise the invalid shape.

## Exact Schema Set

As shipped, these live in `@gullabs/google` (`packages/google/src/models.ts`), not
in core — core owns only the generic registry/schema machinery
(`ModelDescriptor`, `ModelRegistry`, `createModelRegistry`, `toConfigJsonSchema`,
`zodToStandardSchema`) with zero provider knowledge. At design time this section
proposed a core-owned location (`packages/core/src/model-config-schemas.ts` or a
folder such as `packages/core/src/model-config/`); the provider-plugin split
moved all provider-specific schemas out of core.

Required exact schemas:

- `Gemini25ProConfigSchema`
- `Gemini25FlashConfigSchema`
- `Gemini25FlashLiteConfigSchema`
- `Gemini35FlashConfigSchema`
- `Gemini31FlashLiteConfigSchema`
- `Gemini31ProPreviewConfigSchema`
- `Gemini3FlashPreviewConfigSchema`
- `Gemma431bItConfigSchema`
- `Gemma426bA4bItConfigSchema`

Each schema must have top-level `.describe()`/`.meta()` explaining:

- model id;
- provider API mode covered (`generateContent`);
- reasoning API;
- sampling support;
- service tier support;
- structured output support;
- grounding support;
- pricing status.

## Model Matrix

| Model                    | Reasoning API | Reasoning Fields                                                         | Efforts                         | Sampling                      | Service Tier                                            | Structured | Grounding                                                           | Vision/Audio         | Pricing                |
| ------------------------ | ------------- | ------------------------------------------------------------------------ | ------------------------------- | ----------------------------- | ------------------------------------------------------- | ---------- | ------------------------------------------------------------------- | -------------------- | ---------------------- |
| `gemini-2.5-pro`         | budget        | `effort`, `budgetTokens`, `includeThoughts`; `effort` XOR `budgetTokens` | `low`, `medium`, `high`         | `temperature`, `topP`, `topK` | `flex`, `standard` now; `priority` tracked, not enabled | yes        | yes                                                                 | vision yes, audio no | priced                 |
| `gemini-2.5-flash`       | budget        | `effort`, `budgetTokens`, `includeThoughts`; XOR                         | `none`, `low`, `medium`, `high` | `temperature`, `topP`, `topK` | `flex`, `standard`; priority tracked                    | yes        | yes                                                                 | vision yes, audio no | priced                 |
| `gemini-2.5-flash-lite`  | budget        | `effort`, `budgetTokens`, `includeThoughts`; XOR                         | `none`, `low`, `medium`, `high` | `temperature`, `topP`, `topK` | `flex`, `standard`; priority tracked                    | yes        | yes                                                                 | vision yes, audio no | priced                 |
| `gemini-3.5-flash`       | level         | `effort`, `includeThoughts`; no `budgetTokens`                           | `none`, `low`, `medium`, `high` | fixed; no sampling fields     | `flex`, `standard`; priority tracked                    | yes        | yes                                                                 | vision yes, audio no | priced                 |
| `gemini-3.1-flash-lite`  | level         | `effort`, `includeThoughts`; no `budgetTokens`                           | `none`, `low`, `medium`, `high` | fixed; no sampling fields     | `flex`, `standard`; priority tracked                    | yes        | current docs verified stable id; combined tools path still rejected | vision yes, audio no | priced                 |
| `gemini-3.1-pro-preview` | level         | `effort`, `includeThoughts`; no `budgetTokens`                           | `low`, `medium`, `high`         | fixed; no sampling fields     | `flex`, `standard`; priority tracked                    | yes        | yes                                                                 | vision yes, audio no | priced                 |
| `gemini-3-flash-preview` | level         | `effort`, `includeThoughts`; no `budgetTokens`                           | `none`, `low`, `medium`, `high` | fixed; no sampling fields     | `flex`, `standard`; priority tracked                    | yes        | yes                                                                 | vision yes, audio no | priced                 |
| `gemma-4-31b-it`         | level         | `effort`, `includeThoughts`; no `budgetTokens`                           | `none`, `high`                  | `temperature`, `topP`, `topK` | none until verified                                     | yes        | current repo says yes; verify against current public docs/live API  | vision yes, audio no | intentionally unpriced |
| `gemma-4-26b-a4b-it`     | level         | `effort`, `includeThoughts`; no `budgetTokens`                           | `none`, `high`                  | `temperature`, `topP`, `topK` | none until verified                                     | yes        | current repo says yes; verify against current public docs/live API  | vision yes, audio no | intentionally unpriced |

Blank or "verify" cells are findings. The implementation should either verify
them live and encode them or mark them unsupported in schema/capabilities.

## Full Config Schema

`descriptor.configSchema` should validate the full per-call generation config
accepted by `GenConfig`, not just a projection. To avoid mixing model-owned and
execution-owned concerns, define exact per-model schemas that include:

- model-owned fields: sampling, token cap, stops, reasoning, service tier;
- execution fields: `timeoutMs` (core-owned);
- provider allowlist: `providerOptions.google`, which owns `flexFallback` as
  shipped (see "Provider Options Redesign" below) rather than a core
  execution field.

This makes one parse step authoritative:

```ts
const Gemini25FlashGoogleProviderOptionsSchema = z.strictObject({
  cachedContent: z.string().min(1).optional(),
  safetySettings: z.array(GeminiSafetySettingSchema).optional(),
  tools: Gemini25FlashToolsSchema.optional(),
  httpOptions: GoogleHttpOptionsSchema.optional(),
})

const Gemini25FlashConfigSchema = z.strictObject({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  stopSequences: z.array(z.string()).max(5).optional(),
  serviceTier: z.enum(['flex', 'standard']).optional(),
  reasoning: Gemini25FlashReasoningSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  flexFallback: z.boolean().optional(),
  providerOptions: z
    .strictObject({
      google: Gemini25FlashGoogleProviderOptionsSchema.optional(),
    })
    .optional(),
})
```

No second wrapper schema may accept keys that `descriptor.configSchema` does not
see. If a future field is not model-owned, it still belongs in the exact model
config schema as an execution field with strict documentation.

## Provider Options Redesign

Replace the current unbounded merge with a quarantined contract:

```ts
export interface GenConfig {
  // model-owned typed fields
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  reasoning?: ReasoningIntent
  serviceTier?: 'flex' | 'standard'
  timeoutMs?: number
  flexFallback?: boolean

  providerOptions?: {
    google?: GoogleProviderOptions
  }
}
```

As shipped, this diverged from the sketch above in two ways, both driven by
`@gullabs/core` becoming provider-agnostic:

- `GenConfig.serviceTier` is an opaque `string` at the core level, not the
  closed `'flex' | 'standard'` union — the union is still enforced, just one
  layer down, by each Gemini model's own strict `configSchema`. A core type
  closed to Google's tier names would block other providers from defining
  their own.
- `flexFallback` is not a core `GenConfig` field at all. It lives inside
  `GoogleProviderOptions` (`packages/google/src/types.ts`) and is reached as
  `providerOptions.google.flexFallback`. `ProviderOptionsMap` itself is an
  open, augmentable interface (`packages/core/src/types.ts`) that provider
  packages extend via declaration merging — not the closed
  `{ google?: GoogleProviderOptions }` shape sketched here.

`GoogleProviderOptions` should be allowlisted:

- `cachedContent`
- `safetySettings`
- `tools`, with an exact per-model/API-mode schema. For GenerateContent this
  means only tool entries the adapter understands and can validate, such as
  current `googleSearch` where supported. Unsupported or stale tools, including
  older `googleSearchRetrieval`, must be rejected unless current public docs
  prove they are valid for that exact model/API mode.
- `httpOptions`, currently limited to documented timeout behavior.

Reserved keys must be rejected inside `providerOptions.google`:

- `temperature`
- `topP`
- `topK`
- `maxOutputTokens`
- `stopSequences`
- `serviceTier`
- `thinkingConfig`
- `responseMimeType`
- `responseSchema`
- `_responseJsonSchema`
- `responseJsonSchema`
- `responseFormat`
- `responseModalities`
- `speechConfig`
- `imageConfig`
- `mediaResolution`
- `abortSignal`

The adapter must not call `Object.assign(config, googleOpts)`. It should map
allowlisted provider options field-by-field.

There is no `unsafeProviderOptions` in the public client. Tests and advanced
callers that need raw SDK access should inject their own `ProviderAdapter`
instead of tunneling raw SDK config through the core library.

## Engine Validation Flow

Change the engine from projection validation to full model-config validation.

Current projection excludes `providerOptions`, which is why the adapter has to
recheck after merge. Target flow:

1. Resolve descriptor.
2. Apply descriptor-aware defaults. In particular, do not inject
   `serviceTier` for models with no supported service tiers.
3. Validate the full generation config against `descriptor.configSchema`.
4. Store the parsed config on `ResolvedRequest`.
5. Pass parsed config to adapter.
6. Adapter maps parsed config and allowlisted provider options.
7. Adapter retains defensive assertions for invariants, but tests should prove
   those assertions are unreachable through the public client.

Execution-spine fields that are not model-owned need their own strict schema,
not silent projection:

- `timeoutMs` (core-owned)
- `flexFallback` (shipped as a Google provider-options field, not a core
  execution field — see "Provider Options Redesign")
- retry/middleware-owned fields if any are added later.

## Structured Output Boundary

This design is about model config, but there is a related contract issue:
`output.jsonSchema` is currently a provider hint, not a runtime output contract.
That is acceptable only if docs stay explicit.

Do not reintroduce Zod output validation into the provider adapter as part of
this model-config fix. Instead:

- Keep `output.jsonSchema` as a generation hint.
- Consider adding a separate `output.schema` in a future breaking release if
  the library should own output validation again.
- Do not confuse model config schema with output schema.

## Interactions API Drift

Current Google docs recommend Interactions API for latest features and models.
This repo currently maps to GenerateContent. The strict schema implementation
should record `apiMode: 'generateContent'` in each descriptor/capability and
avoid claiming support for Interactions-only features.

Follow-up design needed:

- `geminiGenerateContentAdapter`
- `geminiInteractionsAdapter`
- model descriptors must carry an API-mode key such as
  `apiMode: 'generateContent' | 'interactions'`
- model descriptors may have separate config schemas per API mode
- grounding + structured-output rules become API-mode specific
- service-tier spelling/mapping differs (`serviceTier` vs `service_tier`)
- the public `GenConfig` remains library-normalized camelCase; adapters may only
  project already-validated typed config to provider/API spelling. That
  projection is not a compatibility translation layer and must not broaden,
  normalize, or repair the public config contract. Adding Interactions must be
  additive by introducing new descriptors or adapter mode, not by changing
  existing GenerateContent descriptor schemas.

## Implementation Plan

1. Add `zod` runtime dependency to `@gullabs/core`.
2. Add exact per-model Zod schemas with descriptions and no shared final schema
   factories.
3. Add `zodStandardSchema(schema)` adapter or use Zod's Standard Schema support
   if available in the pinned version.
4. Generate `configJsonSchema` with `z.toJSONSchema(schema)`.
5. Update descriptors to attach exact `configSchema`, derived
   `configJsonSchema`, and Zod-backed `validateConfig`.
6. Remove the exported Gemini config factories.
7. Remove the deleted public reasoning helper from exports.
8. Update `ReasoningIntent` docs and preferably make the TypeScript type a
   discriminated/XOR shape.
9. Replace adapter `Object.assign` provider-options merge with field mapping.
10. Add reserved-key rejection for `providerOptions.google`.
11. Update docs and ADRs that currently endorse unvalidated passthrough.
12. Add a model-onboarding checklist that fails CI when a model lacks schema,
    docs, pricing status, and adapter fixtures.

## Required Tests

Descriptor/schema tests:

- Every built-in descriptor has `configSchema`, `configJsonSchema`,
  `validateConfig`.
- `configJsonSchema` equals `z.toJSONSchema(configSchema)` for every descriptor.
- Every schema has descriptions for every public field.
- Every schema is strict at top-level and nested `reasoning`.
- Unknown top-level keys fail.
- Unknown `reasoning` keys fail.
- Invalid primitive types/ranges fail.
- `stopSequences` rejects more than 5 entries.
- Level models reject `reasoning.budgetTokens`.
- Budget models reject `effort + budgetTokens`.
- Fixed-sampling models reject sampling fields.
- Service tier values outside the per-model list fail.
- Models with no `serviceTiers` omit serviceTier after default resolution.

Engine tests:

- Invalid config writes a sink error record and adapter dispatch is not reached.
- Parsed config, not raw config, reaches the adapter.
- Defaults are validated after merge.
- Gemma calls with no `serviceTier` do not receive an injected `flex` tier and
  reach adapter dispatch.
- Persisted config round-trip can parse through descriptor schema.

Adapter tests:

- One valid mapping fixture per supported model id.
- One invalid providerOptions reserved-key fixture per reserved key group.
- `providerOptions.google.thinkingConfig` cannot reach SDK config.
- `providerOptions.google.responseMimeType` cannot overwrite structured output.
- `providerOptions.google.serviceTier: 'priority'` remains rejected until the
  priority-tier schema/pricing/served-tier design ships.
- Grounding + structured output behavior is tested per model/API mode.

CI invariant (`defaultGeminiRegistry` is exported by `@gullabs/google`, not
core — core only provides the generic `createModelRegistry`/`ModelRegistry`
machinery that this registry is built from):

```ts
import { defaultGeminiRegistry } from '@gullabs/google'

const descriptors = defaultGeminiRegistry.listDescriptors()
expect(descriptors.length).toBeGreaterThan(0)

for (const descriptor of descriptors) {
  expect(descriptor.configSchema).toBeDefined()
  expect(descriptor.configJsonSchema).toEqual(z.toJSONSchema(descriptor.configSchema))
  expect(descriptor.validateConfig).toBeDefined()
  expect(hasAdapterFixture(descriptor.id)).toBe(true)
  expect(hasNegativeContractFixture(descriptor.id)).toBe(true)
  expect(hasPricingOrExplicitUnpricedDecision(descriptor.id)).toBe(true)
}
```

## Breaking-Change Notes

This is a breaking API tightening with no compatibility layer.

Implemented decisions:

1. Omitted `serviceTier` stays omitted and uses provider-standard behavior.
2. Priority tier remains rejected until pricing, served-tier recording, downgrade
   behavior, and current GenerateContent support are designed.
3. Google Search grounding stays in schema-validated, allowlisted
   `providerOptions.google.tools` for this change.
4. Custom registries remain supported only when every descriptor publishes the
   same schema artifacts as built-ins. There is no non-strict registry mode.

## Signoff Checklist

- [x] Architecture/API expert agrees with schema-boundary direction.
- [x] Provider-contract expert confirms model matrix and bypass list.
- [x] Claude first-pass blocking feedback incorporated.
- [x] Claude second-pass review approved with no blocking findings.
- [ ] Implementation issue list is created from this design.
