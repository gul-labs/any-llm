---
name: any-llm
description: >-
  Guidance for writing, reviewing, or debugging TypeScript code that calls
  @gullabs/any-llm, @gullabs/core, @gullabs/google, or @gullabs/xai to talk to Gemini
  or xAI Grok models. Applies when adding a new LLM call site, composing provider
  plugins with composeProviders, wiring createClient/generate/runStructured/countTokens,
  defining a defineCallSite prompt template, requesting structured JSON output,
  catching or narrowing an LlmError, configuring reasoning/thinking budgets, wiring a
  UsageSink for cost tracking, augmenting ProviderOptionsMap for a new provider
  package, using GoogleCacheStore for Gemini context caching, or migrating raw
  @google/genai prompts via geminiContentToMessages. Also applies whenever the user
  mentions any-llm, the Gemini adapter, the xAI/Grok adapter, Gemini Flex tier,
  structured-output validation, token counting, or per-call auth for this library.
  Covers the mandatory per-call `{ auth: { apiKey } }` pattern (there is no env-var or
  ambient auth), the caller-owned output-validation contract, the descriptor-owned
  strict model-config boundary (`configSchema` / `configJsonSchema`), the
  provider-qualified `(provider, model)` identity contract, and the reject-don't-map
  error philosophy — the things a developer used to other LLM SDKs would otherwise get
  wrong by default.
---

# any-llm

Typed, provider-agnostic-by-design LLM call engine with cost tracking, retries, rate
limiting, structured output, and per-call observability. Providers are plugged in
explicitly via `composeProviders` — nothing is auto-wired.

Core packages:

- `@gullabs/core` — engine (`createClient`), types, errors, `defineCallSite`,
  `composeProviders`.
- `@gullabs/google` — Gemini + Gemma adapter (`geminiAdapter`) over `@google/genai`.
- `@gullabs/xai` — xAI Grok adapter (`xaiAdapter`) over the Responses API.
- `@gullabs/any-llm` — batteries-included: re-exports `@gullabs/core` + `@gullabs/google`
  plus `@google/genai` as a dependency. Does **not** bundle `@gullabs/xai` or any other
  provider package — install those separately and compose them alongside.

Install `@gullabs/any-llm` for a one-package Gemini setup, or `@gullabs/core` plus
whichever provider package(s) you need (`@gullabs/google`, `@gullabs/xai`, ...) for
explicit dependency control. Import names are identical either way.

## #1 gotcha: auth is per-call, always

**There is no env-var auth, no ambient/singleton auth, no `AuthProvider` port.** Every
`generate()` and `runStructured()` call requires `opts.auth = { apiKey: string }`
explicitly. `createClient()` itself takes no credentials.

```ts
// WRONG — GenerateOptions.auth is a required field; this will not type-check, and if
// bypassed with `as any` it throws LlmError({ kind: 'invalid_auth' }) before any I/O.
const client = createClient({
  ...composeProviders([googleProvider()]),
})
await client.generate(request, {} as GenerateOptions)

// RIGHT — bring the key from wherever your app resolves it, pass it on every call.
const auth = { apiKey: myResolvedGeminiKey }
await client.generate(request, { auth })
```

A missing, empty, or non-string `apiKey` throws `LlmError` with `kind: 'invalid_auth'`
before any network call is made. Vertex AI (ADC/service-account auth) is **not
supported** — it was removed and is a roadmap item only; do not write code assuming
`{ vertex: { project, location } }` works.

## #2 gotcha: identity is `(provider, model)`, not a bare `model` string

Every `generate()`/`runStructured()` request and every `defineCallSite()` requires an
explicit top-level `provider` (e.g. `'google'`, `'claude-cli'`, `'codex-cli'`) alongside
the bare, provider-native `model` string. The engine routes by `req.provider` directly
— it never derives, parses, or guesses a provider from `model`, and it never accepts a
slash-joined string like `'google/gemini-2.5-flash'`. A request with no `provider`, an
unconfigured `provider`, or a `(provider, model)` pair the registry doesn't recognize is
rejected with `LlmError({ kind: 'bad_request' })` before any I/O. This also means the
same bare model id can exist under multiple providers with different config schemas —
`resolve()` always takes both.

