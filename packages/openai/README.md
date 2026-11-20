# @gullabs/openai

OpenAI provider adapter for any-llm, over the official `openai` npm SDK's Responses API. It maps a `ResolvedRequest` to a Responses request, streams the call internally through the SDK's own `responses.stream()` helper and maps the terminal response back to an `AdapterResult`. It never persists, never retries and never loops; cost comes from its pricing source.

**Evidence.** Every model fact, rate and wire shape in this package is documented, not live-verified: it was read from OpenAI's public documentation and the installed SDK's typings on 2026-11-20, and no OpenAI call was made to build it (ADR-047 in [`DECISIONS.md`](../../DECISIONS.md)). The open questions a live probe would settle are in [`BACKLOG.md`](../../BACKLOG.md).

## Install

```bash
pnpm add @gullabs/openai @gullabs/core openai  # peers: openai ^7.60.0, @gullabs/core (same version)
```

## Quick example

```ts
import { createClient, composeProviders } from '@gullabs/core'
import { openaiProvider } from '@gullabs/openai'

const client = createClient({ ...composeProviders([openaiProvider()]) })

const result = await client.generate(
  {
    provider: 'openai',
    model: 'gpt-6.2-sol',
    system: 'Answer in one sentence.',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'What is a monad?' }] }],
    config: { reasoning: { effort: 'low' } },
  },
  { auth: { apiKey: 'YOUR_OPENAI_KEY' } },
)
```

## Models

| Model           | Reasoning effort                                | Service tier   | Context   | Max output |
| --------------- | ----------------------------------------------- | -------------- | --------- | ---------- |
| `gpt-6.2-astra` | `low`, `medium`                                 | `fast`         | 1,050,000 | 128,000    |
| `gpt-6.2-sol`   | `low`, `medium`                                 | `fast`         | 1,050,000 | 128,000    |
| `gpt-6.1-terra` | `none`, `low`, `medium`, `high`, `xhigh`, `max` | `flex`, `fast` | 1,050,000 | 128,000    |
| `gpt-6-luna`    | `none`, `low`, `medium`, `high`, `xhigh`, `max` | `flex`, `fast` | 1,050,000 | 128,000    |

Each model has its own strict config schema (`Gpt62AstraConfigSchema`, `Gpt62SolConfigSchema`, `Gpt61TerraConfigSchema`, `Gpt6LunaConfigSchema`): `maxOutputTokens` (1 to 128,000, reasoning included), `reasoning.effort`, `serviceTier` and `timeoutMs`. Nothing else is admitted:

- **No sampling keys.** GPT-6.2 is documented to reject `temperature` and `top_p`; the Terra and Luna pages are silent, so they are not admitted either.
- **GPT-6.2 effort is `low` or `medium`.** The pages say `none` is rejected and name only `low` and `medium` for GPT-6.2. `high`, `xhigh` and `max` wait for a probe.
- **No `ultrafast`, no Batch, no background windows.** Flex exists on Terra and Luna only ("We won't be adding Flex to new models").
- **No `providerOptions` lane** and no `countTokens` in this release.

Aliases and sibling ids (`gpt-6.1-sol`, `gpt-6-astra`, `gpt-6.2-astra-law`, …) are not registered.

## What it sends

- `store: false` on every request.
- `system` as a leading `developer` input message (top-level `instructions` are appended after the input and are not cacheable, per the GPT-6.2 guide).
- Text and image input. Images are PNG, JPEG, WebP or (non-animated) GIF, as inline base64 or a fully qualified `http(s)` URL, at most 1,500 per request and 512 MB of inline payload. File ids, documents and media-resolution hints are rejected.
- `reasoning: { effort }` when set. `reasoning.context` is never sent, so the model default applies.
- Strict structured output (`text.format`, `strict: true`) and strict client-side function tools. The two cannot be combined in one request, and `parallel_tool_calls` is never sent.
- Every other part kind, config key or value is `bad_request` before dispatch, naming the path.

