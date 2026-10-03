---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/xai': minor
'@gullabs/claude-cli': minor
'@gullabs/codex-cli': minor
'@gullabs/testing': minor
---

Descriptors state their token limits and the media types they accept (ADR-033, Amendment A).

`ModelDescriptor.limits: { contextWindow, maxOutputTokens }` is required on every descriptor, from the provider's documentation (read 2026-10-03; the source comment names the pages). `createModelRegistry` rejects missing limits, non-positive-integer limits and a `maxOutputTokens` above `contextWindow`. Every Gemini, Gemma and Grok config schema now caps `maxOutputTokens` at `limits.maxOutputTokens`: 65,536 on Gemini, 262,144 on Gemma 4 and 500,000 on Grok (Gemma and xAI document no separate output limit, so it is the context window). `capabilities.inputMimeTypes` lists the exact IANA types a model takes in `inline-media` and `file-uri` parts, and core exports `assertInputMimeTypesAdmitted`, which the Google and xAI adapters call before dispatch (and Google in `countTokens`). xAI admits `image/jpeg` and `image/png` only; Gemini admits the image, audio, video, PDF and plain-text types its documentation lists; Gemma 4 admits PNG and JPEG; the CLI providers are text-only. `assertRegistryInvariants` in `@gullabs/testing` now checks limits and the schema cap.

What hosts must change:

- A custom `ModelDescriptor` must add `limits` (and `capabilities.inputMimeTypes` if the model takes media); registry construction throws without `limits`.
- A `maxOutputTokens` above a model's limit is now `bad_request` at config validation. For xAI that is above 500,000.
- Media types are matched exactly. A part with a type the provider does not document (WebP or GIF on xAI, `image/jpg`, an undocumented Gemini type such as `text/csv`) is `bad_request` before dispatch, naming `messages[i].parts[j]` and the admitted types.
