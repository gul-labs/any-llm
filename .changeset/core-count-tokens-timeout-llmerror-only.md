---
'@gullabs/core': minor
---

`countTokens` takes `timeoutMs` and honours abort; `generate`, `runStructured` and `countTokens` reject only with `LlmError`.

`Client.countTokens` now takes `CountTokensOptions` (`GenerateOptions` plus an optional `timeoutMs`, a finite number greater than 0 and at most 2147483647, no default). Caller abort and the timeout end the call with `aborted` / `timeout` even when the adapter ignores its signal; the signal handed to the adapter carries both.

All three client methods now reject only with `LlmError`. A host registry, a middleware or a bug that throws something else is classified (`unknown` unless the value says otherwise) with the original kept as `cause`. A caller abort keeps `AbortSignal.reason` as `cause`, including when a cooperative adapter throws that reason itself.

What hosts must change: code that branched on a non-`LlmError` rejection from these methods reads `error.cause` instead. Pass `timeoutMs` to `countTokens` where a bounded count matters.
