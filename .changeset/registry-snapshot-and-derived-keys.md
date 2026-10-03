---
'@gullabs/core': minor
'@gullabs/testing': minor
---

The registry trusts nothing a descriptor declares and answers from one snapshot (ADR-033, Amendment C).

`createModelRegistry` recomputes `toConfigKeys(configSchema)` and `toConfigJsonSchema(configSchema)` and rejects a descriptor whose declared `configKeys` or `configJsonSchema` differs, instead of comparing `configKeys` with the declared JSON Schema. `toConfigKeys` follows local `$ref`s into `$defs`, so a schema carrying `.meta({ id })` works, and a schema JSON Schema cannot represent (for example a transform) fails with `LlmError('bad_request')` and the original as `cause` instead of a plain `Error`. The registry validates `inputMimeTypes` entries (lower-case `type/subtype` or `type/*`, no duplicates) and freezes each descriptor's `limits`, `inputMimeTypes`, `aliases` and `configKeys`, so a table shared by several descriptors cannot be edited through one of them. `resolve`, `findByModel` and `listDescriptors` all answer from a copy of the descriptor list taken at construction; descriptors added to your array afterwards are not part of the registry.

What hosts must change:

- Build `configJsonSchema` with `toConfigJsonSchema(configSchema)`; a hand-written one that differs is rejected.
- Do not mutate a descriptor's `limits` or `inputMimeTypes` after registering it (it now throws in strict mode); build a new descriptor instead.
