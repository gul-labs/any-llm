# Grounded -> Structured on Gemini

The Google adapter rejects `googleSearch` plus `output.jsonSchema` on every
registered Gemini model (`structuredOutputWithTools: false` on all six Gemini 3.x
descriptors) with `bad_request`, before any network call. The error message points
here. The provider accepts the request shape, but an accepted request is not proof
that Search ran: the live probes below show models that skipped Search or returned no
`groundingMetadata` when a schema was attached. The default is the two-call recipe
below: a grounded call without a schema, then a structured call over its text.

A host that wants one call can opt in with
`providerOptions.google.allowSchemaWithSearch: true`. The call is then sent as asked, and
`requireGrounding` is turned on for it (override with `requireGrounding: false`): unless
`groundingMetadata` with at least one non-empty `webSearchQueries` entry comes back, the call fails
with a `server` error, reason `grounding_missing`, and the attempt's usage is recorded. With a schema
attached that error is **not retryable**: the same request misses again (rates below), so a retry
middleware would pay for every attempt and fail each time. The error is retryable only on a call
without a schema, which grounded on 4 of 4 captured calls. The measured rates below say how often to
expect the failure.

The opt-in exists only for models with a measured negative result (the six Gemini 3.x models). Gemini
2.5 and Gemma have no capture of schema plus Search, so that combination is rejected there with or
without the flag; use the two-call recipe.

