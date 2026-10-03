---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/xai': minor
'@gullabs/claude-cli': minor
'@gullabs/codex-cli': minor
'@gullabs/testing': minor
---

Honest output limits and normalised media-type admission (ADR-033, Amendment C).

`ModelLimits.maxOutputTokens` is now `number | null`. `null` means the provider documents no output limit for the model (xAI Grok 4.x and Gemma 4): no figure is invented and the config schema applies no cap, so the live-verified acceptance of large xAI values (1,000,000 and above) is restored. A number is still the schema's cap (Gemini: 65,536). Core exports `maxOutputTokensSchema(limits)` for the config field, and `assertRegistryInvariants` checks both cases.

Media-type admission ignores case and `; parameters` (`IMAGE/PNG`, `text/plain; charset=utf-8`) and still sends your string to the provider unchanged. An empty or missing media type is `bad_request` with its own message. An `inputMimeTypes` entry is a lower-case `type/subtype` or a family wildcard `type/*`. Gemini admits `application/pdf` plus the `text/*`, `image/*`, `audio/*` and `video/*` families (Google publishes no closed document list); Gemma 4 admits `image/*` and `video/*`; xAI admits `image/jpeg` and `image/png` only (`image/jpg` stays rejected: xAI's page lists file extensions, not that media type). `GoogleFileStore.upload` applies the same Gemini rule through the same function (`assertMediaTypeAdmitted`, also `isMediaTypeAdmitted`), so a file that uploads can be used and an unadmitted or empty type fails before any bytes are sent.

The `capabilities.vision` and `capabilities.audioInput` flags are deleted: `inputMimeTypes` is the one statement of multimodal support.

What hosts must change:

- A custom `ModelDescriptor` whose provider documents no output limit sets `limits.maxOutputTokens: null`; one that reads `maxOutputTokens` as a number must handle `null`.
- Remove `vision` and `audioInput` from custom descriptors; list `inputMimeTypes` (or `type/*` families) instead. Ask `isMediaTypeAdmitted(type, descriptor.capabilities?.inputMimeTypes ?? [])` whether a model takes a kind of media.
- Calls that sent an empty media type, or `GoogleFileStore.upload` with an empty or non-admitted type, now fail with `bad_request`.
