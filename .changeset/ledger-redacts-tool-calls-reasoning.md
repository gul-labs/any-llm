---
'@gullabs/core': minor
---

`redactSecrets` runs in linear time and covers more credentials, and the `llm_calls` record now redacts the model's tool-call arguments and reasoning text.

- **Linear time.** The `X-Goog-` pattern was quadratic: a prompt or reply of `X-Goog-` repeated stalled the event loop for seconds. Every pattern is now written so that no input backtracks; `redact.test.ts` holds a timing test (280 KB of `X-Goog-`, 1 MB of `A`, long runs of every trigger prefix, all under 200 ms).
- **Wider coverage** (best-effort, credentials only), in any case: S3/AWS presigned `X-Amz-*` parameters (`Signature`, `Credential`, `Security-Token`), Azure SAS `sig=`, `X-Goog-*`, `Bearer` tokens, the credential after any `Authorization:` scheme (`Basic`, ...), `password=` / `secret=` / `refresh_token=` / `id_token=` / `client_secret=` pairs, and the key prefixes `sk-`, `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` / `github_pat_`, `xai-`, `AIza`, `ya29.`, `AKIA`.
- **The ledger row.** `buildRecord` now runs core's patterns over `reasoning_text` and every string in the `tool_calls` arguments, and replaces the value of an argument key named like `password`, `secret`, `token`, `api_key`, `authorization`, `credential` or `private_key` (any case, as a substring) with `[REDACTED]`. It strips U+0000 before redacting `error_message`, `reasoning_text`, tool arguments and `providerOptions`, so a secret split by a NUL is redacted whole. A `__proto__` key in `metadata`, tool arguments or provider metadata stays data.

What hosts must know: nothing to change in code. `llm_calls.tool_calls` and `reasoning_text` may now contain `[REDACTED]` and `…REDACTED` where they held credentials. `metadata`, `citations` and provider-reported JSON are still not scanned, and `ClientConfig.payloads` / `storePayload` never governed the ledger row's text columns; the README table lists what each table holds. A host that must keep that text out of the ledger wraps its sink and drops those columns.