## Credentials and the SDK client

The API key is per call (`auth.apiKey`, ADR-019) and is checked before the SDK is built. The SDK client is built for each call with every value the SDK would otherwise take from the environment pinned: `apiKey`, `baseURL: 'https://api.openai.com/v1'`, `organization: null`, `project: null`, `adminAPIKey: null`, `webhookSecret: null`, `logLevel: 'off'` and `maxRetries: 0`. The SDK also merges `OPENAI_CUSTOM_HEADERS` into its default headers, applied after the auth header; the client drops them. So `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `OPENAI_ADMIN_KEY`, `OPENAI_WEBHOOK_SECRET`, `OPENAI_LOG` and `OPENAI_CUSTOM_HEADERS` cannot change where a call goes or what it sends. One HTTP request per attempt: retries belong to the engine's `retryMiddleware`.

## Function calling and continuation

All four models continue with `'state'` (ADR-029): `result.transientProviderState` is `{ openai: { model, input } }`, the full wire input plus every provider output item in order (encrypted reasoning included). The next turn sends only the new messages (tool results, a new user message) with that state; assistant history beside the state is rejected, and so is a state bound to another provider or model, one whose first developer message differs from `system`, and one that holds an item this release does not produce (a built-in tool call, a file input). A tool result must answer a call the state holds that has not been answered. A function call of a response that did not complete is dropped with a warning.

```ts
import { createClient, composeProviders } from '@gullabs/core'
import type { ToolDefinition } from '@gullabs/core'
import { openaiProvider } from '@gullabs/openai'

