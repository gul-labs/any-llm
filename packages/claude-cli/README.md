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
spend (the runner scrubs `ANTHROPIC_API_KEY` and the other credential variables from
the child's environment so that stays true; see below) — the CLI reports its own cost for observability, but that number is
never fed into `@gullabs/core`'s cost engine (`Cost.microUsd` naturally
resolves to `null` because these models are unpriced).

## Install

```sh
pnpm add -D @gullabs/claude-cli @gullabs/core
```

## Key exports

| Export                      | Kind     | Description                                                     |
| --------------------------- | -------- | --------------------------------------------------------------- |
| `claudeCliProvider`         | function | The `ProviderPlugin` for `composeProviders` (adapter + models). |
| `claudeCliAdapter`          | function | Creates the `ProviderAdapter` (`id: 'claude-cli'`).             |
| `ClaudeCliAdapterOptions`   | type     | `{ runner?, claudePath?, maxConcurrency?, env? }`.              |
| `buildClaudeCliRunner`      | function | The real `node:child_process`-backed `ClaudeCliRunner` factory. |
| `ClaudeCliRunner`           | type     | The process-execution seam; inject a fake in tests.             |
| `ClaudeCliRunOptions`       | type     | `{ cwd, timeoutMs?, signal?, env? }`, the options of `run`.     |
| `ClaudeCliRunResult`        | type     | `{ stdout, stderr, exitCode }`.                                 |
| `ClaudeCliEnvelope`         | type     | The `--output-format json` result envelope the adapter reads.   |
| `claudeCliModelDescriptors` | value    | `ModelDescriptor[]` for the 4 supported model ids.              |
| `claudeCliRegistry`         | value    | `ModelRegistry` built from `claudeCliModelDescriptors`.         |
| `CLAUDE_CLI_MODEL_IDS`      | value    | The four registered model ids.                                  |
| `CLAUDE_CLI_EFFORTS`        | value    | `['low', 'medium', 'high', 'xhigh', 'max']`.                    |
| `Claude…ConfigSchema` (x4)  | value    | The strict zod config schema of each model.                     |

## Quick example

```ts
import { composeProviders, createClient } from '@gullabs/core'
import { claudeCliProvider } from '@gullabs/claude-cli'

const client = createClient({ ...composeProviders([claudeCliProvider()]) })

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

Usage follows Anthropic's accounting, in which `input_tokens` excludes both cache lanes: `inputTokens` is
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, `cachedInputTokens` is the cache-read
part, `details.cacheWrite` is the cache-creation part, and `thinkingTokens` is
`output_tokens_details.thinking_tokens` (inside `outputTokens`). The adapter is unpriced, so none of this
becomes a cost.

`--model`, `--effort`, `--system-prompt`, and `--json-schema` are appended
from the request when applicable; the prompt itself is always sent over
stdin, never as a positional argv entry.

`output.jsonSchema` is passed to `--json-schema` as written. Unlike the Google and
xAI adapters (ADR-034), this adapter does not check the schema against a keyword
profile: `nullable`, uppercase type names and keywords the CLI may ignore are not
rejected here, so validate the result yourself.

## Environment: the subscription login, never an API key

Claude Code's own documentation says `ANTHROPIC_API_KEY` is "used instead of your
Claude Pro, Max, Team, or Enterprise subscription even if you are logged in. In
non-interactive mode (`-p`), the key is always used when present"
(<https://code.claude.com/docs/en/env-vars>), and the adapter always runs `-p`. A
host that has the key exported for an Anthropic SDK would therefore have every call
billed to it while the ledger books the call as unpriced, and nothing in the result
would say so. So the real runner does not hand the host environment to the child. It
builds an allowlisted copy of `process.env`: `PATH`, `HOME`, `USER`, `LOGNAME`,
`LANG`/`LC_*`, `TERM`, `TZ`, `TMPDIR`/`TEMP`/`TMP`, `SHELL`, `XDG_*`, the Windows
profile variables, the proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`,
`NO_PROXY`, either case), `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`/`SSL_CERT_DIR`, and
the CLI's own documented settings for a subscription login: `CLAUDE_CONFIG_DIR`,
`CLAUDE_CODE_OAUTH_TOKEN` (the long-lived subscription token from
`claude setup-token`) and the mTLS variables `CLAUDE_CODE_CLIENT_CERT`,
`CLAUDE_CODE_CLIENT_KEY`, `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE`. `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`/
`_FOUNDRY` and everything else are dropped.

`claudeCliAdapter({ env })` adds variables on top, and they win over the allowlisted
ones. It is the one way to pass anything else on. Putting an API key there is the
explicit opt-in: the call is then billed to it. `env` is validated at construction
(string names without `=`, string values without NUL), else `bad_request`. A custom
runner receives it as `ClaudeCliRunOptions.env` and decides for itself.

## Queued calls and killed processes

A call waits for a slot before it makes its scratch directory, and leaves the queue
(rejecting `aborted`) when its signal fires, so calls the engine already gave up on
cost nothing while they wait. When a timeout, abort or the stdout cap kills the call,
the whole process group gets SIGTERM, and SIGKILL after five seconds. When the CLI
itself exits on the SIGTERM the group gets one more SIGKILL at that moment, so a tool
process that ignored SIGTERM and holds none of the runner's pipes does not outlive
the call.

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

The descriptors' `limits` are what the CLI reports for its own run (the captured
`modelUsage.contextWindow` and `maxOutputTokens`), not the API maxima: Fable 5.1
64 000 and Haiku 4.5 32 000 output tokens, Opus 5.5 and Sonnet 5 128 000.