A filtered candidate (`SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `IMAGE_SAFETY`) with no
grounding evidence throws `content_filter` (not retryable), not `grounding_missing`.

Every call that sends `googleSearch` reports `usage.details.web_search_requested` and, when the
response says, `web_search_calls`. The grounding fee is priced on the `tools` lane, and a call that
ran Search is `cost.confidence: 'estimated'` (ADR-035).

## Measured: schema plus Search on Gemini 3.x (live, 2026-10-03)

Four distinct current-events prompts per cell, `responseJsonSchema`, `thinkingLevel: LOW`, Developer
API. "Metadata with a query" means `groundingMetadata` with at least one `webSearchQueries` entry,
the only evidence `requireGrounding` accepts. All 48 calls returned HTTP 200 with well-formed
output. Fixture: `packages/google/src/__fixtures__/grounding-schema-matrix-2026-10-03.json`.

| model                    | no schema: metadata with a query | with schema: metadata with a query | with schema: unexplained prompt-token jump |
| ------------------------ | -------------------------------- | ---------------------------------- | ------------------------------------------ |
| `gemini-3.1-pro-preview` | 4 of 4                           | **2 of 4**                         | 2 of 4                                     |
| `gemini-3.8-flash`       | 4 of 4                           | **0 of 4**                         | 0 of 4                                     |
| `gemini-3.7-flash`       | 4 of 4                           | **0 of 4**                         | 1 of 4                                     |
| `gemini-3.6-flash`       | 4 of 4                           | **0 of 4**                         | 4 of 4                                     |
| `gemini-3.5-flash-lite`  | 4 of 4                           | **0 of 4**                         | 0 of 4                                     |
| `gemini-3.1-flash-lite`  | 4 of 4                           | **0 of 4**                         | 4 of 4                                     |

The rule for turning the pair on by default was metadata with a query on at least 3 of 4 schema
calls. No model meets it (the best is 3.1 Pro at 2 of 4), so `structuredOutputWithTools` stays `false`
everywhere and the combination is opt-in only. With `allowSchemaWithSearch` expect `grounding_missing`
on most attempts for five of the six models, and that error is not retried: use the two-call recipe.

The prompt-token jump column is not a usable "Search ran" signal. On some models a schema'd call
shows a several-fold jump in prompt tokens with no metadata (Search probably ran and was not
reported, so it is billed and invisible); on others a call that did search shows no jump. A control
("reply with exactly OK" plus `googleSearch` plus a schema) added 262 and 176 prompt tokens on 3.1
Flash-Lite and 3.8 Flash with zero queries, and nothing on the other four. Only the metadata
evidence is tested.

Earlier probe (2026-10-02, one question per model, `responseSchema` and `responseJsonSchema`)
reached the same conclusion: Search ran on 3.1 Pro with a schema, probably on 3.8, 3.7 and 3.6, and
not on the Flash-Lite models, and only 3.1 Pro returned `groundingMetadata`, and only with
`responseJsonSchema`.

If you send a grounded call without a schema and want JSON back, say so in the prompt
("respond with JSON only, no code fences"). The adapter returns the model's text unchanged;
it does not strip fences or leading prose.

The old `googleSearchRetrieval` tool name is not a compatibility alias. Use the
documented `googleSearch` tool shape or the descriptor schema rejects the
config.

For any grounded workflow that needs structured output, make two calls:

1. grounded research, with `googleSearch` and no schema;
2. structured synthesis, with `output.jsonSchema` and no `googleSearch`.

Both attempts flow through the normal sink and keep separate ledger rows.

## Why there is no `runGroundedStructured()`

The library intentionally does not ship a one-off client method here yet. Hosts have different
requirements for prompt framing, validation, citation retention, and how they join the two attempts
back into their own workflow tables. The stable first step is a documented recipe with normal
`generate()` / `runStructured()` calls.

## Call 1: grounded research

```ts
const operationId = 'op-2026-01-research'

const research = await client.generate(
  {
    provider: 'google',
    model: 'gemini-2.5-pro',
    system: 'Research the topic and quote only grounded findings.',
    messages: [
      {
        role: 'user',
        parts: [{ kind: 'text', text: `Research: ${topic}` }],
      },
    ],
    callSiteId: 'grounded-research',
    metadata: {
      operationId,
      workflowId,
      reportId,
      phase: 'research',
    },
    config: {
      serviceTier: 'flex',
      providerOptions: {
        google: {
          tools: [{ googleSearch: {} }],
        },
      },
    },
  },
  { auth },
)
```

Important outputs from the first call:

- `research.text` — grounded prose you can pass into synthesis;
- `research.usage.details.web_search_calls` — how many queries the response reports (absent when it
  does not say); `research.cost?.details.tools` is the priced grounding fee;
- `research.providerMetadata?.groundingMetadata` — Gemini grounding payload;
- `research.providerMetadata?.google?.searchEntryPoint` — the Search Suggestions widget Google
  requires a grounded answer to display;
- `research.providerMetadata?.promptFeedback` — prompt-level provider feedback;
- `research.attemptId` — the correlation key for the ledger sidecar pattern: use it as the
  foreign key if you keep a host-owned sidecar row for this attempt (see `docs/ledger.md`).

## Small application-local normalizer

The provider metadata lane is intentionally raw JSON. A small app-local helper keeps the rest of
your workflow code from probing nested provider fields ad hoc:

```ts
type GroundingArtifacts = {
  groundingMetadata?: unknown
  promptFeedback?: unknown
}

function extractGroundingArtifacts(providerMetadata: unknown): GroundingArtifacts {
  if (providerMetadata === null || typeof providerMetadata !== 'object') {
    return {}
  }

  const meta = providerMetadata as Record<string, unknown>
  return {
    ...(meta['groundingMetadata'] !== undefined
      ? { groundingMetadata: meta['groundingMetadata'] }
      : {}),
    ...(meta['promptFeedback'] !== undefined
      ? { promptFeedback: meta['promptFeedback'] }
      : {}),
  }
}
```

The adapter also projects those chunks onto first-class `result.citations`
(`{ url, title?, sourceName?, cited?, textRange? }`). `cited` says whether a
`groundingSupports` segment points at the source and `textRange` is the first supported
span of `result.text` (UTF-16 offsets; Google's UTF-8 byte offsets are converted, and a range that
does not match the segment's own text is dropped with a warning). Raw
`groundingMetadata` stays on `providerMetadata` (without `searchEntryPoint`, which is at
`providerMetadata.google.searchEntryPoint`; render its HTML in a sandboxed iframe). Empty / unused grounding omits the field.

```ts
const citations = research.citations
```

## Call 2: structured synthesis

```ts
const grounding = extractGroundingArtifacts(research.providerMetadata)

const structured = await client.generate(
  {
    provider: 'google',
    model: 'gemini-2.5-flash',
    system: 'Convert grounded research into a structured summary.',
    messages: [
      {
        role: 'user',
        parts: [
          {
            kind: 'text',
            text: [
              'Grounded research:',
              research.text ?? '',
              '',
              'Citation context:',
              JSON.stringify(grounding),
            ].join('\n'),
          },
        ],
      },
    ],
    output: {
      jsonSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          citationsUsed: { type: 'array', items: { type: 'string' } },
        },
        required: ['summary', 'confidence', 'citationsUsed'],
      },
    },
    callSiteId: 'grounded-summary',
    metadata: {
      operationId,
      workflowId,
      reportId,
      phase: 'synthesis',
      groundedAttemptId: research.attemptId,
    },
  },
  {
    auth,
  },
)
```

`structured.output` is JSON-parsed when the model produced valid JSON. The library does not
validate the shape; callers still own schema validation and retry policy.

## Persistence pattern

Recommended persistence flow:

1. let `drizzleUsageSink()` write both `llm_calls` rows normally;
2. keep a host sidecar row for workflow-specific context if you need typed joins;
3. store the relationship between the two attempts in host-owned fields such as
   `groundedAttemptId` or `synthesisAttemptId`.

That produces a durable audit trail without adding special-purpose library APIs.

## What to correlate on

- Use `metadata.operationId` as the canonical link between grounded-research and structured-synthesis.
- `externalId` can still carry one caller-owned convenience id for filtering (for example,
  `reportId`), and a sidecar table is still the right place for typed joins.
- Use `operationId` consistently for this operation; do not define a separate correlation key.

This convention is shared with the multi-runtime example in `docs/multi-runtime.md` so both workflow
chains and runtime boundaries reuse the same relationship field.
