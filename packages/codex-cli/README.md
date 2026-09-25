# @gullabs/codex-cli

Dev-only provider adapter that routes `any-llm` calls through a
locally-authenticated `codex` (OpenAI Codex CLI) session instead of a billed
API.

> **DEV-ONLY.** This package shells out to a locally-authenticated `codex`
> CLI session. It is impossible to run in production by construction. Never
> use this as a fallback for an API provider — it exists purely to make
> iterating on long Temporal workflows free during development.

The adapter is text-only, pure (no cost computation, no schema validation of
structured output), and never invokes the real `codex` binary from the
committed test suite — tests inject a fake `CodexCliRunner`.

## Install

```sh
pnpm add -D @gullabs/codex-cli
```

Requires a locally-authenticated `codex` CLI on `PATH` (`codex login`) for
actual use; not required to build or test this package.

## Key exports

| Export                                          | Description                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `codexCliAdapter(opts?)`                        | Builds the `ProviderAdapter` (`id: 'codex-cli'`).                             |
| `CodexCliAdapterOptions`                        | `{ runner?, codexPath?, maxConcurrency? }`.                                   |
| `createCodexCliRunner(codexPath?)`              | Real `node:child_process`-backed `CodexCliRunner`.                            |
| `CodexCliRunner` / `CodexCliRunResult`          | The subprocess seam interface, for injecting fakes.                           |
| `codexCliModelDescriptors` / `codexCliRegistry` | `ModelDescriptor[]` / `ModelRegistry` for the 3 supported models.             |
| `CODEX_CLI_MODEL_IDS`                           | `'gpt-6-astra' \| 'gpt-6-sol' \| 'gpt-6-luna'`. No `gpt-5*` id is registered. |
| `CODEX_CLI_REASONING_EFFORTS`                   | `['low', 'medium', 'high', 'xhigh', 'max']`. No `'none'`, no `'ultra'`.       |

## Quick example

```ts
import { codexCliAdapter } from '@gullabs/codex-cli'
import { createClient } from '@gullabs/core'

const client = createClient({ adapters: [codexCliAdapter()] })

const result = await client.generate(
  {
    provider: 'codex-cli',
    model: 'gpt-6-sol',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
  },
  { auth: { cliSession: true } },
)
```

## Notes

### System prompt is transport-encoded, not natively supported

`codex exec` has no system-prompt flag. When `request.system` is set, the
adapter folds it into the prompt as a delimited preamble:

```
<system>
...your system text...
</system>

...user/assistant transcript...
```

This is **transport encoding, not capability mapping** — the content reaches
the model verbatim as part of the user turn. It is not a distinct
system-role message the way Gemini/Claude support natively.

### Strict output schemas (`outputJsonSchema`)

codex CLI's `--output-schema` mode is backed by the OpenAI Responses API
structured-outputs validator. As of **live probes run 2026-07-09** against
the real `codex` binary + backend, it enforces exactly two structural rules
(HTTP 400 `invalid_json_schema` otherwise, surfaced only after a full
network round-trip):

1. Every object node (root and nested) must carry
   `additionalProperties: false`.
2. `required` must be supplied and include **every** key in `properties` on
   that same node.

Everything else probed is accepted: `format`, `minLength`, `pattern`
(enforced), `default` (accepted, ignored), `anyOf`, `$defs`/`$ref`,
`enum`/`const` (enforced), nullable via `type: [T, 'null']`.

#### Local preflight — the adapter never rewrites your schema

The adapter runs `assertOpenAiStrictOutputSchema` on `outputJsonSchema`
before ever shelling out to `codex`. It walks the **complete** set of
JSON-Schema draft-2020-12 subschema positions (`properties`,
`patternProperties`, schema-valued `additionalProperties`, `items`,
`prefixItems`, `contains`, `anyOf`/`oneOf`/`allOf`, `not`, `if`/`then`/`else`,
`dependentSchemas`, `propertyNames`, schema-valued
`unevaluatedProperties`/`unevaluatedItems`, `contentSchema`, and
`$defs`/`definitions`) and throws a typed `bad_request` `LlmError` — naming
the offending node's JSON path — the moment either rule is violated. The
schema is otherwise passed through **byte-identical** (same object
reference): this function only validates, it never mutates, clones, or
silently injects anything into your schema.

#### `toOpenAiStrictOutputSchema` — an explicit, opt-in rewriting helper

If you'd rather not hand-author every `additionalProperties: false` and
`required` entry yourself, `@gullabs/codex-cli` also exports
`toOpenAiStrictOutputSchema(schema)` — a pure, deep-cloning helper you must
call explicitly at your own call site. The adapter never calls it for you.

```ts
import { toOpenAiStrictOutputSchema } from '@gullabs/codex-cli'

const strictSchema = toOpenAiStrictOutputSchema({
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['title'],
})
// -> {
//      type: 'object',
//      additionalProperties: false,
//      properties: {
//        title: { type: 'string' },
//        summary: { type: ['string', 'null'] },  // optional -> nullable-required
//      },
//      required: ['title', 'summary'],
//    }
```

**Semantic change to be aware of:** an optional property does not become
merely _mandatory_ — it becomes a **nullable required** property (per
OpenAI's own strict-mode guidance), preserving the "this may be absent"
intent as "this may be `null`" instead of silently forcing a value. A
property with no `type` keyword at all (e.g. a bare `anyOf` member) is
wrapped as `anyOf: [<original>, { type: 'null' }]` instead.

An explicit `additionalProperties: true` (or a schema-valued
`additionalProperties`) is **rejected** with `bad_request` rather than
rewritten — silently inverting that to `false` would invert your intent. A
present-but-malformed `required` (not an array of strings) is rejected the
same way. The helper's output is guaranteed to pass
`assertOpenAiStrictOutputSchema`.

As of the 2026-07-09 live probes, xai/grok's `strict: true` performs no
compile-time schema validation and does **not** need this helper — see
`packages/xai/README.md`. This is a time-bounded observation about that
provider's behavior on that date, not a timeless product guarantee.

### Concurrency

The adapter runs an in-process semaphore around `runner.run`, defaulting to
`maxConcurrency: 2`. Override via `codexCliAdapter({ maxConcurrency: N })`.

### Argv is adapter-owned

The invariant flags (`--json --ephemeral --skip-git-repo-check
--ignore-user-config --ignore-rules --sandbox read-only --strict-config -c
approval_policy=never --color never`) are never caller-configurable.
`--strict-config` turns a mistyped `-c` key into exit 1 instead of a silent
drop. Only `-m <model>`, `-c model_reasoning_effort=<effort>`,
`--output-schema`, `-o`, `-C <scratchDir>`, and the final positional prompt
argument vary per call.

`turn.completed.usage` may include `cache_write_input_tokens`. The JSONL
parser keeps unknown keys and does not map that field onto `Usage`.
