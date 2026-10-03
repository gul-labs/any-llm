# Grounded -> Structured on Gemini

The Google adapter rejects `googleSearch` plus `output.jsonSchema` on every
registered Gemini model (`structuredOutputWithTools: false` on all six Gemini 3.x
descriptors) with `bad_request`, before any network call. The error message points
here. The provider accepts the request shape, but an accepted request is not proof
that Search ran: the 2026-09-26 and 2026-10-02 live probes (table below) show models
that skipped Search or returned no `groundingMetadata` when a schema was attached.
Use the two-call recipe below: a grounded call without a schema, then a structured
call over its text.

A call that sends `googleSearch` is never priced as exact. Grounding fees are not in
the token price, so the result's `cost.confidence` is `'estimated'` and the result
carries a warning saying grounding fees are not included.

Live re-probe on 2026-10-02 (Developer API, one grounded question per model, with
`responseSchema` and with `responseJsonSchema`):

| model                    | Search ran with a schema?                        | `groundingMetadata` returned?  |
| ------------------------ | ------------------------------------------------ | ------------------------------ |
| `gemini-3.1-pro-preview` | yes                                              | only with `responseJsonSchema` |
| `gemini-3.8-flash`       | yes (prompt tokens rose from 267 to 3.7k–5.2k)   | no                             |
| `gemini-3.7-flash`       | probably (prompt tokens rose from 33 to 144–353) | no                             |
| `gemini-3.6-flash`       | probably (prompt tokens rose from 33 to 216–532) | no                             |
| `gemini-3.5-flash-lite`  | no (prompt tokens stayed at 33)                  | no                             |
| `gemini-3.1-flash-lite`  | no on 3 of 4 calls                               | no                             |

The same question without a schema returned `groundingMetadata` with four or five search
queries. The adapter now sends `responseJsonSchema` for structured output (ADR-034); the table was
recorded with both fields. The table is the evidence for keeping the capability off: on the
Flash-Lite models an accepted request with a schema usually means Search did not run at all, and
only one model returned `groundingMetadata` with a schema (and only with `responseJsonSchema`).

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
- `research.providerMetadata?.groundingMetadata` — Gemini grounding payload;
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
(`{ url, title?, sourceName? }`). Raw `groundingMetadata` stays on
`providerMetadata`. Empty / unused grounding omits the field.

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
