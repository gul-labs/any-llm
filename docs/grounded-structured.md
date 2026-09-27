# Grounded -> Structured on Gemini

The Google adapter admits `googleSearch` plus `output.jsonSchema` on all six
registered Gemini 3.x models. The 2026-09-26 live probes returned structured
JSON, but did not return `groundingMetadata` even when prompted to search.
Treat the combination as an accepted request shape, not proof that Search ran
or a source of normalized citations. If a workflow needs auditable citations,
use the two-call recipe below and check the first call's grounding metadata.

The old `googleSearchRetrieval` tool name is not a compatibility alias. Use the
documented `googleSearch` tool shape or the descriptor schema rejects the
config.

For citation-sensitive workflows, use two calls:

1. grounded research;
2. structured synthesis.

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
