# Strict Model Config Schema Implementation Plan

## Status

Executed — kept as a historical record of the plan as written. Two details have
since been superseded by the provider-plugin refactor (ADR-023): the per-model
Gemini/Gemma schemas now live in `@gullabs/google` (not `@gullabs/core`), and
`flexFallback` is no longer a top-level `GenConfig` field — it lives under
`providerOptions.google.flexFallback`. References below to a top-level
`flexFallback` or to core-owned model schemas reflect the layout at the time of
writing.

The model references below are also a historical freeze. The 2026-09-25
refresh deleted `gemini-3.5-flash` and `gemini-3-flash-preview`; see
[`model-config-provider-evidence.md`](./model-config-provider-evidence.md#2026-09-25-refresh)
for the current catalog.

Draft plan for implementation after `docs/model-config-strict-schema-design.md`.

Inputs:

- Local audit: `docs/model-config-contract-audit.md`
- Signed-off design: `docs/model-config-strict-schema-design.md`
- Repo-wide P0 rule: `CLAUDE.md`, `AGENTS.md`, and `DECISIONS.md` say backward
  compatibility is not a design constraint and legacy/dead compatibility code
  must be deleted.
- Architecture/API expert review: model-owned Zod schema boundary approved.
- Provider-contract expert review: current implementation is not strict enough.
- Claude design review: second pass approved.
- Public docs checked on 2026-07-05:
  - https://ai.google.dev/gemini-api/docs/generate-content/thinking
  - https://ai.google.dev/gemini-api/docs/generate-content/structured-output
  - https://ai.google.dev/gemini-api/docs/generate-content/flex-inference
  - https://ai.google.dev/gemini-api/docs/generate-content/priority-inference
  - https://ai.google.dev/gemini-api/docs/interactions-overview
  - https://ai.google.dev/api/generate-content
  - https://zod.dev/json-schema
  - https://zod.dev/v4

## Executive Plan

Build strict model config as a schema-first boundary in `@gullabs/core`.

Every built-in supported model must have an exact model-id Zod schema, full
field docs in schema metadata, derived JSON Schema, Standard Schema validation,
adapter fixtures, and negative tests. The adapter should receive parsed config,
not a stringly typed config bag it has to repair.

Hard rules:

- A supported built-in model without a strict documented Zod schema is not
  supported.
- The library boundary is the parsed model schema, not hand-written JSON
  Schema, string JSON, best-effort coercion, or adapter-side validation.
- Do not add compatibility translations, alias normalization, config repair,
  migration helpers, fallback parsers, or model-conditional config mutation.
- Model-specific capability differences must be encoded in that model's schema
  by accepting only valid fields and omitting unsupported fields.
- The only allowed provider mapping is the final adapter projection from an
  already-validated typed config object to the provider SDK request shape. That
  projection must not broaden the public contract or repair invalid config.

This is not just a validation cleanup. It fixes a design quality problem:
today, callers can persist invalid config that looks valid in JSON Schema,
passes registry validation, and fails later in the Google adapter. That is the
wrong boundary for a library. The public contract must fail early, tell the
caller exactly which field is wrong, and make UI generation reflect the same
contract the runtime enforces.

## Non-Negotiables

1. Zod is the source of truth for built-in model config.
2. JSON Schema is always derived with `z.toJSONSchema()`.
3. Built-in model schemas use `z.strictObject()` at every object boundary.
4. No shared final schema fragments between model files.
5. No public helper that "fixes" config by inspecting model strings.
6. No raw `providerOptions.google` merge into generation config.
7. Unsupported provider fields fail before network dispatch.
8. Adding a built-in model without schema, docs, JSON Schema, validation, and
   adapter fixtures fails CI.
9. Provider docs are evidence, not an excuse to accept ambiguous persisted
   config.
10. No compatibility shims, deprecated aliases, compatibility modes, feature
    flags, or fallback paths are allowed. Delete the old path when the clean
    path lands.

## P0 Legacy Deletion Rule

This plan follows the repo-wide rule in `CLAUDE.md`, `AGENTS.md`, and
`DECISIONS.md`: legacy-preserving behavior is not a constraint until the owner
explicitly revises that rule.

Implementation must delete the old config contract, not wrap it:

- Delete public repair helpers instead of deprecating them.
- Delete broad family-level schema factories instead of keeping them for custom
  callers.
- Delete tests that assert old behavior unless they are rewritten as negative
  tests proving the old path is gone.
- Delete docs, README examples, package skill text, and comments that teach
  legacy config repair.
- Do not add a `strict` flag, compatibility mode, fallback default, alias layer,
  adapter shim, or legacy parser.
- If a phase cannot complete without temporarily keeping old and new behavior
  side by side, that phase is too large and must be split differently. The
  merged state must always move toward deletion, not dual support.

## Research Updates That Change The Design

### Gemini 3 thinking should be level-only in the public contract

Google's current GenerateContent thinking docs recommend `thinkingLevel` for
Gemini 3 and later. The docs say `thinkingBudget` may still be accepted by the
provider on some Gemini 3 paths, but may cause unexpected performance on Gemini
3 Pro.

Decision: reject `reasoning.budgetTokens` for every level-api model in the
library schema. Provider acceptance is not the library contract. The clean
contract keeps persisted config stable, readable, and portable across models.

### Thinking-off support needs model-specific correction

Current docs say:

- Gemini 3.1 Pro cannot disable thinking.
- Gemini 3 Flash and Flash-Lite do not support full thinking-off.
- Gemini 2.5 Pro uses `thinkingBudget`, has a range of `128..32768`, and cannot
  disable thinking.
- Gemini 2.5 Flash supports `0..24576` and can disable thinking with `0`.
- Gemini 2.5 Flash-Lite has a documented range of `512..24576`, but also lists
  `thinkingBudget = 0` as the disable setting.

Decision: implementation must revise the current descriptor effort sets instead
of blindly carrying them forward. In particular, `effort: 'none'` must not map
to `thinkingBudget: 0` for `gemini-2.5-pro`, and `effort: 'none'` must be
explicitly excluded or reverified for Gemini 3.1 Pro Preview, Gemini 3 Flash,
and Gemini 3 Flash-Lite before any schema is published.

### Structured output with tools is narrower than "all Gemini 3"

Current structured-output docs say structured outputs with tools are preview and
available only to `gemini-3.1-pro-preview` and `gemini-3.5-flash`.

Decision: the current blanket ban on grounding plus structured output is too
broad, but the replacement must be exact. Permit it only for the exact
GenerateContent models and tool shapes documented and tested. Everything else
continues to fail early. ADR-013 currently documents the old blanket guard and
must be rewritten when this guard becomes model-aware.

### Flex and Priority defaults should follow provider docs

Google docs now say omitted `serviceTier` defaults to standard for both Flex and
Priority. The current library injects `serviceTier: 'flex'` by default, which
can make normal Gemma calls invalid and turns a latency/cost policy into hidden
global behavior.

Decision: strict config should stop injecting Flex globally. Omit `serviceTier`
unless the caller explicitly asks, or unless a later product decision adds a
documented client default outside the model schema. This is a breaking behavior
change and should be called out in the changeset.

Priority is real but should stay blocked for now. It has preview status, Tier
2/3 eligibility, premium pricing, and downgrade monitoring semantics. Add it
only after served-tier recording and pricing policy are designed.

### Interactions API is GA but out of scope for this PR set

Google now recommends Interactions for new projects, while GenerateContent is
still fully supported.

Decision: do not mix Interactions adoption with strict config schemas. Add
`apiMode` as an internal schema/version hook where needed, reserve incompatible
provider keys, and create a follow-up design for Interactions.

### Zod 4 is the right dependency

Zod 4 has first-party JSON Schema conversion with `z.toJSONSchema()`, copies
metadata from `.meta()` / `z.globalRegistry`, and throws on unrepresentable
schema features by default.

Decision: add `zod@^4` to the appropriate packages and do not add
`zod-to-json-schema`. Avoid transforms, custom validators, and refinements for
constraints that must appear in JSON Schema. Use structural Zod shapes such as
strict objects, unions, enums, min/max, and array length constraints.

## Target File Layout

At plan time this targeted a core-owned location. As shipped, the
provider-plugin-architecture split moved every Gemini/Gemma-specific file out
of `@gullabs/core` and into `@gullabs/google`; core kept only the
provider-agnostic pieces (`index.ts`, `standard-schema.ts`, `json-schema.ts`
equivalents — `packages/core/src/model-config/index.ts` exporting
`toConfigJsonSchema`/`zodToStandardSchema`):

```text
packages/core/src/model-config/
  index.ts               # toConfigJsonSchema, zodToStandardSchema — generic, no provider knowledge

packages/google/src/
  models.ts               # geminiModelDescriptors, gemmaModelDescriptors, defaultGeminiRegistry
                           # (per-model schemas for gemini-2.5-pro, gemini-2.5-flash, ...,
                           # gemma-4-31b-it, gemma-4-26b-a4b-it)
```

Each model owns its full schema. Do not import shared reasoning/provider
schema fragments. If two models have identical fields, duplicate the schema in
the model definition. This is intentional: model docs drift independently, and
the cost of a little duplication is lower than another family-level
abstraction that lies about exact support.

Evidence table:

```text
docs/model-config-provider-evidence.md
```

## Phase 0: Evidence Freeze

Goal: make the model matrix explicit before touching behavior.

Tasks:

- Add `docs/model-config-provider-evidence.md` listing each built-in model,
  reasoning API, admitted efforts, budget range, sampling mutability,
  structured output support, structured-output-with-tools support, supported
  service tiers, and public doc/live-probe source.
- Verify exact model IDs against current docs or live Google API where public
  docs are unclear.
- Treat `gemini-3.1-flash-lite` and the two Gemma 4 IDs as requiring explicit
  verification notes because the public docs and prior live-probe notes do not
  have the same evidence shape.
- Record the exact evidence for each model that excludes `effort: 'none'`,
  including `gemini-3.1-pro-preview`, Gemini 3 Flash, Gemini 3 Flash-Lite, and
  `gemini-2.5-pro`.
- Record which contract decisions intentionally reject provider-accepted aliases,
  especially Gemini 3 `thinkingBudget`.
- Inventory every legacy/dead compatibility path to delete, including exported
  repair helpers, broad schema factories, provider-options overwrite tests,
  implicit Flex defaults, required adapter-facing `serviceTier`, and docs that
  teach model-string config repair.

Acceptance:

- A reviewer can see why every schema field exists.
- No supported model is "trusted from memory" without a doc link or live-probe
  note.
- Ambiguous items are marked blocked or experimental, not silently allowed.
- The deletion inventory names the source files, tests, docs, and exports that
  must disappear before signoff.

## Phase 1: Schema Infrastructure

Goal: introduce Zod as the only schema infrastructure without adding a
compatibility mode.

Tasks:

- Add `zod@^4` where the runtime schema objects live.
- Add a `zodToStandardSchema()` adapter that exposes `safeParse()` as the
  repo's existing `StandardSchemaV1`.
- Add a `toConfigJsonSchema()` helper that calls `z.toJSONSchema()` with
  `unrepresentable: 'throw'`.
- Update `ModelDescriptor` so built-in descriptors require `configSchema`,
  `configJsonSchema`, and `validateConfig`.
- Keep custom registries as a supported extension point, but require every
  custom descriptor to publish the same schema artifacts as built-ins:
  `configSchema`, derived `configJsonSchema`, and `validateConfig`. Delete
  support for descriptor objects that omit those schema artifacts. Do not add a
  non-strict registry mode.
- Update the registry contract so `createModelRegistry()` throws when any
  descriptor is missing required schema artifacts.
- Update ADR-006 and ADR-010 in `DECISIONS.md` to document strict custom
  descriptors and remove the old optional hand-written schema framing.

Acceptance:

- A unit test proves Zod metadata appears in derived JSON Schema.
- A unit test proves unrepresentable Zod constructs fail JSON Schema generation.
- No new compatibility flag or non-strict validation path exists.
- Custom descriptor tests prove missing schema artifacts fail at registry
  construction.

## Phase 2: Exact Model Schemas

Goal: replace family-level config schema with exact model contracts.

Precondition:

- No model schema ships while its Phase 0 evidence row has an open `verify`,
  `unknown`, or `experimental` cell for a field the schema would publish.

Tasks:

- Implement one complete strict schema per supported built-in model.
- Delete the Gemini config schema factories and replace every built-in descriptor's broad
  hand-written JSON Schema with derived JSON Schema from its exact Zod schema.
- Duplicate schema shape in each model file, including field docs.
- Do not share schema fragments between model schemas. Local duplication is the
  intended design because it keeps each model contract inspectable and prevents
  accidental family-level coupling.
- Encode top-level fields: `temperature`, `topP`, `topK`,
  `maxOutputTokens`, `stopSequences`, `timeoutMs`, `serviceTier`, `reasoning`,
  and `providerOptions` (as shipped, `flexFallback` is not a core `GenConfig`
  field — it is a `GoogleProviderOptions` field reached via
  `providerOptions.google.flexFallback`; each schema still encodes it inside
  that provider-options allowlist).
- Encode model-specific fixed sampling by omitting fields, not by accepting and
  rejecting them later.
- Encode reasoning as structural unions:
  - budget-api models: `effort` variant or `budgetTokens` variant, never both.
  - level-api models: `effort` variant only, no budget field.
  - models without reasoning: no `reasoning` field.
- Encode exact effort sets per model after Phase 0 evidence.
- Add full `.meta({ title, description, examples })` or `.describe()` docs for
  every public field.

Acceptance:

- `defaultGeminiRegistry.listDescriptors()` (exported by `@gullabs/google`, not
  core) returns only descriptors with all three schema artifacts.
- Every built-in schema has `additionalProperties: false` in derived JSON
  Schema at every object boundary.
- Negative tests reject unknown keys, wrong scalar types, unsupported sampling,
  invalid service tiers, impossible reasoning combinations, and provider-owned
  reserved keys.
- Negative tests reject `flexFallback` unless the same parsed config explicitly
  sets `serviceTier: 'flex'`.
- No built-in descriptor imports or calls a family-level config schema factory.

## Phase 3: Engine Validation And Defaults

Goal: validate the whole caller config before the Google adapter sees it.

Tasks:

- Parse full config through `descriptor.configSchema` during request
  resolution.
- Store or pass the parsed config object forward.
- Remove global automatic `serviceTier: 'flex'` injection.
- Change the adapter-facing port contract deliberately. Today
  `ResolvedRequest.config` in `packages/core/src/ports.ts` and the engine's
  internal `ResolvedConfig` type require `serviceTier` because the engine always
  defaulted it. This phase must relax that invariant to `GenConfig` with
  optional `serviceTier`, update the comments, and fix every downstream read
  that assumed presence.
- Keep client-level defaults as raw caller input, but validate the fully merged
  result through the target model schema after client defaults, call-site config,
  and per-call config are combined.
- Delete tests that assert `serviceTier` defaults to Flex and replace them with
  tests asserting omitted `serviceTier` stays omitted.
- Keep `flexFallback` meaningful only when `serviceTier: 'flex'` is explicit.
- Audit retry service-tier pinning in `packages/core/src/retry.ts`. A retry
  must not inject a pinned tier into a model whose descriptor has no
  `serviceTiers`, and a pinned served tier must be revalidated against the
  descriptor before it is written into the next attempt's config.
- Update Google adapter timeout and fallback logic so missing `serviceTier`
  means provider-standard request behavior, not an implicit Flex or Standard
  enum write.
- Make validation errors include model ID, config path, and a direct corrective
  message.

Acceptance:

- A Gemma request with no `serviceTier` does not receive a hidden Flex tier.
- A Gemini request with no `serviceTier` omits the field and uses provider
  standard behavior.
- Caller defaults, call-site config, and per-call config cannot combine into an
  invalid shape without failing before adapter dispatch.
- Type tests or compile-time assertions prove `ResolvedRequest.config` no longer
  requires `serviceTier`.
- Retry tests prove tierless models stay tierless across retries, including
  after an adapter result or error contains a served tier.
- No code path can restore the old implicit Flex default.

## Phase 4: Provider Options Lockdown

Goal: turn `providerOptions.google` into a typed extension lane, not a second
generation config API.

Tasks:

- Remove raw `Object.assign(config, providerOptions.google)`.
- Define the allowed Google provider-options shape per model/API mode.
- Replace the current blanket grounding-plus-structured-output adapter guard
  with an exact model/API-mode/tool-shape guard. Permit structured output plus
  Google Search only for the documented GenerateContent allowlist
  (`gemini-3.1-pro-preview`, `gemini-3.5-flash`) and reject it everywhere else.
- Reserve and reject model-owned keys:
  `thinkingConfig`, `responseMimeType`, `responseSchema`,
  `_responseJsonSchema`, `responseJsonSchema`, `responseFormat`,
  `serviceTier`, sampling fields, `tools` when not allowed, `mediaResolution`,
  `speechConfig`, `imageConfig`, and `responseModalities`.
- Allow only documented, tested keys such as `safetySettings`, `cachedContent`,
  and exact `tools` variants where the model supports them.
- Validate `tools` by exact shape, not by accepting any object.
- Delete tests and docs that present `providerOptions.google` as a caller-wins
  SDK config override lane.

Acceptance:

- Existing tests that prove provider options can override `serviceTier` are
  replaced with tests proving override is rejected.
- Structured output plus Google Search is accepted only for the exact
  documented models and tool shapes.
- Provider options cannot overwrite a field already produced by typed config
  mapping.
- There is no allow-unknown Google provider-options escape hatch.
- Tests cover both sides of the grounding guard: allowed exact models/tool shape
  pass, all other models/tool shapes fail before provider dispatch.

## Phase 5: Google Adapter Simplification

Goal: make the adapter a translator, not the first real validator.

Tasks:

- Assume parsed config for built-ins, but keep defensive errors for custom
  descriptors and direct adapter tests.
- Convert budget reasoning to `thinkingBudget` only for budget-api models.
- Convert level reasoning to `thinkingLevel` only for level-api models.
- Do not normalize invalid user config into a valid provider request.
- Keep adapter-level provider quirks only where they are truly provider mapping
  concerns.
- Delete adapter branches whose only purpose is repairing invalid built-in
  config that the schema now rejects.

Acceptance:

- The adapter has fewer model-contract branches.
- Invalid built-in config is rejected in core tests before Google adapter tests.
- Adapter tests focus on exact SDK request payloads for valid parsed config.
- Adapter tests fail if model-owned invalid config reaches the adapter through a
  built-in descriptor path.

## Phase 6: Public API Cleanup

Goal: remove the APIs that made ambiguous config feel supported.

Tasks:

- Remove public exports for the deleted reasoning helper family and Gemini
  config factory family.
- Remove the core `EFFORT_BUDGET` export; provider-local effort-to-budget mapping
  belongs inside the Google package.
- Add a public `parseModelConfig(model, config, registry?)` helper only if it
  delegates to the descriptor schema and does not mutate config.
- Update README, package docs, and skill docs that currently teach helper-based
  config repair.
- Delete any backwards-looking aliases, re-export stubs, or deprecation notices
  for the removed helpers.

Acceptance:

- Public exports snapshot test fails if the removed helper APIs reappear.
- Docs show schema parsing as the only supported boundary.
- No docs tell users to persist model-agnostic reasoning budgets and repair them
  later.
- Importing a removed helper fails at compile time; there is no runtime warning
  path or deprecated stub.

## Phase 7: Breaking-Change Documentation

Goal: document the new contract without preserving old APIs.

Tasks:

- Add a breaking-change note for strict model config.
- Add examples for:
  - reading `descriptor.configJsonSchema` for UI forms.
  - parsing persisted config with `descriptor.configSchema`.
  - replacing `reasoning.budgetTokens` on Gemini 3 models with `effort`.
  - removing `effort: 'none'` on models that cannot disable thinking.
  - explicitly opting into Flex.
- Explain why omitted `serviceTier` now means provider default standard.
- Explain why Priority is still rejected even though Google documents it.
- Delete docs and skill text that mention removed helpers, old Flex defaults,
  provider-options caller-wins behavior, or broad JSON Schema as the contract.
- Update `DECISIONS.md`:
  - ADR-006: custom registries remain supported only with strict descriptor
    schema artifacts.
  - ADR-009: scope the no-Zod-dependency claim to output validation only; model
    config schemas now use Zod at runtime.
  - ADR-010: Zod schema is the source of truth; hand-written JSON Schema and
    projection-only validation are deleted.
- ADR-013: grounding plus structured output is no longer a blanket hard guard;
  it is an exact model/API-mode/tool-shape guard.
- ADR-017: fixed-sampling enforcement comes from per-model Zod schema field
  omission and strict objects, not the deleted validator factory.

Acceptance:

- Every breaking error has a replacement example for the new contract.
- The docs make the design tradeoff clear: strict persisted config beats
  provider-accepted aliases.
- Documentation explains the new contract but does not provide legacy helper
  APIs, shims, or compatibility recipes.

## Phase 8: Quality Gate

Run the full gate before signoff:

```bash
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm -r build
pnpm quality
```

Additional targeted tests:

- Schema matrix invariant: every built-in descriptor publishes Zod, JSON Schema,
  Standard Schema, docs metadata, and negative fixtures.
- No manual `configJsonSchema` for built-ins.
- No raw `Object.assign` or object spread from `providerOptions.google` into SDK
  generation config.
- No exported repair helpers.
- No required-service-tier wrapper type remains in the adapter-facing
  request path.
- Retry never pins or injects a service tier that the descriptor schema would
  reject.
- No deleted Gemini config factories, deleted reasoning helper exports,
  deprecated export stubs, compatibility flags, non-strict registry mode, or
  old Flex-default assertions remain.
- JSON Schema snapshot tests for every supported model.
- Adapter payload snapshots for valid examples per model family.

## PR Sequence

1. Evidence and invariant scaffolding.
2. Zod infrastructure with no compatibility mode.
3. Exact Gemini 2.5 schemas and reasoning corrections.
4. Exact Gemini 3/Gemma schemas and fixed-sampling corrections.
5. Engine validation and service-tier default change.
6. Provider-options lockdown.
7. Public API cleanup and docs.

This should not be one large PR. The current behavior has several independent
contract seams, and smaller PRs make it possible to review whether each boundary
got stricter without losing a regression in the noise.

## Follow-Up Designs Not In This Plan

- Interactions API adoption design.
- Priority tier support with served-tier recording and pricing policy.
- GenerateContent structured-output modernization around `responseFormat`.
- Caller-side semantic validation of model output.
- Live model-contract probe automation in CI, if API-key policy allows it.

## Risk Register

### Breaking Flex default

Risk: existing callers may depend on implicit Flex.

Mitigation: document clearly, add changeset, and require explicit
`serviceTier: 'flex'`. Do not add a compatibility flag for the old default
unless the owner explicitly revises the repo-wide no-legacy rule.

### Provider docs drift during implementation

Risk: model capability docs change while schemas are being added.

Mitigation: Phase 0 evidence table includes checked date and source. Exact model
schemas include tests. Ambiguous models stay blocked until verified.

### Zod bundle footprint

Risk: runtime dependency size increases for consumers.

Mitigation: use Zod 4 only in core schema modules, avoid bringing Zod into hot
adapter paths unnecessarily, and evaluate `zod/mini` only if bundle analysis
shows a real problem.

### JSON Schema mismatch

Risk: a Zod construct validates correctly but does not convert to useful JSON
Schema.

Mitigation: no transforms/custom refinements for public constraints, conversion
with `unrepresentable: 'throw'`, and snapshot derived JSON Schema for every
model.

## Done Definition

This work is done only when all built-in supported models publish strict,
documented Zod schemas and there is no path for invalid model-owned config to
pass core validation and fail later in the adapter.

Anything less keeps the same design flaw with a nicer wrapper.
