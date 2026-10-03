# Caller-owned structured-output validation

`output.jsonSchema` is standard JSON Schema that the Google and xAI adapters **check and forward**
(ADR-034): they reject dialect mistakes, malformed schemas and keywords the provider would silently
ignore (`const`, `oneOf`, `allOf`, …) before dispatch, then send the schema verbatim. (`claude-cli`
forwards the schema untouched and `codex-cli` runs its own OpenAI-strict preflight.) It is still not
a contract the engine enforces on the _result_: the engine parses JSON when possible, sets
`outputParsed`, and leaves shape validation to callers. A schema constrains the model; some keywords
(`pattern`, `minLength`, `maxLength` on Gemini) are only obeyed probabilistically, so validate what
you rely on.

To keep a schema inside what both Gemini 3.x and xAI enforce, lint it at build time with
`assertPortableJsonSchema` from `@gullabs/core`, for example from Zod:
`assertPortableJsonSchema(z.toJSONSchema(schema))`. Zod's `z.literal('x')` emits `const` (use
`z.enum(['x'])`), `z.discriminatedUnion` emits `oneOf` (use `z.union`), and `z.record(z.enum([...]),
X)` emits a constraining `propertyNames`; the portable check names each one. (`z.record(z.string(),
X)` is fine.) The portable subset does not cover Gemma, whose profile additionally rejects `format`,
`minLength` and `maxLength`.

Use this helper after any structured-output call:

- first gate on `outputParsed` (cheap, boolean signal from the provider path)
- then validate `output` with a Standard-Schema v1 validator (`'~standard'`, same interface as
  `packages/core/src/standard-schema.ts`)

```ts
import type { StandardSchemaV1 } from '@gullabs/core'

type StructuredValidationResult<T> =
  | { ok: true; value: T }
  | {
      ok: false
      reason: 'not_parsed' | 'shape_invalid'
      issues?: readonly StandardSchemaV1.Issue[]
    }

async function validateStructuredResult<T>(
  result: { output?: unknown; outputParsed?: boolean },
  schema: StandardSchemaV1<unknown, T>,
): Promise<StructuredValidationResult<T>> {
  if (result.outputParsed !== true) {
    return { ok: false, reason: 'not_parsed' }
  }

  const parsed = await schema['~standard'].validate(result.output)

  if ('issues' in parsed) {
    return parsed.issues !== undefined
      ? { ok: false, reason: 'shape_invalid', issues: parsed.issues }
      : { ok: false, reason: 'shape_invalid' }
  }

  return { ok: true, value: parsed.value }
}
```

Use any Standard-Schema implementation. This example uses two hand-rolled schemas to show portability:

```ts
const summarySchema: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'example/summary',
    validate(value) {
      const maybe = value as Record<string, unknown>
      if (
        value !== null &&
        typeof value === 'object' &&
        typeof maybe['summary'] === 'string' &&
        typeof maybe['confidence'] === 'number'
      ) {
        return {
          value: { summary: maybe['summary'], confidence: maybe['confidence'] },
        }
      }

      return { issues: [{ message: 'summary schema mismatch' }] }
    },
    types: {
      input: { summary: '' as string, confidence: 0 as number },
      output: { summary: '' as string, confidence: 0 as number },
    },
  },
}

const citationShapeSchema: StandardSchemaV1 = {
  '~standard': {
    version: 1,
    vendor: 'example/citations',
    validate(value) {
      const maybe = value as Record<string, unknown>
      return maybe && typeof maybe === 'object' && Array.isArray(maybe['citations'])
        ? { value: { citations: maybe['citations'] } }
        : { issues: [{ message: 'citations must be an array' }] }
    },
    types: {
      input: { citations: [] as unknown[] },
      output: { citations: [] as unknown[] },
    },
  },
}
```

This pattern is the caller-owned fix for the gap documented as **"New gap: silent structured-output parse failures"**
in `docs/archive/ADOPTION-FEEDBACK.md`.

## Example usage

```ts
// Pick the schema from something you already know — e.g. which `output.jsonSchema`
// you requested — never by introspecting `result.output`, which is `unknown` until
// a schema has validated it.
const wantsCitations = false // set from your own request/response bookkeeping

const validation = await validateStructuredResult(
  result,
  wantsCitations ? citationShapeSchema : summarySchema,
)

if (!validation.ok && validation.reason === 'not_parsed') {
  // retry, escalate, or run fallback path
} else if (!validation.ok) {
  // shape invalid but parsed; inspect validation.issues and decide retry policy
} else {
  // validation.value is typed to your chosen schema
}
```

The helper does not mutate `result`; it is pure and composable in your retry and audit pipelines.
