---
'@gullabs/xai': minor
---

xAI request id and remaining-quota headers are on `providerMetadata.xai` (ADR-039).

The built-in client reads the HTTP response through the OpenAI SDK's `.withResponse()` and reports `x-request-id` and the `x-ratelimit-remaining-*` / `ratelimit-remaining*` headers; the adapter puts them on `providerMetadata.xai` as `requestId` and `rateLimitRemaining` (verbatim values, lower-cased header names). `XaiRequestOptions` gains `onResponse(meta)` and `XaiResponseMeta` is exported; a custom `XaiClientLike` that implements `responses.create` may call it and one that does not simply yields no `xai` key. Headers of a failed call are not captured.

What hosts must change: a custom `XaiClientLike` that should report these calls `options.onResponse`. Nothing else.