const client = createClient({ ...composeProviders([openaiProvider()]) })
const auth = { auth: { apiKey: 'YOUR_OPENAI_KEY' } }
const tools: ToolDefinition[] = [
  {
    name: 'weather',
    description: 'Current temperature for a city',
    inputJsonSchema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
]

const first = await client.generate(
  {
    provider: 'openai',
    model: 'gpt-6.2-sol',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Weather in Oslo?' }] }],
    tools,
  },
  auth,
)
const call = first.toolCalls?.[0]
if (call !== undefined && first.transientProviderState !== undefined) {
  const next = await client.generate(
    {
      provider: 'openai',
      model: 'gpt-6.2-sol',
      tools,
      // Only the new messages: the state already holds the history.
      transientProviderState: first.transientProviderState,
      messages: [
        {
          role: 'user',
          parts: [
            {
              kind: 'tool-result',
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              result: { celsius: -3 },
            },
          ],
        },
      ],
    },
    auth,
  )
  console.log(next.text)
}
```

## Strict JSON Schema

Output schemas and tool parameters go through core's `assertJsonSchemaProfile` with `OPENAI_JSON_SCHEMA_PROFILE` and then the strict-mode rules of the Structured Outputs guide: an object root that is not `anyOf`, `additionalProperties: false` and every property in `required` on every object (model optional fields as a union with `null`), at most 5,000 properties, 10 levels of nesting, 1,000 enum values and 120,000 characters of names and enum values. Admitted keywords: `type`, `properties`, `required`, `additionalProperties`, `enum`, `anyOf`, `$ref` / `$defs` (recursion allowed), `items`, `minItems` / `maxItems`, `minimum` / `maximum`, `exclusiveMinimum` / `exclusiveMaximum`, `multipleOf`, `pattern`, and `format` (`date-time`, `time`, `date`, `duration`, `email`, `hostname`, `ipv4`, `ipv6`, `uuid`). The schema `title` becomes the format name and must match `^[a-zA-Z0-9_-]{1,64}$`.

## Streaming and failures

The call streams internally; there is no public `stream()`. A terminal event (`response.completed`, `response.incomplete` or `response.failed`) is required. Following ADR-036 and ADR-040:

- A stream that ends cleanly without a terminal event is a `server` error, never the accumulated snapshot.
- Before any output event a transient failure stays retryable and carries no usage. After output began nothing is retried, the error is `mayHaveBilled` and carries a usage ESTIMATE (`usage.details.usage_estimated = 1`; unpriced, the served tier being unknown).
- One deadline covers the whole stream: `timeoutMs + 5 s`, or one hour without `timeoutMs`. It ends as `timeout`, `reason: 'transport_timeout'`, not retryable. A caller abort is re-thrown (`aborted`, or the engine's own timeout).
- `response.failed` is classified by `error.code` (`server_error` and `rate_limit_exceeded` retry only before output), keeps the terminal usage and the echoed tier, and is `mayHaveBilled`. A mid-stream `error` event follows the same table.
- `incomplete` with `max_output_tokens` is `finishReason: 'length'`, with `content_filter` is `content_filter`, anything else `other` with a warning. A refusal part gives `content_filter` and a warning.
- HTTP errors: 401 and 403 `invalid_auth`, 400 / 404 / 422 `bad_request`, 429 a retryable `rate_limited` with `Retry-After` honoured, 5xx a retryable `server` error. A 429 whose `error.code` is `credit_balance_exhausted`, `organization_spend_limit_exceeded`, `project_spend_limit_exceeded` or `organization_usage_limit_exceeded` (or whose type is `insufficient_quota`) is not retryable, `reason: 'credits_exhausted'`.

`providerMetadata.openai.requestId` carries the `x-request-id` of a successful call.

## Pricing

`openaiPricingSource()` prices snapshot `openai-2026-11-20` from the tier the response echoes, never the requested one: `default` is standard, `flex` is 50% of every lane (Terra and Luna), `fast` or `priority` is 2× every lane. A response that echoes no tier is unpriced (`usage.details.service_tier_missing = 1`); any other echoed value is an unpriced tier.

| Model           | Input / 1M | Cached / 1M | Output / 1M | Long input | Long cached | Long output |
| --------------- | ---------- | ----------- | ----------- | ---------- | ----------- | ----------- |
| `gpt-6.2-astra` | $8.00      | $0.40       | $40.00      | $16.00     | $0.80       | $60.00      |
| `gpt-6.2-sol`   | $2.00      | $0.10       | $10.00      | $4.00      | $0.20       | $15.00      |
| `gpt-6.1-terra` | $1.00      | $0.05       | $5.00       | $2.00      | $0.10       | $7.50       |
| `gpt-6-luna`    | $0.10      | $0.01       | $0.50       | $0.20      | $0.02       | $0.75       |

- **Long context** applies to the whole request above 272,000 gross input tokens (272,000 is short). Whether cached tokens count toward the threshold is not documented, so a call whose band depends on them is `estimated`.
- **Cache writes** are billed at 1.25× input (30-minute TTL, the default) and 2.5× (12-hour) inside the `input` lane; reads at the cached rate; ordinary input is `input − reads − writes`. That subtraction is inferred from the caching guide, so any call with writes is `estimated`, and writes without a TTL split are priced at the 30-minute rate. Usage that does not reconcile, or lacks its cache lanes, is unpriced.
- Regional-processing and FedRAMP surcharges (+10% each) are not modelled.

## Testing

`openaiAdapter({ client })` takes any structural `OpenAiClientLike` (`responses.create(params, options)` resolving to the terminal response object). This package's own tests run the real SDK over a stubbed `fetch` with documentation-derived event frames; there is no public fake in `@gullabs/testing` in this release.

## Not built in this release

Document and file-id inputs, `countTokens`, built-in tools (web search, file search, code interpreter, …), a file store, `prompt_cache_options`, `reasoning.mode: 'pro'`, `text.verbosity`, background windows, `ultrafast`, Batch, `high` / `xhigh` / `max` effort on GPT-6.2, and a public fake. Each is a BACKLOG item.
