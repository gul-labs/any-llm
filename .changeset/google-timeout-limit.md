---
'@gullabs/google': minor
---

The gemini and gemma config schemas reject a `timeoutMs` above 2147478647 with `bad_request`.

The SDK deadline is `timeoutMs` plus a 5 s buffer, and Node fires a timer above 2^31 - 1 ms after 1 ms, so a larger `timeoutMs` armed a valid engine timer and an SDK timer that expired at once. `GOOGLE_MAX_TIMEOUT_MS` (2147478647) is exported. The grok schemas already had the same limit.

What hosts must change: keep `timeoutMs` at or below 2147478647.