## Quickstart

```ts
import { createClient, composeProviders, googleProvider } from '@gullabs/any-llm'
// (or: composeProviders from '@gullabs/core', googleProvider from '@gullabs/google',
// if using modular install)

const client = createClient({
  ...composeProviders([googleProvider()]),
})

const result = await client.generate(
  {
    provider: 'google',
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello!' }] }],
  },
  { auth: { apiKey: myResolvedGeminiKey } },
)

console.log(result.text) // raw text
console.log(result.usage) // { inputTokens, outputTokens, cachedInputTokens?, thinkingTokens?, details, raw }
console.log(result.cost?.microUsd) // integer micro-USD, or null if unpriced
```

`Message.parts` is `TextPart | InlineMediaPart | FileUriPart` — multimodal input mixes
`{ kind: 'text', text }`, `{ kind: 'inline-media', mimeType, data /* raw base64, no data: prefix */ }`,
and `{ kind: 'file-uri', uri, mimeType }` freely in one `parts` array.

## Counting tokens without generating

`client.countTokens` is a metadata-only dry run — no generation, no cost, no
`result.output`. Same `(provider, model)` routing and required `auth` as `generate`;
throws `LlmError('bad_request')` when the pair is unregistered or the resolved adapter
doesn't implement token counting (`ProviderAdapter.countTokens` is optional).

```ts
const count = await client.countTokens(
  {
    provider: 'google',
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello!' }] }],
  },
  { auth: { apiKey: myResolvedGeminiKey } },
)

console.log(count.totalTokens) // number
console.log(count.details) // optional per-category breakdown, e.g. { cached: 128 }
console.log(count.raw) // provider's raw token-count response, verbatim
```

`TokenCountRequest` is deliberately narrower than a generate request — no `config`, no
`output`, no `providerOptions`; token counting only needs `provider`, `model`, and
`messages`. Google rejects `system` and `tools` with `bad_request` (its count cannot
include them, so the number would be wrong); xAI rejects `tools`. To budget a call that
has a system prompt or tools, read `usage.inputTokens` from a real `generate()` result.

## Composing multiple providers — xAI Grok example

`composeProviders` takes any number of plugins; pass every provider a single client
should route to. `@gullabs/xai`'s `xaiProvider()` follows the identical plugin shape
as `googleProvider()`:

```ts
import { createClient, composeProviders } from '@gullabs/core'
import { googleProvider } from '@gullabs/google'
import { xaiProvider } from '@gullabs/xai'

const client = createClient({
  ...composeProviders([googleProvider(), xaiProvider()]),
})

const result = await client.generate(
  {
    provider: 'xai',
    model: 'grok-4.6',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello, Grok.' }] }],
    config: { reasoning: { effort: 'high' } },
  },
  { auth: { apiKey: myResolvedXaiKey } },
)
```

`grok-4.5` admits `reasoning.effort` `'low' | 'medium' | 'high'`.
`grok-4.6` and `grok-4.7` also admit `'xhigh'`. All three admit
`serviceTier: 'priority'` (2× list price). `'none'` is rejected. No `topK`.

## xAI structured-output schemas vs. OpenAI-strict / codex-cli schemas

As of the 2026-07-09 live probes, xAI's `strict: true` structured-output validation
on `text.format` json_schema performed no OpenAI-style compile-time schema checks —
schemas missing root/nested `additionalProperties: false`, properties omitted from
`required` (optional properties), `format`/other keywords, `anyOf`, `$defs`/`$ref`,
and nullable unions (`type: [T, 'null']`) were all accepted with HTTP 200.
`@gullabs/xai`'s adapter forwards schemas to xAI verbatim; no rewriting is applied.

