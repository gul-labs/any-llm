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
    model: 'claude-haiku-5-5',
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
flag; the CLI does not provide strict validation for this setting. The adapter also
sets `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` on the child (see the environment section
below). Enforcement
comes from the post-run `modelUsage` check: a successful response must report
the requested id and no other model. Any other model id throws
`LlmError` kind `server` (not retryable). A successful envelope with
`stop_reason: "refusal"` returns `finishReason: 'content_filter'` and preserves
its billed usage; an error envelope throws `content_filter`.

The live capture of 2026-09-26 (Claude Code 2.1.282) shows it: the invariant argv
and `--json-schema` completed for four ids (`claude-fable-5-1`, `claude-opus-5-5`,
`claude-sonnet-5` and `claude-haiku-4-5-20251001`, three of which are no longer
registered), and each success envelope contained only its requested id as a
`modelUsage` key. The sanitized responses are in
`src/__fixtures__/model-refresh-p-a1.json`; they are evidence of the CLI's output
shape, not a capture of the ids registered today. The full installed CLI version and
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

A structured call reads the `structured_output` field of the `--output-format json`
result (Claude Code headless documentation, `https://code.claude.com/docs/en/headless`,
read 2026-11-20); the `result` text is never parsed for it. The documentation says a
run that ends without valid structured output has no `structured_output` field: the
adapter then returns no structured output (the engine reports the output as unparsed)
and a warning. Documented, not live-verified on the current CLI.

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

The list does keep credentials: the library never interprets an environment credential,
but `CLAUDE_CODE_OAUTH_TOKEN` and the mTLS variables `CLAUDE_CODE_CLIENT_CERT`,
`CLAUDE_CODE_CLIENT_KEY` and `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE` are forwarded from the
host environment to the CLI, so a host that has them exported is using them (and a proxy
URL in `HTTPS_PROXY` can carry credentials too). `env` adds to the copy and cannot remove
from it: to keep the CLI off an ambient token, unset the variable before the call.

The adapter itself sets `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` on every child. It
turns off the automatic model switch Claude Code makes after a flagged message
(documented since Claude Code 2.1.312 in the Claude Code changelog,
`https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`, read
2026-11-20; a CLI older than that ignores it, and it is documented, not live-verified).
It is adapter-owned: a value in the host environment is not inherited, and naming it in
`env` is `bad_request`. It is a second protection beside the `--settings` argument; the
`modelUsage` check stays the one that enforces.

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

`claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`. All
four accept `{ reasoning: { effort }, timeoutMs }` with effort
`low | medium | high | xhigh | max` (Anthropic effort documentation,
`https://platform.claude.com/docs/en/build-with-claude/effort`, read 2026-11-20).
`ultracode` is not admitted: `--effort ultracode` is a Claude Code workflow switch, not
a model level. No sampling knobs (`temperature`/`topP`/`topK`/`maxOutputTokens`/`stopSequences`)
are accepted; the strict config schema rejects unknown keys. `claude-fable-5-1`,
`claude-sonnet-5`, `claude-haiku-4-5-20251001`, `claude-fable-5` and `claude-opus-4-8` are
deleted with no alias.

Minimum Claude Code version per model, from the Claude Code changelog
(`https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`, read 2026-11-20): Sonnet 5.5 needs 2.1.284
(it added `claude-sonnet-5-5`), Haiku 5.5 needs 2.1.293, and Fable 5.2 needs 2.1.321.
An older CLI does not know the id.

The descriptors' `limits` are the documented API figures for all four models: 1M
context and 128K output (Anthropic models overview,
`https://platform.claude.com/docs/en/about-claude/models/overview`, read 2026-11-20).
For `claude-opus-5-5` the CLI reported the same two figures in the captured
`modelUsage` (Claude Code 2.1.282, 2026-09-26). For `claude-fable-5-2`,
`claude-sonnet-5-5` and `claude-haiku-5-5` they are documented, not live-verified: no
`modelUsage` has been captured for those ids, and the CLI exposes no output-size knob.
