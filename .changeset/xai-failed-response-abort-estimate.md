---
'@gullabs/xai': minor
'@gullabs/core': minor
---

One policy for every way a started xAI run can end: a terminal `response.failed`, an engine deadline and a caller abort now behave like the other mid-stream failures.

A terminal `response.failed` that arrives after output events is no longer retried (it replayed a 20 minute reasoning run up to `maxAttempts` times), and a failed response is always an unpriced attempt when it carries no usage: `rate_limit_exceeded` and `invalid_prompt` were booked as known-free. A `response.failed` before any output keeps its code's retryability. `XaiResponseMeta` gains `streamProgressed`.

An engine `timeoutMs` deadline or a caller abort that stops a call after output began now keeps the usage estimate: the attempt is booked `'estimated'` instead of unpriced. In `@gullabs/core` the engine, after a timeout or abort wins the race over a dispatched adapter call, waits up to 64 microtask turns (no timer) for the adapter's own failure and adopts its `usage` and `servedServiceTier` onto the cancellation error, which stays the error. Any adapter that fails with usage when its signal aborts is now booked from that usage.

The failure estimate counts the whole wire input (the replayed `'state'` history, instructions, tools and output schema) instead of only the new messages; image data counts nothing. Its limits are stated in the README.

An absurd stream index (`content_index`, `summary_index`, `annotation_index`, `output_index` above 10,000) is a typed `server` error instead of a 91 s stall; the SSE reader is linear in the bytes read; a typed `error` event with a nested `error` object keeps its code and message; a 200 that is not an event stream carries up to 500 characters of the body, secrets redacted, in the error `cause`; the client's own timer reports "client deadline" and the timeout you configured, not the SDK's timer and not the value plus 5 s. `classifyXaiError` gains a fourth parameter, `requestTimeoutMs`.

What hosts must change: nothing for correct calls. A host that relied on `response.failed` after output being retried, or on an aborted call having no usage, must read `err.usage` and `callCost` instead.
