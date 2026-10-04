# @gullabs/any-llm

The default, batteries-included any-llm client package.

"Batteries-included" means concretely this: `@gullabs/any-llm` depends on `@gullabs/google` (the
Gemini adapter) and `@google/genai` (the Gemini SDK), takes `@gullabs/core` (the engine) as an
exact-version peer dependency that your package manager installs for you, and re-exports the full
public API of core and google, so a single `pnpm add` gets you a working client instead of three
separate installs.

## Install

```bash
pnpm add @gullabs/any-llm
```

This installs the Gemini adapter and `@google/genai`, plus the `@gullabs/core` engine at the same
version. Core is an exact-version peer dependency, which npm 7+ and pnpm install automatically.
Package managers that do not install peers (pnpm with `autoInstallPeers: false`, yarn, npm with
`--legacy-peer-deps`) leave it out, and the import then fails with `Cannot find module '@gullabs/core'`.
There, add it yourself at the same version:

```bash
pnpm add @gullabs/any-llm @gullabs/core   # or: yarn add ... / npm i ... --legacy-peer-deps
```

All `@gullabs/*` packages must be at one version; see
[Versioning](../../RELEASING.md#versioning-one-version-for-every-package).

## Usage

```ts
import {
  createClient,
  composeProviders,
  defaultGeminiRegistry,
  defineCallSite,
  googleProvider,
} from '@gullabs/any-llm'

const client = createClient({
  ...composeProviders([googleProvider()]),
})

const summarize = defineCallSite({
  id: 'summarize',
  provider: 'google',
  model: 'gemini-2.5-flash',
  jsonSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      bullets: { type: 'array', items: { type: 'string' } },
    },
    required: ['title', 'bullets'],
  },
  userTemplate: 'Summarize this:\n\n{{text}}',
})

// Auth is required per call — the library never reads environment variables itself.
const result = await client.runStructured(
  summarize,
  { text: 'The document to summarize.' },
  { auth: { apiKey: process.env.GEMINI_API_KEY! } },
)

const descriptor = defaultGeminiRegistry.resolve('google', 'gemini-3.6-flash')
if (!descriptor) throw new Error('unknown model')

const parsedConfig = descriptor.configSchema.parse({
  reasoning: { effort: 'medium' },
})
```

Built-in descriptors own the strict model-config contract:
`descriptor.configSchema` parses persisted or user-supplied config, and
`descriptor.configJsonSchema` is the derived UI/form schema. Use
`reasoning.effort` for Gemini 3 and Gemma built-ins, omit `serviceTier` for the
provider's standard tier, and set `flex` explicitly when that trade-off is
intended. `priority` remains rejected by the library for now.

Registered Google ids: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`,
`gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`,
`gemini-3.6-flash`, `gemini-3.7-flash`, `gemini-3.8-flash`, `gemma-4-31b-it`,
`gemma-4-26b-a4b-it`. `gemini-3.1-pro-preview`, `gemini-3.7-flash`, and
`gemini-3.8-flash` do not admit `effort: 'none'`. `gemini-3-flash-preview` and
`gemini-3.5-flash` do not resolve.

## Key exports

This package re-exports the full public API of `@gullabs/core` and `@gullabs/google` verbatim —
`createClient`, `composeProviders`, `defineCallSite`, `googleProvider`, `geminiAdapter`,
`geminiPricingSource`, `LlmError`, and every other named export from both packages. See their
READMEs for details:

| Export                      | What it is                                                           |
| --------------------------- | -------------------------------------------------------------------- |
| `createClient(config)`      | Wires ports into a `{ generate, runStructured, countTokens }` client |
| `composeProviders(plugins)` | Merges `ProviderPlugin`s into `ClientConfig` fields                  |
| `defineCallSite(opts)`      | Defines a typed, reusable prompt template bound to a model           |
| `googleProvider(opts?)`     | The Gemini `ProviderPlugin` factory, from `@gullabs/google`          |
| `geminiAdapter(opts?)`      | The Gemini `ProviderAdapter`, from `@gullabs/google`                 |
| `geminiPricingSource()`     | Built-in Gemini pricing snapshot, from `@gullabs/google`             |
| `LlmError`                  | Typed error class — always thrown on call failure                    |
| `ANY_LLM_VERSION`           | This package's version, sourced from `package.json`                  |

Use `@gullabs/core` and `@gullabs/google` directly only when you want modular dependency control.

## AI-agent skill

This package ships an [Agent Skill](https://code.claude.com/docs/en/skills) at
[`skills/any-llm/SKILL.md`](./skills/any-llm/SKILL.md) for AI coding tools that support the
convention (e.g. Claude Code). Point a compatible assistant at it to get accurate, up-to-date
usage guidance for this library instead of relying on its training data.

## Learn more

- [Monorepo root README](../../README.md) — full architecture, auth model, and package overview
- [`docs/structured-output-validation.md`](../../docs/structured-output-validation.md) — validating `result.output` after `outputParsed`
- [`docs/multi-runtime.md`](../../docs/multi-runtime.md) — web route + Temporal worker integration pattern