`@gullabs/codex-cli`, by contrast, targets the codex CLI's own `--output-schema`
backend, which (verified 2026-07-09 via live probes against the real codex CLI
binary/backend) enforces exactly two structural rules: every object node must carry
`additionalProperties: false`, and `required` must be present and include every key
in `properties` (optional semantics are preserved by adding `null` to that
property's type, not by simply marking it required). `@gullabs/codex-cli` exports
`toOpenAiStrictOutputSchema` — an explicit opt-in transformer, never called
automatically by the adapter — that rewrites a schema to satisfy those two rules.
codex-cli's local preflight (`assertOpenAiStrictOutputSchema` in
`packages/codex-cli/src/adapter.ts`) enforces both rules locally before dispatch,
turning what used to be a live-round-trip provider 400 into an immediate local
`bad_request`.

This preflight/transformer pair is specific to codex-cli's own `--output-schema`
contract, not a general any-llm behavior — it is not applied to xai, which has no
such preflight (see the xAI Grok section above).

## Migrating raw `@google/genai` prompts

`geminiContentToMessages` (from `@gullabs/google`) converts hand-authored
`@google/genai` `Content[]` into any-llm's normalized `{ system?, messages }` shape.
Reject-don't-map: a missing/unrecognized `Content.role` (only `'user'` and `'model'`
are accepted, never inferred), a `systemInstruction` containing anything other than
plain text parts, or any `Part` sub-field this library can't losslessly represent
(function calls, executable code, tool results, thought-flagged parts,
`thoughtSignature`, unknown future fields, etc.) throws `LlmError('bad_request')`
naming the offending field — nothing is ever silently dropped.

```ts
import { geminiContentToMessages } from '@gullabs/google'
import type { Content } from '@google/genai'

const contents: Content[] = [
  {
    role: 'user',
    parts: [
      { text: 'Describe this image.' },
      { inlineData: { mimeType: 'image/png', data } },
    ],
  },
  { role: 'model', parts: [{ text: 'A red bicycle leaning against a brick wall.' }] },
]

const { system, messages } = geminiContentToMessages({
  contents,
  systemInstruction: 'You are a concise visual describer.',
})

const result = await client.generate(
  { provider: 'google', model: 'gemini-2.5-pro', system, messages },
  { auth: { apiKey: myResolvedGeminiKey } },
)
```

`system` is derived only from the explicit `systemInstruction` input — never inferred
from `contents`.

## Testing with `@gullabs/testing`

Real hosts don't call `createClient()` at call sites — they own a factory module that
assembles the client once and hand call sites the built client. `@gullabs/testing`'s
fakes (`makeFakeGemini`, `FakeAdapter`, `RecordingSink`, `FakeClock`, `FakeIds`, ...) are
designed to inject through that same host-owned factory unchanged, via injectable
override parameters with production defaults — not via `vi.mock()`. See
`packages/testing/README.md` § "Wiring fakes through a host-owned factory" for a
complete two-file (factory + vitest test) example, including the port-level
`FakeAdapter` variant for bypassing the Gemini SDK shape entirely.

## `defineCallSite` — reusable prompt templates

```ts
import { defineCallSite } from '@gullabs/core'

const summarize = defineCallSite({
  id: 'summarize-article', // persisted as callSiteId on every record
  provider: 'google',
  model: 'gemini-2.5-flash',
  system: 'You are a concise summarizer.',
  userTemplate: 'Summarize this article in 3 sentences:\n\n{{article}}',
  config: { temperature: 0.3 },
})

const result = await client.runStructured(summarize, { article: text }, { auth })
```

`{{var}}` interpolation is non-recursive (substituted values are never re-scanned for
further `{{...}}`, preventing template injection) and applies to both `system` and
`userTemplate`. **Strict by default (no opt-out):** every `{{var}}` placeholder must have
a string-typed value in `vars`, or `runStructured` throws before any request is built —
see "Input contracts" below. `runStructured` also accepts a two-arg form, `(callSite,
opts)`, when the template has no vars. Config resolution order everywhere is
`clientDefaults → callSite.config → opts.config`, and the merged config must still pass
the selected descriptor's strict runtime schema before dispatch.

## Input contracts — strict interpolation, `inputSchema`, `inputContract`

**Strict template interpolation is the default, with no opt-out.** Every `{{var}}`
placeholder referenced by `callSite.system` or `callSite.userTemplate` must have a
string-typed value present in `vars`, or `runStructured` refuses the call before any
request is built — zero tokens spent:

