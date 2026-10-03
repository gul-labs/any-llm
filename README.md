<p align="center">
  <img src="docs/assets/hero.jpg" alt="any-llm — typed LLM calls, frozen cost, no ambient secrets" width="100%">
</p>

<h1 align="center">any-llm</h1>

<p align="center">
  In-process TypeScript client for provider-hosted models.<br>
  Typed calls. Frozen micro-USD cost. No ambient secrets.
</p>

<p align="center">
  <a href="https://github.com/gul-labs/any-llm/actions/workflows/ci.yml"><img src="https://github.com/gul-labs/any-llm/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@gullabs/any-llm"><img src="https://img.shields.io/npm/v/@gullabs/any-llm.svg" alt="npm @gullabs/any-llm"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0"></a>
  <a href="https://www.npmjs.com/package/@gullabs/any-llm"><img src="https://img.shields.io/node/v/@gullabs/any-llm.svg" alt="Node current"></a>
</p>

A thin adapter over raw provider SDKs. No agent loop, no framework, no magic. Every call goes through one pipeline: validate config → dispatch → normalize usage → price → persist.

| You get                                                | You do not get                          |
| ------------------------------------------------------ | --------------------------------------- |
| Canonical model IDs, rejected when unknown             | Alias maps and silent remaps            |
| Per-call `auth` you pass in                            | `process.env` / ADC / ambient key reads |
| Frozen integer µUSD + `pricingVersion` on every record | Repriced history                        |
| Thinking tokens and optional thought text              | An agent runtime                        |
| Fail-open sink / telemetry / cost                      | A broken logger failing the LLM call    |

## Install

```bash
pnpm add @gullabs/any-llm
```

That one package is the Gemini facade: `@gullabs/google` + `@google/genai` as dependencies, and
`@gullabs/core` as its exact-version peer, which npm 7+ and pnpm install for you. A package manager
that does not install peers (pnpm with `autoInstallPeers: false`, yarn, npm with
`--legacy-peer-deps`) needs `pnpm add @gullabs/any-llm @gullabs/core` (or the yarn/npm equivalent) at the
same version, or the import fails with `Cannot find module '@gullabs/core'`.

Add other providers yourself. Auth stays host-injected on every call.

```bash
pnpm add @gullabs/core @gullabs/google @gullabs/xai @google/genai openai
# peers: @google/genai for Gemini; openai ^7 for xAI Responses (baseURL api.x.ai)
```

