# Model Config Contract Design and Audit Instructions

## Purpose

This document is a handoff for fixing a concrete `any-llm` design gap found while
testing a host pipeline, and for auditing the library for similar gaps.

The immediate bug class:

- A consumer can persist or pass a generation config that contains fields the
  target model cannot actually accept.
- The library may let that config pass the model descriptor validator.
- The provider adapter then rejects or normalizes it later.
- Consumer applications are tempted to add model-specific conditional cleanup
  such as `normalizeConfigForModel`, `buildReasoningConfig`, or
  `withoutDuplicateGeminiReasoningControls`.

That is the wrong boundary. `any-llm` should publish the contract for every
supported model. Consumers should parse against that contract and then pass the
result through. Adapters should translate already-valid config into provider SDK
payloads, not act as the first real validator.

## Concrete Failure

the host seeds Gemini configs that can contain both:

```ts
reasoning: {
  effort: 'medium',
  budgetTokens: 8192,
  includeThoughts: true,
}
```

For Gemini models, `reasoning.effort` and `reasoning.budgetTokens` are alternate
control surfaces:

- Gemini 2.5 budget-api models use `thinkingBudget`.
- Gemini 3.x and Gemma level-api models use `thinkingLevel`.

At the time this gap was found, the library shape had two problems (Gemini/Gemma
model descriptors and schemas were still core-owned, before the `@gullabs/google`
package split — they now live in `packages/google/src/models.ts`):

- The registry built Gemini JSON schemas with `additionalProperties: true`.
- The old validator factory does not reject a `reasoning` object that contains
  both `effort` and `budgetTokens`.

The Google adapter does reject this later in `packages/google/src/adapter.ts`,
but that is too late. It means invalid configs can be stored, displayed, and
passed around as if they were valid for a model. It also pushes consumers toward
client-side conditional code that belongs in the library contract.

## Design Decision

Every model in the registry must have an explicit, strict config contract.

This applies even when two models currently share the exact same shape. Shared
factories are fine internally, but each `ModelDescriptor` must explicitly point
to the config schema and execution adapter semantics for that model. The model
string is the public contract boundary.

Required behavior:

- A config accepted by the model's schema and validator should not later fail in
  the adapter because of a predictable model capability mismatch.
- A config containing fields outside that model's schema must fail validation.
- A config containing both mutually-exclusive fields must fail validation.
- Consumers must not need model-specific `if model startsWith(...)` logic to
  construct valid config.
- Consumers must not need to call library helpers that transform ambiguous
  config into a different config before dispatch.
- Provider adapters may still map valid public config into SDK payloads.
- Provider adapters may still protect provider escape hatches, provider SDK
  quirks, and post-merge invariants, but those checks should be belt-and-suspenders,
  not the primary contract.

## Zod and Strictness

Use strict parsing semantics for model configs.

If Zod is used, avoid the default object behavior where unknown keys are stripped
unless that behavior is explicitly intended. For this contract, unknown keys
should be a failure because silent stripping hides incorrect persisted config and
makes audits harder.

Expected pattern:

```ts
const Gemini31FlashLiteConfig = z
  .object({
    maxOutputTokens: z.number().int().positive().optional(),
    stopSequences: z.array(z.string()).optional(),
    serviceTier: z.enum(['flex', 'standard']).optional(),
    reasoning: z
      .object({
        effort: z.enum(['none', 'low', 'medium', 'high']).optional(),
        includeThoughts: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
```

For a budget-api model, use a distinct config schema:

```ts
const Gemini25FlashConfig = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    topP: z.number().optional(),
    topK: z.number().int().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    stopSequences: z.array(z.string()).optional(),
    serviceTier: z.enum(['flex', 'standard']).optional(),
    reasoning: z
      .object({
        effort: z.enum(['none', 'low', 'medium', 'high']).optional(),
        budgetTokens: z.number().int().nonnegative().optional(),
        includeThoughts: z.boolean().optional(),
      })
      .strict()
      .refine(
        (v) => v.effort === undefined || v.budgetTokens === undefined,
        'Provide either reasoning.effort or reasoning.budgetTokens, not both.',
      )
      .optional(),
  })
  .strict()
```

For level-api models, do not include `budgetTokens` at all. For budget-api models,
including both `effort` and `budgetTokens` must be rejected because that is an
ambiguous request.

## What To Remove

Audit and remove design patterns that normalize ambiguous consumer config:

- the deleted public reasoning helper as a public or recommended boundary for consumer config.
- Consumer-side helpers named like `normalizeConfigForModel`,
  `buildReasoningConfig`, or `withoutDuplicateGeminiReasoningControls`.
- Adapter-first validation for predictable model schema errors.
- Broad schemas with `additionalProperties: true` for model-owned config.
- Shared "family" schemas that are not explicitly attached per model descriptor.

No helper should remain as a normal config-construction path. Provider-local
translation belongs inside the adapter after strict model schema validation.

## Registry Invariants

Add build/test-time checks so a model cannot be onboarded partially.

For every built-in model descriptor:

- `id` is unique.
- `provider` maps to a provider adapter available in the package that claims to
  support that model.