```ts
import { defineCallSite, LlmError } from '@gullabs/core'

const summarize = defineCallSite({
  id: 'summarize-article',
  provider: 'google',
  model: 'gemini-2.5-flash',
  userTemplate: 'Summarize this article in 3 sentences:\n\n{{article}}',
})

try {
  // Missing `article` — throws before any I/O.
  await client.runStructured(summarize, {}, { auth })
} catch (e) {
  if (e instanceof LlmError && e.kind === 'bad_request') {
    console.log(e.issues) // [{ path: 'article', message: '...' }]
  }
}
```

`null`, `undefined`, and non-string values (numbers, objects) are all violations — never
coerced to a string. Unused `vars` entries (present in `vars` but not referenced by any
template) are allowed. There is no escape syntax for literal `{{...}}` text.

**`CallSite.inputSchema`** validates `vars` with a `StandardSchemaV1` validator (zod,
valibot, ...) before interpolation runs, so a missing business field surfaces in your own
schema's vocabulary instead of as a downstream placeholder violation:

```ts
import { z } from 'zod'

const reviewCallSite = defineCallSite({
  id: 'code-review',
  provider: 'google',
  model: 'gemini-2.5-flash',
  userTemplate: 'Review this diff as {{reviewer}}:\n\n{{diff}}',
  inputSchema: z.object({
    reviewer: z.string().min(1),
    diff: z.string().min(1),
  }),
})

await client.runStructured(
  reviewCallSite,
  { reviewer: 'senior-reviewer', diff },
  { auth },
)
```

**`LlmRequest.inputContract`** is the equivalent opt-in contract for the `generate()`
path (callers who render their own prompt strings and never touch `CallSite`):

```ts
const result = await client.generate(
  {
    provider: 'google',
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: renderedPrompt }] }],
    inputContract: { schema: myZodSchema, value: sourceContext },
  },
  { auth },
)
```

`inputContract` is validated once per logical call, before `@gullabs/quota` or any retry
middleware runs — a violation never consumes rate-limit budget and is never retried.
`generate()` and `runStructured()` are independent paths: `runStructured` never
auto-populates `inputContract` from `inputSchema`, and `generate()` never reads
`inputSchema`.

**`createClient({ requireInputContract: true })`** is a fleet-wide toggle: every
`generate()` call must carry `inputContract`, and every `runStructured()` call site must
carry `inputSchema`, or the call is refused. Off by default.

**All violations throw `LlmError('bad_request')`** with a structured `issues` array
(`{ path, message }[]`, one entry per violation) on top of the usual `.message` string.

**Ledger semantics of refusals.** A refusal that never got a `callId` (unresolved
placeholders, `CallSite.inputSchema`, or `requireInputContract` on the `runStructured`
path — all thrown in the `runStructured` prologue) writes **no** ledger row. A refusal
that already has a `callId` (`inputContract` violations and `requireInputContract` on the
`generate()` path, thrown inside the pipeline after `callId` assignment) writes **one**
zero-usage record with `attemptNumber: 0` — including `@gullabs/quota` denials, which get
the same treatment with no `@gullabs/quota` code changes. See ADR-025 in `DECISIONS.md`
for the full boundary table.

## Strict model-config boundary

Treat model config as descriptor-owned:

```ts
import { defaultGeminiRegistry } from '@gullabs/google'

const descriptor = defaultGeminiRegistry.resolve('google', 'gemini-3.6-flash')
if (!descriptor) throw new Error('unknown model')

// UI/forms:
const formSchema = descriptor.configJsonSchema

// Persisted or user-supplied config:
const parsedConfig = descriptor.configSchema.parse({
  reasoning: { effort: 'medium' },
  serviceTier: 'flex',
})
```

Important distinctions:

- `descriptor.configSchema` is the runtime boundary for request config.
- `descriptor.configJsonSchema` is derived from that same schema for form generation.
- `request.output.jsonSchema` is only the output-format hint for structured responses.
- `providerOptions.google` is a typed provider-extension lane, not a caller-wins
  override lane for `serviceTier`, sampling, reasoning, or response schema.

## Extending `ProviderOptionsMap` for a third-party provider

