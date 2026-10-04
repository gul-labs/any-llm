/**
 * json-schema.ts — the JSON Schema keywords xAI enforces (ADR-034).
 *
 * The adapter sends `output.jsonSchema` as `text.format` (`strict: true`) and a
 * tool's `inputJsonSchema` as the function `parameters`; xAI applies the same
 * schema rules to both. xAI accepts keywords it does not enforce, so the
 * adapter declares the enforced set and rejects the rest (`bad_request`, with
 * the path) before dispatch.
 *
 * Source: xAI's structured-outputs guide, read 2026-10-03
 * (https://docs.x.ai/developers/model-capabilities/text/structured-outputs),
 * pinned in `__fixtures__/structured-output-schema-docs-2026-10-03.json`:
 * - Enforced: `string number integer boolean null enum const array object
 *   anyOf`, `$ref` / `$defs` (non-circular only), `additionalProperties`,
 *   `required`, `format` for date, time, date-time, email, uuid, ipv4, ipv6
 *   and uri, `minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`,
 *   `minLength`/`maxLength` up to 2,048, `minItems`/`maxItems` up to 256,
 *   `minProperties`/`maxProperties` up to 64, `pattern` (a regex subset).
 * - `oneOf` "behaves identically to `anyOf`": reinterpreted, so rejected.
 * - `allOf` is enforced for a single subschema only; the adapter rejects it
 *   outright rather than inspect the arity.
 * - Best-effort (accepted, not enforced): `not`, `if`/`then`/`else`, other
 *   `format` values, constraints above the limits. Rejected.
 * - `multipleOf`, `uniqueItems`, `propertyNames` and `patternProperties` are
 *   not documented as enforced. Rejected.
 * - xAI answers 400 to `items` as an array and to boolean property schemas.
 *   `items: false` (a closed tuple) is undocumented, so it is rejected.
 *
 * @module
 */

import type { JsonSchemaProfile } from '@gullabs/core'

export const XAI_JSON_SCHEMA_PROFILE: JsonSchemaProfile = {
  provider: 'xai',
  keywords: [
    'type',
    'properties',
    'required',
    'additionalProperties',
    'enum',
    'const',
    'anyOf',
    '$ref',
    '$defs',
    'items',
    'prefixItems',
    'minItems',
    'maxItems',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minLength',
    'maxLength',
    'minProperties',
    'maxProperties',
    'pattern',
    'format',
  ],
  formats: ['date', 'time', 'date-time', 'email', 'uuid', 'ipv4', 'ipv6', 'uri'],
  limits: {
    minLength: 2048,
    maxLength: 2048,
    minItems: 256,
    maxItems: 256,
    minProperties: 64,
    maxProperties: 64,
  },
  circularRefs: false,
  booleanItems: false,
  patternSubset: true,
}
