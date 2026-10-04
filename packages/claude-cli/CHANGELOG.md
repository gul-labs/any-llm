# @gullabs/claude-cli

## 0.16.0

### Minor Changes

- fb79350: Every result carries the ordered assistant `message` and a `continuation` rule, `AdapterResult.message` is required, and provider state is scoped to its provider and model string (ADR-029 addendum).

  - **`LlmResult.message`** is the assistant output as an ordered `Message` on every provider: text parts and tool calls in provider order, thought, reasoning and server-tool items omitted. `text` and `toolCalls` stay as conveniences; `result.toolCalls` is a copy, so editing a tool call's `args` no longer changes the arguments in `result.message` (which a Gemini 3 signature hashes). A result with nothing representable (a thought-only response whose output cap went to reasoning) has `message.parts === []`: do not append it to history. An assistant message with no parts is `bad_request` before dispatch, on every provider.
  - **`AdapterResult.message` is required.** The engine no longer builds it from `text` and `toolCalls`, because only the adapter knows the provider's interleaving. The Google, xAI, Claude CLI and Codex CLI adapters set it, and `FakeAdapter` and `SignalAwareFakeAdapter` throw a `TypeError` for a scripted result that lacks it.
  - **`LlmResult.continuation`** (`'history' | 'state'`) repeats the descriptor's new `capabilities.continuation`. `'history'` (the default, and grok-4.5/4.6): append `result.message` and send the full history. `'state'` (grok-4.7): send only the new messages plus `result.transientProviderState` and do not replay `result.message`. `capabilities.statelessReasoningReplay` is deleted; `capabilities.providerState: true` is what lets the engine forward `transientProviderState` (`createModelRegistry` rejects `continuation: 'state'` without it).
  - **State is provider-scoped and bound to the model string the host sent.** The xAI state is `{ xai: { model, input } }` (it was `{ model, input }`), and `XaiReplayState` has that shape. Another provider's state, or state bound to another model string (an alias is a different string from its canonical id), is `bad_request`; the next turn uses the same `provider` and `model` string as the previous one (`result.model` is the id the provider returned and is not for routing).
  - **`TokenCount.accuracy`** gains `'estimated'`: the provider counted the history, but the real call sends parts the count cannot include. `@gullabs/google` reports it for a Gemini 3 history that holds function calls. `AdapterCtx.modelDescriptor` carries the resolved descriptor to `countTokens`.
  - **`@gullabs/testing`** adds `runToolLoop(client, req, tools, { auth })`, which follows `result.continuation` after every turn, turns a throwing tool into an `isError` tool result, rejects a call to a tool with no own implementation (a model call named `toString` is a missing tool) with `bad_request`, and rejects a `maxTurns` that is not an integer of at least 1.

  What hosts must change:

  - A custom `ProviderAdapter` (and any scripted `FakeAdapter` result) returns `message: { role: 'assistant', parts }`. Read `result.continuation`, or follow the README loops, instead of assuming one replay rule.
  - Do not append a result whose `message.parts` is empty to your history; retry the call. Code that switches on `TokenCount.accuracy` handles `'estimated'`.
  - Persist grok-4.7 state exactly as returned; state stored in the old `{ model, input }` shape is rejected, so restart those conversations.
  - A custom `ModelDescriptor` that declared `statelessReasoningReplay: true` declares `continuation: 'state', providerState: true` instead.

