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
pnpm add -D @gullabs/codex-cli @gullabs/core
```

Requires a locally-authenticated `codex` CLI on `PATH` (`codex login`) for
actual use; not required to build or test this package.

## Key exports

| Export                                                        | Description                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `codexCliProvider(opts?)`                                     | The `ProviderPlugin` for `composeProviders` (adapter + models).                |
| `codexCliAdapter(opts?)`                                      | Builds the `ProviderAdapter` (`id: 'codex-cli'`).                              |
| `CodexCliAdapterOptions`                                      | `{ runner?, codexPath?, maxConcurrency?, env? }`.                              |
| `createCodexCliRunner(codexPath?)`                            | Real `node:child_process`-backed `CodexCliRunner`.                             |
| `CodexCliRunner` / `CodexCliRunOptions` / `CodexCliRunResult` | The subprocess seam interface and its options and result, for injecting fakes. |
| `codexCliModelDescriptors` / `codexCliRegistry`               | `ModelDescriptor[]` / `ModelRegistry` for the 3 supported models.              |
| `CODEX_CLI_MODEL_IDS`                                         | `'gpt-6-astra' \| 'gpt-6-sol' \| 'gpt-6-luna'`. No `gpt-5*` id is registered.  |
| `CODEX_CLI_REASONING_EFFORTS`                                 | `['low', 'medium', 'high', 'xhigh', 'max']`. No `'none'`, no `'ultra'`.        |

## Quick example

```ts
import { composeProviders, createClient } from '@gullabs/core'
import { codexCliProvider } from '@gullabs/codex-cli'

const client = createClient({ ...composeProviders([codexCliProvider()]) })

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
silently injects anything into your schema. This is the OpenAI-strict
dialect, separate from the keyword profiles Google and xAI enforce (ADR-034):
`assertPortableJsonSchema` does not cover this adapter.

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

### Environment: the subscription login, never an API key

A call through this package is meant to run on the saved ChatGPT login and cost no
API spend. `codex exec` also reads `CODEX_API_KEY` (OpenAI documents it as the way
"to use a different API key for a single run") and the OpenAI SDK's
`OPENAI_API_KEY`, and does not document which wins over the saved login. A host
that has either exported would risk every call being billed to that key while the
ledger books it as unpriced. So the real runner does not hand the host environment
to the child. It builds an allowlisted copy of `process.env`: `PATH`, `HOME`,
`USER`, `LOGNAME`, `LANG`/`LC_*`, `TERM`, `TZ`, `TMPDIR`/`TEMP`/`TMP`, `SHELL`,
`XDG_*`, the Windows profile variables, the proxy variables (`HTTPS_PROXY`,
`HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, either case), `SSL_CERT_FILE`/`SSL_CERT_DIR`,
and the CLI's own `CODEX_HOME` and `CODEX_CA_CERTIFICATE`. `CODEX_API_KEY`,
`OPENAI_API_KEY`, `OPENAI_BASE_URL` and everything else are dropped.

`codexCliAdapter({ env })` adds variables on top, and they win over the allowlisted
ones. It is the one way to pass anything else on, for example a non-default
`CODEX_HOME`. Putting an API key there is the explicit opt-in: the call is then
billed to it. `env` is validated at construction (string names without `=`, string
values without NUL), else `bad_request`. A custom runner receives it as
`CodexCliRunOptions.env` and decides for itself.

### Queued calls

A call waits for a slot before it makes its scratch directory, and leaves the queue
(rejecting `aborted`) when its signal fires, so calls the engine already gave up on
cost nothing while they wait.

### A killed process

When a timeout, abort or the stdout cap kills the call, the whole process group gets
SIGTERM, and SIGKILL after five seconds. When the CLI itself exits on the SIGTERM
the group gets one more SIGKILL at that moment, so a tool process that ignored
SIGTERM and holds none of the runner's pipes does not outlive the call. A process
that ends on a signal from outside (an OOM kill) without a `turn.completed` event is
a `server` error, not a result built from a message streamed before the kill.

### Argv is adapter-owned

The invariant flags (`--json --ephemeral --skip-git-repo-check
--ignore-user-config --ignore-rules --sandbox read-only --strict-config -c
approval_policy=never --color never`) are never caller-configurable.
`--strict-config` turns a mistyped `-c` key into exit 1 instead of a silent
drop. Only `-m <model>`, `-c model_reasoning_effort=<effort>`,
`--output-schema`, `-o` and `-C <scratchDir>` vary per call. The prompt is
written to the child's stdin and the final positional argument is `-`
(`codex exec` reads instructions from stdin for `-`), so a large history never
hits the OS limit on one argv entry. The runner buffers at most 32 MiB of
stdout (past that the process is killed and the call rejects), decodes UTF-8
across chunk boundaries, and tolerates a CLI that exits before reading stdin.

Smoke-tested on 2026-09-25 with `codex-cli 0.157.0`: `codex exec` accepted
`--strict-config` together with `-c model_reasoning_effort=max` and
`gpt-6-luna`, then completed a read-only prompt. Older local CLI builds may
need an upgrade before using this dev-only adapter.

`turn.completed.usage` may include `cache_write_input_tokens`. The JSONL
parser keeps unknown keys and does not map that field onto `Usage`.
