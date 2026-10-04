# Plan: OpenAI-strict output-schema handling (codex-cli helper + preflight; xai facts codified)

Status: IMPLEMENTED (branch feat/openai-strict-output-schema). Plan APPROVED by codex in 4 rounds (final session 019f4a22-6461-7ad0-98ac-d2f6dd08ee6c, 2026-07-09). NOTE: mentions of the deleted symbol `assertAdditionalPropertiesFalseDeep` below are historical spec context describing what was replaced; the symbol no longer exists anywhere in code, tests, README, or changesets.
Date: 2026-07-09
Origin: a host application consumer feedback — "codex-cli@0.4.0 still doesn't do strict-schema
rewriting, so the app-side transformer stays (renamed
`translateOpenAiStrictResponseSchema`) and is reused for grok, whose adapter also
forwards schemas verbatim to an OpenAI-strict endpoint."

## 0. Live-verified facts (2026-07-09, both probed today)

### xAI (grok-4.5, Responses API `text.format` json_schema, 13 probes, all HTTP 200)

xAI's `strict: true` performs **no OpenAI-style compile-time schema validation**.
Accepted live: root and nested objects missing `additionalProperties:false`;
properties omitted from `required`; `format`, `minLength`, `pattern`, `default`;
`anyOf`; `$defs`/`$ref`; `enum`/`const`; `type: ['string','null']`; and
`strict: false` on the same surface with no observed behavioral divergence.

**Consequence:** the consumer's premise is wrong for grok — no strict rewriting is
needed or useful there, and adding a client-side strict preflight to the xai
adapter would REJECT input the provider accepts (a violation of our reject-don't-map
contract, which cuts both ways: we also must not reject provider-valid input).

### codex CLI `--output-schema` (12 probes against the real binary + backend)

Rejections are server-side (OpenAI Responses structured-outputs validator), HTTP 400
`invalid_json_schema`, surfaced in the `--json` stdout stream after a full network
round-trip. Exactly two structural rules are enforced:

1. Every object node (root and nested) must carry `additionalProperties: false`.
   Error: `In context=(...), 'additionalProperties' is required to be supplied and
to be false.`
2. `required` must be supplied and include **every** key in `properties`.
   Error: `In context=(...), 'required' is required to be supplied and to be an
array including every key in properties. Missing '<key>'.`

Everything else tested is accepted: `format`, `minLength`, `pattern` (enforced),
`default` (accepted, ignored), `anyOf`, `$defs`/`$ref`, `enum`/`const` (enforced),
nullable via `type: [T,'null']`.

Our adapter's existing local preflight (`assertAdditionalPropertiesFalseDeep`,
packages/codex-cli/src/adapter.ts) covers rule 1 only. A rule-2 violation today
costs a live GPT-5 round-trip before failing with a provider error instead of a
local typed `bad_request`.

## 1. Scope — three deliverables

### D1. codex-cli: extend the local preflight to cover rule 2

Replace `assertAdditionalPropertiesFalseDeep` with
`assertOpenAiStrictOutputSchema(schema)` in packages/codex-cli/src/adapter.ts:

- Traversal completeness is a design requirement, not an inheritance: the walker
  must visit every subschema position defined by JSON Schema draft 2020-12 through
  which an object node can be reached — `properties` values, `patternProperties`
  values, `additionalProperties` (when a schema, not a boolean), `items`,
  `prefixItems` members, `contains`, `anyOf`/`oneOf`/`allOf` members, `not`,
  `if`/`then`/`else`, `dependentSchemas` values, `propertyNames`,
  `unevaluatedProperties`/`unevaluatedItems` (when schemas), `contentSchema`,
  and `$defs`/`definitions` values. Completeness is enforced mechanically, not
  by trust: a unit test pins the COMPLETE required traversal set — the full
  draft-2020-12 applicator + content vocabulary subschema keywords PLUS the
  core-vocabulary reference containers `$defs` and legacy `definitions` — as an
  explicit literal list taken from this plan, and asserts the walker's keyword
  set is a superset of that pinned list. Any future omission of ANY enumerated
  position (including `$defs`/`definitions`) fails CI rather than silently
  narrowing coverage.
  Rationale: the backend validates the whole schema
  document (its error paths are arbitrary `In context=(...)` tuples), so a walker
  that skips any subschema position silently misses nodes the backend will reject
  — exactly the blind spot reject-don't-map forbids. The existing walker's
  narrower set is replaced, not preserved.
- The walker is implemented ONCE (a shared internal traversal in
  packages/codex-cli/src) and consumed by BOTH the D1 preflight and the D2 helper,
  so the two surfaces cannot drift.
- Rule 1 check semantics unchanged (path-bearing error message as today).
- NEW rule 2 check: at every object node that has a `properties` object, `required`
  must be an array containing every key of `properties`. On violation throw
  `bad_request` naming the node path and the first missing key. Remediation text
  is generalized (it must be correct for ALL admitted property shapes): "every
  property must be listed in `required`; express optionality as a null union —
  see `toOpenAiStrictOutputSchema`" — it does NOT prescribe a concrete rewrite
  shape, and states the adapter will not rewrite schemas.
- Preflight rejects ONLY the two live-verified rules — nothing we have not seen
  the backend reject.
