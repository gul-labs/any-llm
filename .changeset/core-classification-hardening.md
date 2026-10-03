---
'@gullabs/core': minor
'@gullabs/xai': minor
---

Error classification reads more shapes, parses rate-limit headers by their meaning, and matches transport failures only by known codes and whole messages.

- `parseRetryAfter` no longer takes the longest `x-ratelimit-reset*` value. Those headers say when every limit resets, not which one refused the call (an OpenAI 429 can carry `x-ratelimit-reset-tokens: 1s` beside `x-ratelimit-reset-requests: 6m0s`). When a window's `-remaining` header is 0 the delay is the longest reset among the exhausted windows; when none is identifiable it is the shortest reset of all, the earliest moment a retry can succeed. A distant window that was never hit no longer turns a 1 s wait into a stop. It also reads `ratelimit-reset`, treats a reset above 1e12 as epoch milliseconds, reads every element of an array value and comma-joined duplicates (the longest `retry-after` wins), accepts `.5`, and returns the 24 h cap for a number too large for a double.
- `classifyHttpStatus` forwards `retryAfterMs` for every retryable status (`408`, `429`, `5xx`), so a `503` with `Retry-After` is honoured by retry.
- `classifyError` reads a numeric-string status (`'429'`, as gaxios sets), `statusCode`, a status that exists only on the `cause` chain, and `Retry-After` from `response.headers`.
- Transport matching is tighter. A message counts only when the whole message is `fetch failed`, `connection error`, `socket hang up` or a Node syscall failure such as `connect ECONNREFUSED 127.0.0.1:443`, so "Invalid schema: no connection error handler" is `unknown` again. The `UND_ERR_*` codes are an allow-list (connect, headers and body timeouts, socket, content-length mismatch); undici programming errors (`UND_ERR_INVALID_ARG`, `UND_ERR_NOT_SUPPORTED`, a closed or destroyed client) are no longer retried. `ENOTFOUND`, `ENETUNREACH` and `EHOSTUNREACH` are transport errors, as they already were behind `fetch failed`.
- New export `causeChain(value)`: the value followed by its `cause` chain, bounded to 8 nodes and cycle-safe. `@gullabs/xai` uses it instead of its own copy.

What hosts must change: nothing unless you matched on the old behaviour. A reset-header delay can now be shorter than before, and a message that only mentions a transport phrase is `unknown`.
