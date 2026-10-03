---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/xai': minor
---

Standard JSON Schema everywhere, and a keyword a provider would ignore is `bad_request` (ADR-034).

`output.jsonSchema` and `tools[].inputJsonSchema` are standard JSON Schema (2020-12 subset). Google and xAI accept every keyword and silently ignore the ones they do not enforce, so each adapter now declares the keywords it enforces and rejects the rest with `bad_request`, naming the JSON path (`output.jsonSchema.properties.kind`, `tools[1].inputJsonSchema...`), before dispatch. Nothing is rewritten. Annotations (`$schema`, `$id`, `$comment`, `title`, `description`, `examples`, `default`, `deprecated`, `readOnly`, `writeOnly`) are accepted everywhere.

`@gullabs/core` exports `assertStandardJsonSchema` (moved from `@gullabs/xai`, where it was internal), `assertJsonSchemaProfile` and `JsonSchemaProfile` (what adapters call), and `PORTABLE_JSON_SCHEMA_KEYWORDS`, `PORTABLE_JSON_SCHEMA_FORMATS` and `assertPortableJsonSchema`: the subset both providers enforce, for a build-time lint of every call site.

`@gullabs/google` sends `responseJsonSchema` and `functionDeclarations[].parametersJsonSchema`, always, verbatim and in your key order. The OpenAPI-dialect `responseSchema` and `parameters` fields are gone. Live probe on every Gemini and Gemma model (2026-10-03): `$ref` / `$defs` (recursive too), `anyOf`, `prefixItems`, `items: false` and `additionalProperties` are enforced; `const`, `allOf`, `exclusiveMinimum`, `multipleOf` and `uniqueItems` are ignored and `oneOf` is read as `anyOf`, so those are rejected. `pattern`, `minLength` and `maxLength` are accepted but only probabilistically obeyed. Gemma additionally rejects `format`, `minLength` and `maxLength`, which it ignored. The two schema errors the SDK throws locally are `bad_request`.

`@gullabs/xai` runs the same assertion on tool schemas as on output schemas, and now rejects the keywords xAI documents as not enforced: `oneOf`, `allOf`, `not`, `if`/`then`/`else`, `multipleOf`, `uniqueItems`, `propertyNames`, a recursive `$ref`, an unlisted `format`, `items: false`, a pattern outside xAI's regex subset, and `minLength`/`maxLength`, `minItems`/`maxItems`, `minProperties`/`maxProperties` above xAI's limits.

What hosts must change:

- Replace `z.literal('x')` (emits `const`) with `z.enum(['x'])`; replace `z.discriminatedUnion` (emits `oneOf`) with `z.union` (emits `anyOf`); drop `z.record` (emits `propertyNames`), `multipleOf`, `uniqueItems`, `exclusiveMinimum` and `allOf`, or validate those constraints in your own code. On Google a `format` other than `date-time`, `date`, `time` or `email` is rejected; on xAI a recursive schema is.
- Add `assertPortableJsonSchema(z.toJSONSchema(schema), 'call-site-name')` to a test over every call site that must run on both providers.
- Validate `output` yourself. `pattern`, `minLength` and `maxLength` on Gemini are soft; the library never validates the result.
