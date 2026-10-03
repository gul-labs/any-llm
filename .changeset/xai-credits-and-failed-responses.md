---
'@gullabs/xai': minor
---

xAI credit exhaustion, failed responses and `parallelToolCalls` without tools are classified.

- HTTP 429 or 403 with the body `Your team <id> has either used all available credits or reached its monthly spending limit...` is `rate_limited`, `retryable: false`, `reason: 'credits_exhausted'` (it was a retryable 429 or an `invalid_auth` 403). This body is doc-derived, not captured: xAI documents the status codes but no body, and the sentence comes from public reports of the live API (ADR-036).
- A 200 whose response has `status: 'failed'` or `'cancelled'`, or an `error` object, throws a retryable `server` error with the response's usage attached, instead of a result with `finishReason: 'other'`. `incomplete_details.reason: 'content_filter'` is not mapped (no capture shows it).
- `providerOptions.xai.parallelToolCalls` with no function tools and no `providerOptions.xai.tools` is `bad_request` before dispatch.
- The local transport regex is gone; transport failures come from core's shared matcher.

What hosts must change: alert on `reason: 'credits_exhausted'` instead of rotating keys or retrying; stop sending `parallelToolCalls` on requests without tools.
