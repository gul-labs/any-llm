# @gullabs/claude-cli

> **DEV-ONLY.** This package shells out to a locally-authenticated `claude`
> CLI session. It is impossible to run in production by construction (no
> CI/serverless environment has an interactive CLI login). Never use this as
> a fallback for an API provider — it exists purely to make iterating on long
> Temporal workflows free during development.

`@gullabs/claude-cli` is a text-only, pure `ProviderAdapter` for
[`@gullabs/core`](../core) that routes LLM calls through the `claude`
(Claude Code) CLI instead of an API key. Because the CLI owns its own
OAuth/keychain-backed session, calls made through this adapter cost $0 in API
spend — the CLI reports its own cost for observability, but that number is
never fed into `@gullabs/core`'s cost engine (`Cost.microUsd` naturally
resolves to `null` because these models are unpriced).

## Install

```sh
pnpm add -D @gullabs/claude-cli @gullabs/core
```

## Key exports

| Export                      | Kind     | Description                                                     |
| --------------------------- | -------- | --------------------------------------------------------------- |
| `claudeCliAdapter`          | function | Creates the `ProviderAdapter` (`id: 'claude-cli'`).             |
| `ClaudeCliAdapterOptions`   | type     | `{ runner?, claudePath?, maxConcurrency? }`.                    |
| `buildClaudeCliRunner`      | function | The real `node:child_process`-backed `ClaudeCliRunner` factory. |
| `ClaudeCliRunner`           | type     | The process-execution seam; inject a fake in tests.             |
| `claudeCliModelDescriptors` | value    | `ModelDescriptor[]` for the 4 supported model ids.              |
| `claudeCliRegistry`         | value    | `ModelRegistry` built from `claudeCliModelDescriptors`.         |

## Quick example

```ts
import { claudeCliAdapter } from '@gullabs/claude-cli'
import { createClient } from '@gullabs/core'

const client = createClient({ adapters: [claudeCliAdapter()] })

const result = await client.generate(
  {
    provider: 'claude-cli',
    model: 'claude-haiku-4-5-20251001',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
  },
  { auth: { cliSession: true } },
)
```

Auth is always `{ cliSession: true }` — never an API key. Passing anything
else throws `LlmError({ kind: 'invalid_auth' })` explaining that these
dev-only providers route through a locally-authenticated CLI session, not an
API key.

## `--safe-mode`, never `--bare`

The adapter always invokes the CLI with `--safe-mode`. It never passes
`--bare`, because `--bare` disables OAuth/keychain auth entirely — which
would break subscription-based Claude Code auth and defeat the entire point
of this package (working with **zero** API-key configuration). The full
invariant argv (never caller-configurable) is:

The quotes below illustrate argument boundaries; the runner passes an argv
array directly without a shell.

```
-p --output-format json --safe-mode --tools "" --disable-slash-commands --no-session-persistence --settings '{"switchModelsOnFlag":false}'
```

`--settings` requests that the CLI disable silent model switches on a safety
flag; the CLI does not provide strict validation for this setting. Enforcement
comes from the post-run `modelUsage` check: a successful response must report
the requested id and no other model. Any other model id throws
`LlmError` kind `server` (not retryable). A successful envelope with
`stop_reason: "refusal"` returns `finishReason: 'content_filter'` and preserves
its billed usage; an error envelope throws `content_filter`.

P-A1 was captured on 2026-09-26 with Claude Code 2.1.282: the invariant argv
and `--json-schema` completed for all four registered ids, and each success
envelope contained only its requested id as a `modelUsage` key. The sanitized
responses are in `src/__fixtures__/model-refresh-p-a1.json`. The full installed CLI version and
envelope shape are runtime dependencies; an absent `modelUsage` fails closed.

`--model`, `--effort`, `--system-prompt`, and `--json-schema` are appended
from the request when applicable; the prompt itself is always sent over
stdin, never as a positional argv entry.

`output.jsonSchema` is passed to `--json-schema` as written. Unlike the Google and
xAI adapters (ADR-034), this adapter does not check the schema against a keyword
profile: `nullable`, uppercase type names and keywords the CLI may ignore are not
rejected here, so validate the result yourself.

## Concurrency

The adapter caps concurrent `claude` CLI invocations with an internal
semaphore, defaulting to `maxConcurrency: 2`. Override via
`claudeCliAdapter({ maxConcurrency: N })`.

## Supported models

`claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5`,
`claude-haiku-4-5-20251001`. Fable 5.1, Opus 5.5, and Sonnet 5 accept
`{ reasoning: { effort }, timeoutMs }` with effort `low | medium | high |
xhigh | max`. Haiku 4.5 has no `reasoning` key — the CLI drops `--effort`.
No sampling knobs (`temperature`/`topP`/`topK`/`maxOutputTokens`/`stopSequences`)
are accepted; the strict config schema rejects unknown keys. `claude-fable-5`
and `claude-opus-4-8` are deleted with no alias.
