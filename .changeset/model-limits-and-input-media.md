---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/xai': minor
'@gullabs/claude-cli': minor
'@gullabs/codex-cli': minor
'@gullabs/testing': minor
---

Descriptors state their token limits and the media types they accept (ADR-033, Amendment A).

`ModelDescriptor.limits: { contextWindow, maxOutputTokens }` is required on every descriptor, from the provider's documentation (read 2026-10-03; the source comment names the pages). `createModelRegistry` rejects missing limits, non-positive-integer limits and a `maxOutputTokens` above `contextWindow`. Every Gemini config schema caps `maxOutputTokens` at `limits.maxOutputTokens` (65,536); Gemma 4 and Grok document no output limit, so theirs is `null` and their schemas apply no cap (see the audit-fix changesets). `capabilities.inputMimeTypes` lists the exact IANA types a model takes in `inline-media` and `file-uri` parts, and core exports `assertInputMimeTypesAdmitted`, which the Google and xAI adapters call before dispatch (and Google in `countTokens`). xAI admits `image/jpeg` and `image/png` only; Gemini admits PDF and the text, image, audio and video families; Gemma 4 admits image and video; the CLI providers are text-only. `assertRegistryInvariants` in `@gullabs/testing` now checks limits and the schema cap.

What hosts must change:

- A custom `ModelDescriptor` must add `limits` (and `capabilities.inputMimeTypes` if the model takes media); registry construction throws without `limits`.
- A `maxOutputTokens` above a Gemini model's limit (65,536) is now `bad_request` at config validation.
- A part whose media type the model does not admit (WebP, GIF or `image/jpg` on xAI, `application/json` on Gemini) is `bad_request` before dispatch, naming `messages[i].parts[j]` and the admitted types.
