---
'@gullabs/xai': minor
---

xAI request id and remaining-quota headers are on `providerMetadata.xai` (ADR-039).

The built-in client reads the HTTP response through the OpenAI SDK's `.withResponse()` and reports `x-request-id` and the `x-ratelimit-remaining-*` / `ratelimit-remaining*` headers; the adapter puts them on `providerMetadata.xai` as `requestId` and `rateLimitRemaining` (verbatim values, lower-cased header names). `XaiRequestOptions` gains `onResponse(meta)` and `XaiResponseMeta` is exported; a custom `XaiClientLike` that implements `responses.create` may call it and one that does not simply yields no `xai` key. The header names are pinned against real captures (the `headers` stored in fixtures 02, 12 and 16-23); a failed call has no `providerMetadata`, and its request id is `error.cause.requestID` (the SDK error).

What hosts must change: a custom `XaiClientLike` that should report these calls `options.onResponse`. Nothing else.