- A strict config schema exists for that exact model id.
- A runtime validator exists for that exact model id.
- The JSON schema exposed for UI/form generation is derived from the same source
  as the runtime validator, or there is a test proving parity.
- The adapter has a test fixture proving it can translate a valid config for
  that model.
- The adapter has a negative test proving invalid model-specific config is
  rejected before provider dispatch.
- Pricing is present or explicitly documented as unpriced/unsupported by strict
  pricing mode.
- Capability flags match both the schema and adapter behavior.

Recommended invariant test:

```ts
import { defaultGeminiRegistry } from '@gullabs/google'

for (const descriptor of defaultGeminiRegistry.listDescriptors()) {
  expect(descriptor.configJsonSchema).toBeDefined()
  expect(descriptor.validateConfig).toBeDefined()
  expect(hasAdapterFixture(descriptor.id)).toBe(true)
}
```

Do not stop at presence checks. Add contract tests that feed known-good and
known-bad configs through the descriptor validator and verify adapter dispatch is
not reached for bad configs.

## Onboarding Rule For New Models

Create or update an onboarding doc so adding a model requires this checklist:

1. Add the model descriptor with exact `id`, `provider`, capability flags, and
   pricing family.
2. Add a model-specific strict config schema, even if it delegates to a shared
   internal factory.
3. Add runtime validation and JSON-schema export from the same source.
4. Add adapter mapping tests for the model's valid config.
5. Add negative tests for unsupported sampling, unsupported reasoning controls,
   unsupported service tiers, and unsupported provider features.
6. Add pricing behavior or document why the model is intentionally unpriced.
7. Add docs describing supported config fields for that model.
8. Run the full quality gate before publishing.

A model string existing in the registry without schema, validator, and adapter
coverage should fail CI.

## Audit Instructions For Another LLM

Follow these steps in the `any-llm` repo.

### 1. Read The Current Contract

Start with:

- `docs/architecture.md`
- `packages/core/src/registry.ts` (generic registry machinery only — no
  provider-specific schemas)
- `packages/core/src/engine.ts`
- `packages/core/src/reasoning.ts`
- `packages/google/src/models.ts` (Gemini/Gemma model descriptors and schemas)
- `packages/google/src/adapter.ts`
- `packages/core/src/config-validation.test.ts`
- `packages/core/src/registry.test.ts`
- `packages/google/src/adapter.test.ts`

Write down where config is accepted, merged, projected, validated, transformed,
and finally sent to a provider.

### 2. Find Boundary Leaks

Search for these patterns:

```bash
rg -n "additionalProperties: true|normalize|reasoningApi|providerOptions|Object.assign|validateConfig|configJsonSchema|thinkingBudget|thinkingLevel|serviceTier|sampling" packages docs
```

For each hit, classify it:

- Correct contract definition.
- Acceptable adapter translation.
- Adapter-only validation that should move earlier.
- Consumer/workaround normalization that should not exist.
- Provider escape hatch that needs stricter guardrails.

### 3. Build A Model Config Matrix

For every built-in model, produce a table with:

- Model id.
- Provider.
- Reasoning API: none, budget, or level.
- Allowed reasoning fields.
- Allowed reasoning efforts.
- Sampling mode and allowed sampling fields.
- Service tiers.
- Structured output support.
- Grounding support.
- Vision/audio support.
- Pricing status.
- Strict schema file/export name.
- Runtime validator file/export name.
- Adapter test fixture name.

Any blank cell is a finding.

### 4. Prove Schema And Adapter Parity

For each model class, add tests proving:

- Valid config passes descriptor validation and reaches adapter translation.
- Unknown top-level fields fail.
- Unknown `reasoning` fields fail.
- Gemini fixed-sampling models reject `temperature`, `topP`, and `topK`.
- Gemini level-api models reject `budgetTokens`.
- Gemini budget-api models reject both `effort` and `budgetTokens` together.
- Models that do not support a feature reject that feature before dispatch.
- `providerOptions.google` cannot bypass core model invariants after merge.

### 5. Audit Public API Shape

Check exports from `packages/core/src/index.ts`,
`packages/google/src/index.ts`, and `packages/any-llm/src/index.ts`.

Flag public exports that encourage consumers to repair or normalize configs
outside the model schema boundary. The desired public API is:

- discover model descriptor;
- parse/validate config for that descriptor;
- pass parsed config into `generate` or `runStructured`.

### 6. Update Documentation

Update:

- `docs/architecture.md`, section "Registry as Config Schema Layer";
- package README examples that mention model config;
- a new or existing model onboarding guide.

Docs must state that model configs are strict and model-specific, and that
consumers should not write per-model conditional config code.

### 7. Verification Gate

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm -r build
```

If the repo prefers one combined gate, run:

```bash
pnpm quality
```

Record any failures with exact command output and whether the failure is related
to the contract work or pre-existing.

## Expected End State

The end state is not just "Gemini no longer errors." The end state is:

- invalid model configs cannot be persisted or dispatched unnoticed;
- each model publishes a strict config contract;
- CI fails when a new model lacks config/schema/adapter coverage;
- consumers do not contain model-specific config cleanup;
- adapters translate valid config and defend escape hatches, but do not own the
  primary model contract.