`GenConfig.providerOptions` is typed as `ProviderOptions`, an alias for
`ProviderOptionsMap` — an empty, augmentable interface owned by `@gullabs/core`. It
carries no keys until a provider package augments it via TypeScript declaration
merging. `@gullabs/google` and `@gullabs/xai` are the two reference implementations
(`packages/google/src/types.ts`, `packages/xai/src/types.ts`):

```ts
declare module '@gullabs/core' {
  interface ProviderOptionsMap {
    google?: GoogleProviderOptions
  }
}
```

A third-party provider package follows the identical pattern. For a hypothetical
`@acme/my-provider` package:

```ts
// packages/my-provider/src/types.ts
export type MyProviderOptions = {
  someAllowlistedKnob?: string
}

declare module '@gullabs/core' {
  interface ProviderOptionsMap {
    myProvider?: MyProviderOptions
  }
}
```

Importing anything from that module — even a type-only import — pulls in the
augmentation, so re-export it unconditionally from the package's `index.ts` (the way
`packages/google/src/index.ts` and `packages/xai/src/index.ts` both do) to guarantee
the `myProvider` key is visible on `ProviderOptionsMap` whenever a caller imports
anything from the package. Once loaded, `config.providerOptions.myProvider`
type-checks at call sites — but the model's `configSchema` must also allowlist that
key for the value to survive validation; the Zod schema remains the runtime boundary,
the type augmentation only makes the shape visible to the compiler.

## Structured output — auth + validation together

`request.output = { jsonSchema }` (or `callSite.jsonSchema`) is forwarded to the
provider as a **hint**, not enforced by the library. The engine JSON-parses the
response and sets `outputParsed`; `result.output` is always `unknown`. **The caller
owns shape validation** — this library does not validate output shape itself.

```ts
import { createClient, composeProviders, googleProvider } from '@gullabs/any-llm'
import type { StandardSchemaV1 } from '@gullabs/core'

const client = createClient({
  ...composeProviders([googleProvider()]),
})

const result = await client.generate(
  {
    provider: 'google',
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Rate this PR 1-10.' }] }],
    output: {
      jsonSchema: {
        type: 'object',
        properties: { rating: { type: 'number' }, summary: { type: 'string' } },
        required: ['rating', 'summary'],
      },
    },
  },
  { auth: { apiKey: myResolvedGeminiKey } }, // auth is still required
)

// 1. Gate on outputParsed first — cheap boolean signal.
if (result.outputParsed !== true) {
  // provider didn't return parseable JSON — retry, escalate, or fall back
} else {
  // 2. Then validate shape with any Standard Schema v1 validator (zod, valibot, etc.
  //    all implement '~standard'). Do NOT trust result.output's shape without this.
  const validated = await mySchema['~standard'].validate(result.output)
  if ('issues' in validated && validated.issues !== undefined) {
    // shape invalid but JSON-parseable — inspect validated.issues
  } else {
    // validated.value is now typed
  }
}
```

Full caller-owned validation helper: `docs/structured-output-validation.md` in the
source repo (see "For more detail" below — this file may not ship in `node_modules`).

## Error handling

Every rejection from `generate()` / `runStructured()` is an `LlmError` with a `.kind`
discriminant (from `packages/core/src/errors.ts`):

| `kind`           | Meaning                                                                                           | Retryable |
| ---------------- | ------------------------------------------------------------------------------------------------- | --------- |
| `invalid_auth`   | 401, missing/empty `apiKey`, or a 403 the adapter did not reclassify                              | No        |
| `rate_limited`   | 429 — provider quota exceeded                                                                     | Yes       |
| `server`         | 5xx — transient provider error                                                                    | Yes       |
| `timeout`        | exceeded `config.timeoutMs` or a network timeout                                                  | Yes       |
| `aborted`        | caller's `AbortSignal` fired                                                                      | No        |
| `bad_request`    | 400/422, or a request the library rejected before I/O                                             | No        |
| `content_filter` | provider refused the call for safety / AUP (Gemini 200-path blocks; xAI 403 input-safety overlay) | No        |
| `unknown`        | uncategorized — inspect `.cause`                                                                  | No        |

