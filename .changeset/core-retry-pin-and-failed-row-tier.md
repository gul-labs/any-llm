---
'@gullabs/core': minor
---

A retry never gives a request that named no service tier one, and a failed attempt's row keeps the tier it asked for.

`retryMiddleware` pinned a retry to the tier a failed attempt was served at even when the request named none, so an untiered Google call whose first attempt was billed was retried with an explicit `serviceTier: 'standard'`, which arms a 300-second client-side ceiling and a transport timeout the first attempt never had. A retry is now pinned only when the request carried a tier (a flex call the provider moved to standard retries at standard). The error row an attempt writes now carries `serviceTier` (the tier it asked for) beside `servedServiceTier` (the tier the error says it was served at); a failed flex attempt used to have a null `service_tier`. The `tools` with structured output rejection no longer says "in this iteration".

What hosts must change: nothing, unless you relied on an untiered retry running under the served tier; set `serviceTier` on the request to get the pin.
