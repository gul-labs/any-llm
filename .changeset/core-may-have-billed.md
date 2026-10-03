---
'@gullabs/core': minor
---

`LlmError` gains `mayHaveBilled`, and the engine no longer books such an attempt as known-free.

An adapter sets `mayHaveBilled: true` on an error that arrived after the provider had started work (an `error` event inside an open stream, say). `callCost.unpricedAttempts` then counts the attempt even when its kind is `rate_limited`, `bad_request` or `invalid_auth`, which are otherwise known to cost nothing because the provider refuses the request up front (an HTTP 429 or 400 is still not counted). `callCost.microUsd` is therefore a lower bound for such a call.

What hosts must change: nothing, unless you wrote an adapter. Set `mayHaveBilled: true` on an error that can follow billed work; leave it unset for an up-front refusal.
