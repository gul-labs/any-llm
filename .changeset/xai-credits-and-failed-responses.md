---
'@gullabs/xai': minor
---

xAI credit exhaustion, failed responses and `parallelToolCalls` without tools are classified.

- HTTP 429 or 403 with the body `Your team <id> has either used all available credits or reached its monthly spending limit...` is `rate_limited`, `retryable: false`, `reason: 'credits_exhausted'` (it was a retryable 429 or an `invalid_auth` 403). This body is doc-derived, not captured: xAI documents the status codes but no body, and the sentence comes from public reports of the live API (ADR-036).
- A 200 whose response has `status: 'failed'` throws an error with the response's usage attached, classified by `error.code`, instead of a result with `finishReason: 'other'`: `server_error` is a retryable `server` error, `rate_limit_exceeded` a retryable `rate_limited`, `bio_policy`, `misalignment_policy_violation` and `image_content_policy_violation` are `content_filter`, `invalid_prompt` and the `invalid_image*` family are `bad_request`, and any other or missing code is `unknown`; only the first two are retried (a deterministic failure is refused and billed again). `status: 'cancelled'` is `unknown`, not retryable. An `error` object beside a completed response is ignored: the answer is kept. These shapes come from OpenAI's Responses object (xAI's reference names `error` without its codes) and were never captured. `incomplete_details.reason: 'content_filter'` is not mapped (no capture shows it).
- The credits-exhausted error message omits the team id (it stays on `cause`).
- `providerOptions.xai.parallelToolCalls` with no function tools and no `providerOptions.xai.tools` is `bad_request` before dispatch.
- The local transport regex is gone; transport failures come from core's shared matcher.

What hosts must change: alert on `reason: 'credits_exhausted'` instead of rotating keys or retrying; handle `bad_request` / `content_filter` from a failed 200 as caller or policy errors, not transient ones; stop sending `parallelToolCalls` on requests without tools.
