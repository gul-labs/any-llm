---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/xai': minor
---

The JSON Schema check (ADR-034) fails closed on malformed schemas, and the portable subset says exactly what it covers.

Malformed schemas are `bad_request` with the offending path, before dispatch: a value in a schema position that is not a schema (`properties: { a: 'string' }`, `items: 'string'`, `anyOf: ['x']`), a keyword value of the wrong type (`maxLength: '3000'`, a negative or fractional count, a non-numeric `minimum`, a `required` that is not a list of names, a non-string `format`), a `pattern` that is not a valid regular expression, a `$ref` that points at data rather than a schema (`#/properties`, `#/enum/0`), a cyclic JavaScript object (what a dereferencing tool produces for a recursive schema; use `$ref` / `$defs`) and nesting deeper than 128 levels. These used to be accepted, or escaped as an `unknown` stack-overflow error. A circular `$ref` error now names the `$ref` that closes the cycle, a cyclic `$defs` entry nothing points at is rejected where recursion is unsupported, and a `$ref` that only leads to other `$ref`s is rejected everywhere. Paths bracket-quote names that contain `.`, `[`, `]`, `"` or `\` (`properties["a.b"]`).

`pattern` is held to the regex subset on xAI and in the portable check, including inside a character class: `[\p{L}]` is rejected like `\p{L}`. Google holds `pattern` to the same subset now, because no capture shows Google enforcing lookaround, word boundaries, backreferences or property escapes.

`z.record(z.string(), X)` works on both providers. It emits `propertyNames: { type: 'string' }`, which constrains nothing; exactly that form is accepted and sent verbatim. Any other `propertyNames` (`z.record(z.enum([...]), X)`, `z.record(z.string().regex(...), X)`) is still rejected.

`@gullabs/google`: `format: 'time'` is rejected (named in Google's guide, never exercised by a capture). The Gemma profile follows the resolved model descriptor, so a declared alias of a Gemma model gets it. The unreachable reclassification of two `@google/genai` schema-conversion errors is removed (the adapter never reaches that code).

`@gullabs/core`: `PORTABLE_JSON_SCHEMA_KEYWORDS` and `PORTABLE_JSON_SCHEMA_FORMATS` are frozen, and the portable subset is defined as the intersection of the **Gemini 3.x and xAI** profiles, not "every provider": Gemma 4 additionally rejects `format`, `minLength` and `maxLength`, `pattern` / `minLength` / `maxLength` are only probabilistically obeyed on Gemini, and `claude-cli` / `codex-cli` do not run these checks. `time` is no longer a portable `format` value. If you use Zod's `startsWith`, `endsWith` or `includes`, chain `.meta({ format: undefined })` (or write `z.string().regex(...)`) so the non-standard `format` is dropped and the `pattern` stays.

What hosts must change: remove `format: 'time'` on Google, fix any schema the new checks reject (the error names the path), and re-run your `assertPortableJsonSchema` lint; `z.record(z.string(), X)` no longer needs to be dropped.