```ts
import { LlmError } from '@gullabs/core'

try {
  const result = await client.generate(request, { auth })
} catch (e) {
  if (e instanceof LlmError) {
    if (e.retryable) scheduleRetry(e.retryAfterMs)
    else if (e.kind === 'invalid_auth') /* surface a credentials error */
    else throw e
  } else {
    throw e // never expected — the engine always throws LlmError
  }
}
```

`LlmError` also carries `httpStatus?`, `retryAfterMs?`, `provider?`, `callId?`,
`attemptId?`, `servedServiceTier?`, `issues?` (structured `{ path, message }[]` — see
"Input contracts" above), and `cause` (the original thrown value).

## Reject, don't map

Bad input or config throws `bad_request` (or `invalid_auth`) **before any I/O** —
nothing is silently clamped, coerced, or defaulted around a typo. Examples already
enforced by the engine/adapter: a request or call site with no `provider`, a `provider`
that doesn't match any configured adapter, a `(provider, model)` pair absent from the
registry (including a bare model string with a slash, like `'google/gemini-2.5-flash'`
— slash strings are never parsed), a config value that fails the selected descriptor
schema, a `reasoning.budgetTokens` set on a model whose API only supports
`reasoning.effort`, duplicate adapter/middleware `id`s, and a grounding +
structured-output combination outside the exact documented Gemini support set.

**Do not add defensive fallback/clamping code around this library.** If a call throws
`bad_request`, fix the input — do not catch-and-retry with a "safer" guessed value; the
library is telling you the config is invalid, not transiently rejected.

## Reasoning / thinking budgets

```ts
config: {
  reasoning: { effort: 'medium', includeThoughts: true }
}
```

`ReasoningEffort` is `'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'`. Admitted values
are per-model. Two provider APIs exist under the hood: Gemini 2.5 models take a
token `budgetTokens`; Gemini 3.x / Gemma 4 / xAI take a discrete `effort` level.

Use the model-native boundary directly:

- Gemini 2.5: `reasoning.budgetTokens` or admitted `reasoning.effort` (not `xhigh` or `max`)
- Gemini 3 / Gemma 4: `reasoning.effort` (not `xhigh` or `max`)
- xAI `grok-4.5`: `reasoning.effort` `'low' | 'medium' | 'high'`
- xAI `grok-4.6` and `grok-4.7`: `reasoning.effort` `'low' | 'medium' | 'high' | 'xhigh'`

Registered Google ids: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`,
`gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, `gemini-3.5-flash-lite`,
`gemini-3.6-flash`, `gemini-3.7-flash`, `gemini-3.8-flash`, `gemma-4-31b-it`,
`gemma-4-26b-a4b-it`. `gemini-3-flash-preview` and `gemini-3.5-flash` do not resolve.

Exact model reminders:

- `gemini-3.1-pro-preview`, `gemini-3.7-flash`, and `gemini-3.8-flash` do **not** admit `effort: 'none'`
- Explicit-cache floors: 1024 on all six registered Gemini 3.x ids, live-verified on 2026-09-26 by a 103-token rejection and exact 1024-token create; 2048 remains configured on Gemini 2.5.
- Gemma 4 is binary: only `effort: 'none'` or `effort: 'high'`
- Omit `serviceTier` for provider-standard; set `flex` explicitly
- `priority` remains rejected by the library even though Google documents it
- July 21, 2026: Google deprecated sampling parameters `temperature`, `top_p`, and `top_k`. Gemini 3.x schemas already omit them. Gemini 2.5 and Gemma stay tunable.
- September 18, 2026: Gemini 2.5 access is restricted to projects that already used 2.5. The three 2.5 ids stay registered.
- xAI long-context rates apply at gross input `>= 200_000` (`long_context_threshold` is inclusive).

## Context caching — `GoogleCacheStore`

`GoogleCacheStore` (from `@gullabs/google`) is a thin, **process-scoped** wrapper over
the Gemini Context Cache API (`create` / `getOrCreate` / `refreshIfExpiringSoon` /
`delete`). Pass the resulting `cacheName` as `providerOptions.google.cachedContent` on
a request. Reuse is only within this store instance's in-memory map — it is not
shared across processes, workers, or restarts.