- Tests: positive (strict-valid passes incl. `$defs`/`anyOf`/nullable), negative
  per rule at root and nested depth, path correctness, and the existing rule-1
  tests keep passing.

### D2. codex-cli: explicit opt-in rewriting helper

New export from `@gullabs/codex-cli`: `toOpenAiStrictOutputSchema(schema)`.
The name is deliberately scoped: this is a provider-surface-specific
structured-OUTPUT-schema transformer with opinionated semantics (see below), not
a generic "make this schema OpenAI-compatible" canonicalizer.

- Pure function, deep-clones; never mutates input; adapter NEVER calls it — the
  caller opts in explicitly at the call site. This is not a silent mapping layer;
  it is a documented, named transformation, satisfying the no-compat/no-silent-map
  rules.
- Transform, applied recursively via the SAME shared walker as the D1 preflight:
  1. Every object node gets `additionalProperties: false` (only when absent;
     an explicit `additionalProperties: true`/schema value is REJECTED with
     `bad_request` — rewriting an explicit contradiction would silently invert
     caller intent).
  2. For every object node with `properties`: `required` handling is fully
     specified over the rule-2-invalid input space — if `required` is absent it
     is treated as the empty list (every property is optional and remediated);
     if `required` is present but not an array of strings, the helper REJECTS
     with `bad_request` naming the node path (a malformed keyword is not
     optionality intent, and rewriting it would be guessing). Otherwise, keys
     missing from `required` are added to `required`, and each such
     previously-optional property has `null`
     added to its type (`type: T` → `type: [T,'null']`; already-nullable left
     alone). Properties whose optionality cannot be expressed this way (no `type`,
     e.g. bare `anyOf` members) get `anyOf: [<original>, {type:'null'}]`.
     This preserves caller intent (optional ⇒ nullable-required, per OpenAI's own
     strict-mode guidance) instead of silently making values mandatory.
- Result is guaranteed to pass `assertOpenAiStrictOutputSchema`.
- Tests: idempotence (`f(f(x)) === f(x)` deep-equal), clone purity, each transform
  branch, the explicit-`additionalProperties:true` rejection, and an end-to-end
  assertion that helper output passes the D1 preflight for a gnarly fixture
  (nested objects + `$defs` + `anyOf` + optional props).
- README + JSDoc: state the two backend rules verbatim (with probe date) and the
  optional→nullable-required semantic change. All claims about provider behavior
  are time-bounded: "as of the 2026-07-09 live probes, xai/grok does not need
  this" — never phrased as a timeless product truth.

### D3. xai: codify the no-op-strict finding (docs + fixture test; zero behavior change)

- Add one sanitized live fixture (schema with missing `additionalProperties`,
  optional prop, and `format` keyword → HTTP 200) to
  `packages/xai/src/__fixtures__/` and a fixture test asserting the adapter forwards
  such schemas verbatim and parses the response normally.
- packages/xai/README.md structured-output section: document that as of the
  2026-07-09 live probes xAI performed no strict-mode schema validation (list what
  was accepted), that schemas are forwarded verbatim, and that OpenAI-strict
  rewriting (incl. D2's helper) is therefore unnecessary for xai as of that
  verification date.
- packages/any-llm/skills/any-llm/SKILL.md: short addition mirroring the above +
  the D2 helper for codex-cli.

## 2. Explicitly out of scope

- NO strict preflight or rewriting in the xai adapter (provider accepts these
  inputs; rejecting them would be a contract violation).
- NO changes to core — this is provider-local per ADR-023.
- NO new ADR (behavioral clarification + one explicit helper; DECISIONS.md gets
  nothing).
- NO compatibility aliases: `assertAdditionalPropertiesFalseDeep` is replaced,
  not kept.

## 3. Process

- Branch `feat/openai-strict-output-schema` off main.
- Implementation by sonnet agents: one for D1+D2 (same package, sequential), one
  for D3 (parallel, independent package).
- Single commit (small surface) or two (codex-cli, xai) — codex reviewer's call.
- Changesets: `@gullabs/codex-cli` minor (breaking-as-minor pre-1.0),
  `@gullabs/xai` patch (docs + test only), `@gullabs/any-llm` patch (SKILL.md
  ships in this package).
- INTENTIONAL OBSERVABLE BEHAVIOR BREAK (stated in the changeset): schemas that
  violate rule 2 previously dispatched to the backend and failed after a network
  round-trip with a provider-classified error; they now fail locally, before
  dispatch, with a typed `bad_request`. Additionally, the widened walker (D1)
  means rule-1/rule-2 violations in previously-unvisited subschema positions
  (`prefixItems`, `patternProperties`, `if`/`then`/`else`, …) are now caught
  locally too. Both changes convert provider 400s into earlier local rejections
  for schemas the backend already rejects; no schema the backend accepts becomes
  rejected.
- Gates: `pnpm quality` + explicit `pnpm typecheck`; coverage thresholds hold.
- Every commit codex-signed; PR to main; publish via CI changesets flow.

## 4. Probe artifacts

Scratchpad (session-local): `xai-strict-probes/` (13 result JSONs + summary) and
`codex-schema-probes/` (12 result JSONs + summary + raw run logs). D3's fixture is
sourced from these. Before merge, copy both probe directories to
`[host-repo]`
for durable reference (same convention as the xai live-verification artifacts).