- fb79350: The CLI providers run their child with an allowlisted environment so the subscription login is what is used, and the runners are hardened (ADR-046).

  - **Environment.** `claude -p` uses `ANTHROPIC_API_KEY` whenever it is present, instead of the subscription login ("In non-interactive mode (`-p`), the key is always used when present", https://code.claude.com/docs/en/env-vars), and `codex exec` reads `CODEX_API_KEY` and `OPENAI_API_KEY`. Both runners used to hand the child the whole host environment, so a host with such a key exported had every call billed to it while the ledger recorded it as unpriced. The runners now spawn the child with an allowlisted copy of `process.env`: `PATH`, `HOME`, `USER`, `LOGNAME`, `LANG`, `LANGUAGE`, `LC_*`, `TERM`, `TZ`, `TMPDIR`/`TEMP`/`TMP`, `SHELL`, `XDG_*`, the Windows profile variables, the proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, either case), `SSL_CERT_FILE`, `SSL_CERT_DIR`, and each CLI's own login settings (`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, the Claude mTLS variables and `NODE_EXTRA_CA_CERTS`; `CODEX_HOME` and `CODEX_CA_CERTIFICATE`). Credential and provider-routing variables are dropped. The new adapter option **`env`** (`claudeCliAdapter({ env })`, `codexCliAdapter({ env })`) adds variables on top, winning over the allowlisted ones (on Windows whatever the case of the name, so `Path` replaces an inherited `PATH`); it is validated at construction (`bad_request` for a non-string, an empty or `=`-bearing name, a NUL), copied, and handed to the runner as `ClaudeCliRunOptions.env` / the new `CodexCliRunOptions.env`. A host that wants a key used passes it there, and then the billing is its decision. The library never interprets an environment credential, and `@gullabs/core`, `@gullabs/google` and `@gullabs/xai` still read none, but the CLI adapters do forward some ambient credentials to the child, so a host with them exported is using them: the Claude runner forwards `CLAUDE_CODE_OAUTH_TOKEN` (the subscription token from `claude setup-token`) and the mTLS variables `CLAUDE_CODE_CLIENT_CERT`, `CLAUDE_CODE_CLIENT_KEY` and `CLAUDE_CODE_CLIENT_KEY_PASSPHRASE` from `process.env`; the proxy variables of both runners can carry proxy credentials in their URLs; `CLAUDE_CONFIG_DIR` and `CODEX_HOME` point the CLI at the login it reads from disk. The Codex runner forwards no token variable (`CODEX_API_KEY` and `OPENAI_API_KEY` are dropped).
  - **Queued calls.** A call waits for a semaphore slot before it makes its scratch directory and leaves the queue (`aborted`) when its signal fires, so calls the engine gave up on cost nothing while they wait.
  - **Failure text** is classified with word-anchored patterns (an `author` or a port `4290` is no longer an auth failure or a rate limit; an explicit rate-limit signal wins over an incidental "auth"; `oauth` is an auth failure). A `codex` process ended by a signal (an OOM kill) with no `turn.completed` is a non-retryable `server` error, never a result built from a message streamed before the kill. `@gullabs/codex-cli` now requires a model descriptor, like `claude-cli`, and exports `CodexCliRunOptions`.
  - **Process group.** The CLI is spawned `detached` (its own process group on POSIX) and a timeout, abort or stdout-cap kill sends `SIGTERM`, then `SIGKILL` after 5 s, to the group, and closes the runner's pipe ends after the `SIGKILL`; when the CLI exits on the `SIGTERM` the group gets one more `SIGKILL` at that moment, so a tool process that ignored it and holds none of the pipes does not outlive the call. A host interrupted with Ctrl-C no longer forwards the signal to the CLI, which runs to its own timeout.
  - **Stdin and limits.** A `stdin` `error` handler (a CLI that exits before reading its input no longer raises an unhandled `EPIPE`), `StringDecoder` decoding (a multibyte character split across chunks is intact), stdout capped at 32 MiB (past it the process is killed and the call rejects with an `OutputLimitError`; stderr keeps its last 1 MiB), and `codex exec` gets the rendered prompt on stdin with `-` as the positional argument, so a large history no longer fails with `E2BIG`.
  - **`claude-cli` usage** counts both cache lanes as input (Anthropic's `input_tokens` excludes cache reads and writes): `inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, `cachedInputTokens = cache_read_input_tokens`, `details.cacheWrite = cache_creation_input_tokens`, `thinkingTokens = output_tokens_details.thinking_tokens`; `totalTokens` is the new input plus output. It used to record `inputTokens: 2` for a call that processed 4,013 tokens and clamp `cachedInputTokens` with a warning whenever the cache was read. The adapter stays unpriced (cost `null`).
  - Limits and media: the `claude-cli` descriptors state the limits the CLI reports (Fable 5.1 64,000 and Haiku 4.5 32,000 output tokens), both providers are text-only, and the config schemas are strict.

  What hosts must change:

  - A host that must not have the Claude CLI use an ambient subscription token or client key unsets `CLAUDE_CODE_OAUTH_TOKEN` and the `CLAUDE_CODE_CLIENT_*` variables before the call: `env` adds to the allowlisted copy and cannot remove from it.
  - A host that relied on the CLI inheriting an environment variable that is not on the list above passes it with `env`. `ANTHROPIC_API_KEY` in the host environment no longer changes which account a `claude-cli` call uses.
  - A custom `CodexCliRunner` writes `input` to the child's stdin and runs `codex exec ... -`, honours `opts.env`, and, like a custom `ClaudeCliRunner`, should kill its process group. Direct adapter calls supply a model descriptor (the engine always does).
  - Code that summed `inputTokens` and the `claude-cli` cache fields itself reads `inputTokens` as the gross figure.

- fb79350: Lockstep versions with `@gullabs/core` as an exact peer, runtime support that is written down and tested, correct `exports`, and `LICENSE` plus `NOTICE` in every tarball.

  - **One version for every package.** The nine `@gullabs/*` packages are one changesets `fixed` group and always release at the same version; a package with no code change still gets the bump. `@gullabs/google`, `@gullabs/xai`, `@gullabs/quota`, `@gullabs/drizzle`, `@gullabs/testing`, `@gullabs/claude-cli`, `@gullabs/codex-cli` and `@gullabs/any-llm` declare `@gullabs/core` as a `peerDependency` pinned to the exact release version instead of a regular dependency, so a second copy of core cannot sit in `node_modules` without a peer-dependency conflict and `instanceof LlmError` always sees one engine. Mixed versions, patch releases included, are a peer-dependency error under pnpm's strict peers and `ERESOLVE` under npm 7+; they are not supported or tested.
  - **No Node built-in in `core`, `google`, `xai`, `quota`, `drizzle` and `any-llm`.** Ids come from `globalThis.crypto.randomUUID()`, hashes from the new dependency-free `sha256Hex(input)` that `@gullabs/core` exports next to `canonicalJson`, and `Buffer` and `process` are gone. The built ESM entries load with every `node:` import blocked and fake-backed calls run with `Buffer` and `process` removed (`pnpm test:runtime`, in CI); ESLint rejects `node:*`, `Buffer` and `process` in their source. Deno 2.4.1 passes by hand; Bun, Cloudflare Workers, Vercel Edge and browsers are not tested. `claude-cli`, `codex-cli` and `testing` stay Node only. `createClient` throws `bad_request` (path `ids`) when `ClientConfig.ids` is not given and the runtime has no `globalThis.crypto.randomUUID`, instead of failing with a `TypeError` on the first call.
  - **`exports` has nested conditions**: `import` gives `index.d.ts` and `index.js`, `require` gives `index.d.cts` and `index.cjs`, and every package also exports `./package.json`. A TypeScript consumer under `node16` / `nodenext` that `require`s a package now gets CommonJS types (it got ESM types), and `require.resolve('@gullabs/core/package.json')` no longer throws. The ESM and CommonJS builds are separate copies: a process that loads one package through both holds two `LlmError` classes, so use one module format.
  - **One Node floor, `>=22.12.0`**, in every `engines`, the README and the SPEC. CI runs the tests on 22.12.0 and 24.
  - **Every tarball ships `LICENSE` and `NOTICE`** (Apache-2.0 4(d)); `@gullabs/drizzle` also ships its `sql/` directory.

  What hosts must change:

  - Install `@gullabs/core` next to any package that is not the facade, at the same version (`pnpm add @gullabs/core @gullabs/xai openai`); npm 7+ and pnpm install a missing peer unless npm's `legacy-peer-deps` is on or pnpm's `auto-install-peers` is off. Upgrade every `@gullabs/*` package together.
  - Remove any use of `VERSION` from `@gullabs/core` or `@gullabs/any-llm` (it read `0.0.0`); read your own `package.json`. `@gullabs/any-llm` still exports `ANY_LLM_VERSION`.
  - On a runtime without `crypto.randomUUID` (a browser page served over plain http, some embedded runtimes), pass `ids`.
  - A host compiled with `moduleResolution: node16` that `require`s a package may see new, correct type errors where it relied on the ESM declarations.

- fb79350: The model registry: exact ids with declared aliases, stated limits and admitted media types, introspection, and a shutdown date (ADR-033, ADR-043).

  - **Exact ids (supersedes ADR-006).** `createModelRegistry` no longer falls back to the longest prefix, so `gemini-2.5-flash-image` or a live-audio id is no longer validated, adapted and priced as the shorter text model. `ModelDescriptor.aliases?: readonly string[]` declares real provider version suffixes; aliases are unique within a provider and never equal a canonical id. An unknown id is `bad_request` listing the closest registered ids. `assertModelMatchesDescriptor(req, descriptor, adapterProvider)` (new) is what the Google and xAI adapters use: a request names the canonical id or a declared alias, the string is sent to the provider unchanged and recorded as sent, and pricing and the rate-limiter key use the canonical descriptor.
  - **Limits.** `ModelDescriptor.limits: { contextWindow, maxOutputTokens }` is required, from each provider's documentation. `maxOutputTokens` is `number | null`: `null` means the provider documents no output limit (xAI Grok 4.x, Gemma 4), no figure is invented and the config schema applies no cap; a number is the schema's cap (Gemini 65,536). `maxOutputTokensSchema(limits)` is exported for the config field. `createModelRegistry` rejects missing limits, non-positive-integer limits and `maxOutputTokens` above `contextWindow`. The `claude-cli` limits are what the CLI reports for its own run (Fable 5.1 64,000 and Haiku 4.5 32,000 output tokens).
  - **Media types.** `capabilities.inputMimeTypes` lists the IANA types a model takes in `inline-media` and `file-uri` parts (lower-case `type/subtype` or a `type/*` family). `assertInputMimeTypesAdmitted`, `assertMediaTypeAdmitted` and `isMediaTypeAdmitted` are exported; the Google and xAI adapters check before dispatch, and Google also in `countTokens`. Admission ignores case and `; parameters` and sends your string unchanged; an empty or missing type is `bad_request`. Gemini admits `application/pdf` plus the `text/*`, `image/*`, `audio/*` and `video/*` families, Gemma 4 `image/*` and `video/*`, xAI `image/jpeg` and `image/png` only (`image/jpg` is rejected), the CLI providers nothing. `GoogleFileStore.upload` applies the same rule. The `capabilities.vision` and `capabilities.audioInput` flags are deleted: `inputMimeTypes` is the one statement of multimodal support.
  - **Introspection and snapshot.** `ModelRegistry.findByModel(model)` returns every descriptor whose canonical id or alias equals `model`, across providers; `listDescriptors()` is required. `ModelDescriptor.configKeys` is the sorted list of top-level config keys the schema names across a union's branches, derived with the new `toConfigKeys(configSchema)` (it follows local `$ref`s). `createModelRegistry` recomputes `configKeys` and `configJsonSchema` and rejects a descriptor whose declared ones differ, validates `inputMimeTypes`, freezes each descriptor's `limits`, `inputMimeTypes`, `aliases` and `configKeys`, and answers `resolve`, `findByModel` and `listDescriptors` from a copy taken at construction. `createClient` rejects a `modelRegistry` that lacks any of the three methods.
  - **`shutdownDate`.** A descriptor may declare `shutdownDate: 'YYYY-MM-DD'` (UTC, a real calendar date). The first successful call per client and model within 90 days of it carries a typed warning `{ type: 'shutdown', message, shutdownDate }` (`Warning` is now `{ type: 'other', message } | { type: 'shutdown', message, shutdownDate }`); later calls on that client do not repeat it (the advisory is given back when the attempt that chose it fails before it has a result), and the call is never refused. `SHUTDOWN_WARNING_DAYS` (90) is exported. `gemini-3.1-flash-lite` declares `2027-05-07` (replacement `gemini-3.5-flash-lite`), so it warns from 2027-02-06.
  - Both Gemma 4 descriptors keep `capabilities.grounding: true` on the strength of a live capture.

  What hosts must change:

  - Requests name a registered `model` or a declared alias. A string that relied on prefix resolution (a dated snapshot, a `-latest` suffix) is `bad_request`: use a registered id, or add the suffix to `aliases` on a descriptor in a custom registry.
  - A custom `ModelRegistry` resolves exactly and implements `findByModel` and `listDescriptors` (or is built with `createModelRegistry`).
  - A custom `ModelDescriptor` adds `limits`, `configKeys: toConfigKeys(configSchema)`, a `configJsonSchema` built with `toConfigJsonSchema(configSchema)`, and `capabilities.inputMimeTypes` if the model takes media; it removes `vision` and `audioInput` (ask `isMediaTypeAdmitted(type, descriptor.capabilities?.inputMimeTypes ?? [])` instead) and sets `limits.maxOutputTokens: null` where the provider documents none (code that reads it as a number handles `null`). Do not mutate a registered descriptor's `limits` or `inputMimeTypes` (it throws in strict mode).
  - A `maxOutputTokens` above a Gemini model's limit (65,536) is `bad_request` at config validation; a part whose media type the model does not admit (WebP, GIF or `image/jpg` on xAI, `application/json` on Gemini) is `bad_request` before dispatch, naming `messages[i].parts[j]`.
  - Code that narrows `Warning` on `type === 'other'` handles `'shutdown'` too; a host that treats any `warnings` entry as a failure expects the advisory once per client for `gemini-3.1-flash-lite`, and moves that model to `gemini-3.5-flash-lite` before 2027-05-07.

## 0.7.0

### Minor Changes

- 64942d1: Replace `claude-fable-5` with `claude-fable-5-1` and `claude-opus-4-8` with `claude-opus-5-5`. Disable silent model switching. Direct adapter calls now require a matching model descriptor. Haiku 4.5 has no reasoning key. A successful `stop_reason: refusal` response returns `finishReason: 'content_filter'` with billed usage.

  Host migration: use `claude-fable-5-1` and `claude-opus-5-5` in place of the deleted ids. No aliases are provided.

### Patch Changes

- Updated dependencies [64942d1]
  - @gullabs/core@0.15.0

## 0.6.1

### Patch Changes

- cb4980f: Raise runtime dependency floors: `zod` `^4.6.5` (was `^4.4.3`) in core, google, xai,
  claude-cli and codex-cli, and `@google/genai` `^2.23.0` (was `^2.19.0`) in any-llm. No API
  changes.
- Updated dependencies [cb4980f]
  - @gullabs/core@0.14.1

## 0.6.0

### Minor Changes

- 79bac18: Raise the supported runtime and narrow provider peer ranges.

  - **Breaking:** `engines.node` is now `>=22.12.0` on every published package. Node 20
    reached end of life in April 2026 and is no longer supported.
  - **Breaking:** `@gullabs/google` requires `@google/genai` `^2` (was `^1 || ^2`), and
    `@gullabs/any-llm` now depends on `@google/genai` `^2.19.0`.
  - **Breaking:** `@gullabs/xai` requires `openai` `^7` (was `^6 || ^7`).

  Development moves to Node 24 (`.nvmrc` pins 24.20.0) and pnpm 11.24.0; pnpm settings
  now live in `pnpm-workspace.yaml` rather than `package.json` and `.npmrc`.

### Patch Changes

- 79bac18: Point `repository.url`, `homepage`, and `bugs` at the canonical GitHub org path
  `gul-labs/any-llm`. The org was renamed from `GulLabs`; the old path still
  redirects in a browser, but npm provenance matches `repository.url` literally
  against the attestation's `sourceRepositoryURI`, so a redirect does not satisfy
  it and the next provenance publish would have failed the same way the earlier
  lowercase-casing incident did.

  The npm scope `@gullabs` is a separate namespace and is unchanged.

- Updated dependencies [79bac18]
- Updated dependencies [79bac18]
  - @gullabs/core@0.14.0

## 0.5.1

### Patch Changes

- Updated dependencies [6a5a662]
  - @gullabs/core@0.13.1

## 0.5.0

### Minor Changes

- 0521973: Breaking (pre-1.0): function-calling seam (ADR-029). `FinishReason` includes `tool_calls`; `tool-call` / `tool-result` parts; `LlmRequest.tools` / `toolChoice`; `toolCalls` on results and records.

  No agent loop. `runStructured` + tools is `bad_request`. Google and grok-4.5/4.6 implement and gate on `functionCalling`. CLI adapters reject `tools` and the new part kinds. Google `countTokens` stays `exact` with tools; xAI `countTokens` rejects tools. xAI store:false replay is live-verified.

### Patch Changes

- Updated dependencies [0521973]
- Updated dependencies [0521973]
  - @gullabs/core@0.13.0

## 0.4.5

### Patch Changes

- Updated dependencies [90a47a1]
  - @gullabs/core@0.12.1

## 0.4.4

### Patch Changes

- 2ab1ea6: Add `grok-4.6` with live-verified reasoning (`low`/`medium`/`high`/`xhigh`) and `serviceTier: 'priority'`. Widen core `ReasoningEffort` with `'xhigh'`. Refresh xAI pricing (`xai-2026-08-12`: 4.5 cached $0.30/$0.60; 4.6 $2/$0.50/$6 and $4/$1/$12) and re-verify Gemini snapshot (`gemini-2026-08-12`; registered-model rates unchanged). xAI `price()` now receives the served tier (`'default'` | `'priority'`) instead of `undefined`; custom xAI pricing sources must price `'default'` at the standard list.
- Updated dependencies [2ab1ea6]
  - @gullabs/core@0.12.0

## 0.4.3

### Patch Changes

- Updated dependencies [d46fd27]
  - @gullabs/core@0.11.0

## 0.4.2

### Patch Changes

- cb6d52f: Fix `totalTokens` being permanently omitted from `Usage` (and thus null in `llm_calls.total_tokens`) for every codex-cli and claude-cli call. Neither CLI's JSON output reports a total-tokens figure directly — `codex exec --json`'s `turn.completed.usage` and `claude -p --output-format json`'s result envelope `usage` object both only report `input_tokens`/`output_tokens` (plus subset fields like `cached_input_tokens`/`reasoning_output_tokens`/`cache_read_input_tokens`). `inputTokens`/`outputTokens` were already captured correctly; only the derived total was missing.

  `mapUsage()` in both adapters now derives `totalTokens = inputTokens + outputTokens` (a GROSS total — subset fields like `reasoning_output_tokens`/`cached_input_tokens` are not added again) whenever a usage payload was actually present on the CLI response. When the CLI reports no usage payload at all, `totalTokens` stays `undefined` rather than being synthesized as `0`, matching how `inputTokens`/`outputTokens` already fall back only as a last resort.

- Updated dependencies [a3f74be]
  - @gullabs/core@0.10.0

## 0.4.1

### Patch Changes

- Updated dependencies [20453fc]
  - @gullabs/core@0.9.0

## 0.4.0

### Minor Changes

- 0b44a5e: Provider-plugin architecture: `@gullabs/core` becomes provider-agnostic (zero Google/Gemini/Gemma knowledge), provider packages own their model configs, pricing, and options types, and wiring goes through a new `composeProviders()` seam. New `@gullabs/xai` package adds a Grok provider (breaking, pre-1.0).

  **Breaking changes:**

  - `ProviderOptions` is removed as a closed type. It is replaced by an extensible `ProviderOptionsMap` interface; provider packages declare their own options via module augmentation (`declare module '@gullabs/core' { interface ProviderOptionsMap { google?: GoogleProviderOptions } }`).
  - `GenConfig.serviceTier` widens from Google's literal union `'flex' | 'standard'` to an opaque provider-defined `string`; `ModelDescriptor.capabilities.serviceTiers` widens to `readonly string[]`. Retry tier pinning (`revalidatePinnedServiceTier`) is now descriptor-driven instead of hardcoding Google's tier vocabulary.
  - `GenConfig.flexFallback` is removed from core. It now lives under `providerOptions.google.flexFallback`, admitted only by the flex branch of each Gemini model's config schema.
  - `@gullabs/core` no longer exports any Google/Gemini/Gemma-named symbol: `GoogleProviderOptions`, `GoogleSafetySetting`, `GoogleSearchTool`, the Gemini/Gemma model descriptors and config schemas, `GEMINI_PRICING`, `TIER_FACTOR`, `geminiPricingSource`, and `defaultGeminiRegistry` all move to `@gullabs/google`. They remain available from `@gullabs/any-llm`, which re-exports both `@gullabs/core` and `@gullabs/google`.
  - `ClientConfig.modelRegistry` is now required — there is no default registry. Build one via `composeProviders()`.
  - `GeminiClientLike.countTokens` is now a required method on the structural client interface. Anyone building a custom fake against this interface (including via `@gullabs/testing`) must implement it.

  **New features:**

  - New `@gullabs/xai` package: an xAI Grok provider adapter (`xaiProvider()`) with `grok-4.5` on the Responses API — reasoning (`low`/`high` effort), native structured output, vision, automatic caching via `promptCacheKey`, and live-verified pricing including the >200k long-context tier.
  - New `ProviderPlugin` interface and `composeProviders()` helper in `@gullabs/core` — the standard way to wire one or more provider packages into `createClient`: `createClient({ ...composeProviders([googleProvider(), xaiProvider()]) })`.
  - New `Client.countTokens()` — dry-run token counting with no generation and no billing, implemented for Google via `@google/genai`'s `models.countTokens`.
  - `GoogleCacheStore` gains an optional token-count preflight gate before cache creation.
  - New `geminiContentToMessages()` migration utility in `@gullabs/google` for converting hand-authored `@google/genai` prompts into any-llm's normalized message shape.
  - New `assertRegistryInvariants()` shared test helper in `@gullabs/testing` for provider-package model-onboarding tests (schema-artifact completeness, JSON-schema staleness, pinned model-id lists, pricing coverage, fixture-list membership).
  - New `claudeCliProvider()` / `codexCliProvider()` plugin factories for the existing dev-only CLI provider packages, so they compose the same way as API-backed providers.

  **Migration notes:**

  Wire providers through `composeProviders()` instead of constructing `adapters`/`modelRegistry`/`pricingSources` by hand:

  ```ts
  import { createClient, composeProviders } from '@gullabs/core'
  import { googleProvider } from '@gullabs/google'

  const client = createClient({
    ...composeProviders([googleProvider()]),
  })
  ```

  Flex-fallback configuration moves to `providerOptions.google.flexFallback` on the request.

### Patch Changes

- Updated dependencies [0b44a5e]
  - @gullabs/core@0.8.0

## 0.3.0

### Minor Changes

- ba21620: Provider-qualified model identity — explicit `(provider, model)` everywhere (breaking, pre-1.0).

  - `LlmRequest`, `CallSite`, and `ResolvedRequest` now require a top-level `provider: string`; `model` stays the bare provider-native string forwarded verbatim to SDKs/CLIs. Bare requests without a provider, unregistered `(provider, model)` pairs, and slash-style `'provider/model'` strings are rejected with `bad_request`.
  - `ModelRegistry` is keyed by `(provider, model)`: `resolve(provider, model)`, `ModelDescriptor.id` renamed to `model`, duplicate exact pairs throw, the same bare model may exist under multiple providers with different config schemas, and prefix matching never crosses providers.
  - Routing is always by `req.provider`: the single-adapter bypass is removed, custom `route(provider, model, adapters)` results are checked against `adapter.id === req.provider`, and `createClient` verifies every registry descriptor's provider has a matching adapter.
  - Pricing composes per provider: `ClientConfig.pricing` is replaced by `pricingSources: Record<provider, PricingSource>`; the port shape is unchanged and `geminiPricingSource()` is the google-scoped source. A provider without a source yields an unpriced result with a warning.
  - Telemetry events carry `provider`; quota's `providerQuotaMiddleware` reads `req.provider` from the request (the `provider` option is removed).

### Patch Changes

- Updated dependencies [ba21620]
  - @gullabs/core@0.7.0

## 0.2.0

### Minor Changes

- e3da339: Add dev-only `@gullabs/claude-cli` and `@gullabs/codex-cli` provider adapters. These route LLM calls through a locally-authenticated `claude` (Claude Code) or `codex` (OpenAI Codex) CLI session so iterating on long Temporal workflows (dozens of LLM-call activities) costs $0 in API spend. They are impossible to run in production by construction — both require an interactive CLI login on the machine — and are not fallbacks for API providers.

  Auth uses the new `{ cliSession: true }` variant of `AuthMaterial`; model descriptors and config schemas live inside each package (not `@gullabs/core`) since dev-only models must not enter the production core surface.

### Patch Changes

- Updated dependencies [e3da339]
  - @gullabs/core@0.6.0