Optional preflight gate: pass `preflight` to the constructor to refuse a cache
`create()` — including through `getOrCreate()` and its coalesced in-flight path —
when the token-bearing payload (`model` + `contents` + `systemInstruction` only;
`ttl` and `displayName` are excluded) doesn't clear a minimum token count. This
mirrors the selected model's explicit-caching minimum (1024 on Gemini 3.x;
2048 on Gemini 2.5) without hard-coding it into the store.

```ts
import { GoogleCacheStore } from '@gullabs/google'

const cacheStore = new GoogleCacheStore({
  auth: { apiKey: myResolvedGeminiKey },
  preflight: {
    minTokens: 1024,
    // Receives genai-native Content[]/Content|string — NOT the library's
    // Message[] shape; there is no automatic conversion. Hosts building from
    // Message[] should call client.countTokens separately instead.
    countTokens: async (payload) => {
      const result = await genaiClient.models.countTokens(payload)
      return result.totalTokens ?? 0
    },
  },
})

const handle = await cacheStore.create({
  model: 'gemini-3.1-pro-preview',
  ttlSeconds: 3600,
  contents: myGenaiContents,
})
// Throws LlmError('bad_request') before any I/O if preflight.countTokens resolves
// below minTokens — nothing is silently allowed through under the minimum.
```

## Rate limiting and cost tracking

- Pre-send backpressure is a `RateLimiter` port (`ClientConfig.rateLimiter`); default
  is a no-op. `@gullabs/core` ships a dependency-free `inMemoryRateLimiter`, and the
  companion `@gullabs/quota` package provides shared/cross-process quota primitives —
  see that package's README for setup. The limiter runs once per attempt (inside each
  retry). Put `providerQuotaMiddleware` inside `retryMiddleware`; `createClient` rejects
  the other order.
- A middleware cannot change `provider` or `model` (`bad_request`); route and fall back
  in the host by making a new call. Correlate host retries with a shared `externalId`;
  every attempt is its own billed row.
- Every call computes `result.cost` (micro-USD) via the configured `PricingSource`
  (`geminiPricingSource()`), and, when `sink` is configured on `createClient`, persists
  a full per-attempt record (usage, cost, warnings, error classification) — fail-open,
  so a broken sink never fails the LLM call. See `docs/ledger.md` for the record shape
  and the `@gullabs/drizzle` package for a ready-made Postgres `UsageSink`.

## Common mistakes

- Forgetting `opts.auth` on a `generate()`/`runStructured()` call — it is required on
  every call, not just once at `createClient()` time.
- Omitting `provider` (or writing a slash-joined `'provider/model'` string) on a request
  or call site — `provider` is a required top-level field; the engine never derives it.
- Assuming `process.env.GEMINI_API_KEY` (or similar) is read automatically — it is
  never read by this library; the host must resolve and pass the key itself.
- Assuming `result.output`'s shape is validated — it is `unknown`; validate it yourself
  (Standard Schema v1) after checking `result.outputParsed === true`.
- Assuming Vertex AI is a supported target — it currently is not (roadmap only); only
  the Gemini Developer API (API-key auth) is supported.
- Catching a `bad_request` `LlmError` and retrying with a clamped/guessed value instead
  of fixing the call — the library never silently coerces invalid config.
- Setting `reasoning.budgetTokens` on a `thinkingLevel`-API model (Gemini 3.x / Gemma 4) — use `reasoning.effort` instead; the descriptor schema should reject it.
- Assuming omitted `serviceTier` still means Flex — it now stays omitted and
  uses provider-default request behavior unless you explicitly opt into `flex`.

## For more detail

These docs live in the source repo and may not ship in the installed `node_modules`
copy — the auth + structured-output example above is intentionally self-contained.

- `README.md` — full quickstart, install options, Gemma 4 notes.
- `docs/structured-output-validation.md` — full caller-owned validation helper.
- `docs/multi-runtime.md` — client construction across request/response vs. worker code.
- `docs/ledger.md` — persisted record field reference.
- `docs/grounded-structured.md` — grounding + structured output two-call pattern.