**One version for every package.** All `@gullabs/*` packages are released together under one
version number, and `@gullabs/core` is an exact-version peer of every other package. Install
them all at the same version and upgrade them together. A mix, even of patch releases, is
unsupported and fails peer-dependency checks (pnpm `strictPeerDependencies`, npm 7+). See
[RELEASING.md](./RELEASING.md#versioning-one-version-for-every-package).

## Quickstart

```ts
import {
  createClient,
  composeProviders,
  defineCallSite,
  googleProvider,
} from '@gullabs/any-llm'

const client = createClient({
  ...composeProviders([googleProvider()]),
})

const codeReview = defineCallSite({
  id: 'code-review',
  provider: 'google',
  model: 'gemini-2.5-flash',
  jsonSchema: {
    type: 'object',
    properties: {
      rating: { type: 'number' },
      summary: { type: 'string' },
    },
    required: ['rating', 'summary'],
  },
  system: 'You are a senior code reviewer.',
  userTemplate: 'Review this diff:\n\n{{diff}}',
  config: {
    reasoning: { includeThoughts: true, effort: 'medium' },
    serviceTier: 'flex',
  },
})

const myDiff = '- let x = 1\n+ const x = 1'
const auth = { apiKey: process.env.MY_APP_GEMINI_KEY! }
const result = await client.runStructured(codeReview, { diff: myDiff }, { auth })

console.log(result.output) // unknown; caller validates
console.log(result.outputParsed)
console.log(result.usage) // { inputTokens, outputTokens, cachedInputTokens, thinkingTokens }
console.log(result.cost?.microUsd) // integer µUSD, frozen at call time
console.log(result.reasoningText)
```

Persist records with [`@gullabs/drizzle`](./packages/drizzle) by passing `sink: drizzleUsageSink({ db })` to `createClient`. The ledger row holds usage, cost, settings and your `metadata`, plus text the model or the provider produced (reasoning text, tool-call arguments, error messages, citation URLs). The full prompt and response text is stored only if you opt in with `payloads` on the client config, and that opt-in governs the payload table only: see [what each table holds](./docs/ledger.md#what-each-table-holds) and [Payload storage](./packages/drizzle/README.md#payload-storage). Stored text can contain customer data, and retention is yours.

A network-free walkthrough lives in [`examples/basic.ts`](./examples/basic.ts). Run it with `pnpm example`.

## Multi-provider

```ts
import { createClient, composeProviders } from '@gullabs/core'
import { googleProvider, GoogleFileStore } from '@gullabs/google'
import { xaiProvider, XaiFileStore } from '@gullabs/xai'

const xaiKey = 'YOUR_XAI_KEY'
const geminiKey = 'YOUR_GEMINI_KEY'

const client = createClient({
  ...composeProviders([googleProvider(), xaiProvider()]),
})

await client.generate(
  {
    provider: 'xai',
    model: 'grok-4.6',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
  },
  { auth: { apiKey: xaiKey } },
)

const xaiFiles = new XaiFileStore({ auth: { apiKey: xaiKey } })
const geminiFiles = new GoogleFileStore({ auth: { apiKey: geminiKey } })
```

See [`packages/xai/README.md`](./packages/xai/README.md) for `XaiFileStore` / `FileRefPart` and fail-closed delete.

## Fallback

The library does not reroute. A middleware cannot change a call's `provider` or `model` (the call
fails with `bad_request`), and there is no fallback middleware: the host decides where a failed call
goes next. Catch the error and make a **new** call against the other target with that target's
config and auth. Each call has its own `callId`, is validated and priced against its own model, and
writes its own rows; give both the same `externalId` to link them.

```ts
import { composeProviders, createClient, LlmError } from '@gullabs/core'
import type { Message } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'
import { xaiProvider } from '@gullabs/xai'

const googleKey = 'YOUR_GEMINI_KEY'
const xaiKey = 'YOUR_XAI_KEY'
const client = createClient({
  ...composeProviders([googleProvider(), xaiProvider()]),
})

async function generateWithFallback(messages: Message[], externalId: string) {
  const targets = [
    { provider: 'google', model: 'gemini-2.5-pro', auth: { apiKey: googleKey } },
    { provider: 'xai', model: 'grok-4.6', auth: { apiKey: xaiKey } },
  ]
  let last: unknown
  for (const { auth, ...target } of targets) {
    try {
      return await client.generate({ ...target, messages, externalId }, { auth })
    } catch (err) {
      if (!(err instanceof LlmError) || !err.retryable) throw err
      last = err
    }
  }
  throw last
}
```

## Auth

The library never reads credentials from the environment or any ambient source. There is no `envAuth()`, no `AuthProvider` port, and no client-level `auth` on `createClient`. Pass `auth` on every call:

```ts no-check
client.generate(request, { auth: { apiKey } })
client.runStructured(callSite, { auth: { apiKey } })
```

`AuthMaterial` is `{ apiKey: string, keyId?: string }`. `keyId` is an optional opaque label for attribution (for example `'gemini-paid'`). It is persisted as `LlmCallRecord.authKeyId` and must never be the secret.

The key is redacted from persisted records and logs. Vertex AI is not in this tree — see [Roadmap](./ROADMAP.md).

## Contracts that do not bend

- **Reject, do not map.** Unknown models, unadmitted reasoning efforts, and unpriced service tiers fail at the descriptor boundary.
- **Descriptor-owned config.** `descriptor.configSchema` is the runtime boundary; `descriptor.configJsonSchema` is derived from it for forms.
- **GROSS tokens.** `cachedInputTokens ⊆ inputTokens`, `thinkingTokens ⊆ outputTokens`. Cost must not double-count.
- **Cost is frozen.** Integer micro-USD + `pricingVersion` on every record. Unpriced models stay `null`.
- **Callers own output validation.** The adapter JSON-parses structured output; the engine returns it as `output: unknown` plus `outputParsed` and never validates it.
- **Side effects fail-open.** A broken sink, logger, or pricing source cannot fail the LLM call. Rate-limiter rejection is the one exception — backpressure is real.
- **No network in tests.** Use [`@gullabs/testing`](./packages/testing).

Gemini 2.5 uses `reasoning.budgetTokens`. Gemini 3 / Gemma built-ins use `reasoning.effort`. `gemini-3.1-pro-preview`, `gemini-3.7-flash`, and `gemini-3.8-flash` do not admit `effort: 'none'`. Omit `serviceTier` for provider default; set `flex` only when you want that lane. Google `priority` is documented upstream and still rejected here. The adapter records the provider's `usageMetadata.serviceTier` echo when present and falls back to the dispatched tier when absent.

Registered Google ids: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`, `gemini-3.6-flash`, `gemini-3.7-flash`, `gemini-3.8-flash`, `gemma-4-31b-it`, `gemma-4-26b-a4b-it`. Deleted, with no alias: `gemini-3-flash-preview` and `gemini-3.5-flash` (migrate to `gemini-3.6-flash`).

Dev-only CLI ids: `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`; `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5`, `claude-haiku-4-5-20251001`. Deleted, with no alias: every `gpt-5*` id, `claude-fable-5`, and `claude-opus-4-8`.

## Packages

| Package                                        | What it is                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`@gullabs/any-llm`](./packages/any-llm)       | Gemini facade: re-exports core + Google adapter and installs `@google/genai`        |
| [`@gullabs/core`](./packages/core)             | Engine, ports, cost, records. No provider SDKs                                      |
| [`@gullabs/google`](./packages/google)         | Gemini / Gemma over `@google/genai`. Flex, thinking, files, cache, grounding        |
| [`@gullabs/xai`](./packages/xai)               | Grok over the `openai` SDK Responses API. `grok-4.5` / `grok-4.6` / `grok-4.7`      |
| [`@gullabs/drizzle`](./packages/drizzle)       | Postgres `llm_calls` schema + `drizzleUsageSink`                                    |
| [`@gullabs/quota`](./packages/quota)           | Provider quota: rpm, rpd (day boundary), tpm; Gemini + xAI presets; in-memory store |
| [`@gullabs/testing`](./packages/testing)       | Fakes: clock + scheduler, client, sink, error factories, stores, runner. Dev-only   |
| [`@gullabs/claude-cli`](./packages/claude-cli) | Dev-only local `claude` CLI provider. Not for production                            |
| [`@gullabs/codex-cli`](./packages/codex-cli)   | Dev-only local `codex` CLI provider. Not for production                             |

Published on npm under `@gullabs`, Apache-2.0, Node `>=22.12.0`.

## Runtimes

**Node `>=22.12.0`** is what every package declares in `engines` and what CI runs (22.12.0 and 24; the repository's own tooling needs Node 24). Nothing in the code needs a newer Node.

| Packages                                                                                                     | Runtime                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@gullabs/core`, `@gullabs/google`, `@gullabs/xai`, `@gullabs/quota`, `@gullabs/drizzle`, `@gullabs/any-llm` | **Runtime-agnostic code.** No `node:` import, no `Buffer`, no `process`. They use only web-standard globals: `fetch`, `AbortSignal`, `TextEncoder`, `atob`, `Blob` and `FormData` (the file stores), timers, and `globalThis.crypto.randomUUID()` for ids. Hashes (ADR-038 payloads, Gemini signature state) use a dependency-free SHA-256 (`sha256Hex`), not `node:crypto`. |
| `@gullabs/claude-cli`, `@gullabs/codex-cli`                                                                  | **Node only.** They spawn the local CLI (`node:child_process`).                                                                                                                                                                                                                                                                                                              |
| `@gullabs/testing`                                                                                           | **Node only** (a dev dependency): it imports `node:os` and `node:module`.                                                                                                                                                                                                                                                                                                    |

What is verified, and what is not:

- **Node 22.12.0 and 24**: the whole test suite, in CI.
- **No Node built-ins**: `pnpm test:runtime` (also in CI) loads the built ESM entry of each runtime-agnostic package with every `node:` import blocked, then runs a complete `generate()` with a payload and an inline media part after removing `Buffer` and `process`. It proves the library code needs neither; it does not run another engine.
- **Deno 2.4.1**: the same script passes when run by hand. Not part of CI.
- **Not tested**: Bun, Cloudflare Workers, Vercel Edge, browsers. The library code has no known blocker there, but the provider SDKs it wraps (`@google/genai`, `openai`) set their own runtime support, and a host that needs one of these runtimes should run its own smoke test. The CJS builds are for Node `require`; the built-ins check covers the ESM entries.

## Pipeline

```
generate() / runStructured()
  → resolveConfig()            libDefaults → callSite → opts
  → validateModelConfig()      Standard Schema; terminal on failure
  → route(provider, model)
  → opts.auth                  required; never read from env
  → rateLimiter.acquire()
  → adapter.run()
  → normalizeUsage()           GROSS token convention
  → structured output          adapter's parse → output, outputParsed; caller validates
  → pricing.price()            µUSD; fail-open
  → sink.record()              fail-open
  → LlmResult
```

Ports & adapters: the engine depends on `ProviderAdapter`, `UsageSink`, `PricingSource`, and `RateLimiter`. Concrete SDKs live in provider packages.

## Guides

| Topic                           | Doc                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------- |
| Architecture                    | [`docs/architecture.md`](./docs/architecture.md)                                 |
| v1 contract                     | [`SPEC.md`](./SPEC.md)                                                           |
| ADRs                            | [`DECISIONS.md`](./DECISIONS.md)                                                 |
| Web + Temporal                  | [`docs/multi-runtime.md`](./docs/multi-runtime.md)                               |
| Grounding then structured       | [`docs/grounded-structured.md`](./docs/grounded-structured.md)                   |
| Validating `result.output`      | [`docs/structured-output-validation.md`](./docs/structured-output-validation.md) |
| Ledger / `llm_calls`            | [`docs/ledger.md`](./docs/ledger.md)                                             |
| Gemini files, Flex, cache       | [`packages/google/README.md`](./packages/google/README.md)                       |
| Grok files, reasoning, priority | [`packages/xai/README.md`](./packages/xai/README.md)                             |

Input contracts (`callSite.inputSchema`, `request.inputContract`, `requireInputContract`) are documented in ADR-025 and the [`any-llm` skill](./packages/any-llm/skills/any-llm/SKILL.md).

## Status

Pre-1.0. Breaking changes may land in minor versions. Read the [per-package changelogs](./CHANGELOG.md) before upgrading.

Not in this release: streaming, an agent loop, Vertex AI, multimodal output. Tool-calling is a seam only (tools in, tool-call/tool-result parts out — ADR-029); every result carries `message` and `continuation` so the host's loop follows the provider's rule (see [`packages/core`](./packages/core/README.md#tool-loops-message-continuation-transientproviderstate)). See [`ROADMAP.md`](./ROADMAP.md).

## Contributing

PRs welcome. Only [@atifgul99](https://github.com/atifgul99) can push to `main`.

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — setup and review bar
- [`GOVERNANCE.md`](./GOVERNANCE.md) — who decides
- [`SECURITY.md`](./SECURITY.md) — private reports
- [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- [`RELEASING.md`](./RELEASING.md) — changesets + npm provenance

```bash
pnpm install
pnpm quality   # build + lint + typecheck + doc snippets + test (the CI gate)
```

## License

[Apache-2.0](./LICENSE) © 2026 [Gul Labs](https://github.com/gul-labs)
