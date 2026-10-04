---
'@gullabs/xai': minor
---

`countTokens` and `XaiFileStore` keep the response headers, have a deadline, and encode file ids.

A failed `countTokens` or Files API call used to drop the response headers: a 429's `Retry-After` never reached `retryAfterMs` and `x-request-id` was lost. Both are kept now (`retryAfterMs` on the error, the request id in its message).

`countTokens` is bounded by `countTokensTimeoutMs` (adapter option, default 60 000 ms, exported default `XAI_COUNT_TOKENS_TIMEOUT_MS`) and every `XaiFileStore` call by `timeoutMs` (store option, default 60 000 ms, `XAI_FILES_DEFAULT_TIMEOUT_MS`; headers and body both count). Past it the call fails with a retryable `timeout` error; a caller `AbortSignal` is still an `aborted` error. Raise `timeoutMs` for a large upload on a slow link. Both options are integers from 1 to the same maximum as `timeoutMs`; anything else is `bad_request`.

`XaiFileStore.get`, `delete` and `getContent` encode the file id as one URL path segment (`a/b?c` can no longer address another path) and reject the ids `.` and `..` with `bad_request`. A 2xx body that is not JSON (`get`, `list`, `countTokens`) is a typed `server` error instead of a bare `SyntaxError`.

What hosts must change: nothing for correct calls; a store that uploads very large files over a slow link should set `timeoutMs`.
