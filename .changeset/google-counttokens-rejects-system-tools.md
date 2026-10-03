---
'@gullabs/google': minor
---

`countTokens` on Google rejects `system` and `tools` before dispatch.

The Gemini Developer API's token count cannot carry a system instruction or tool declarations, so the adapter used to send a request that dropped them, or that the SDK refused, while reporting `accuracy: 'exact'`. A `TokenCountRequest` with `system` or a non-empty `tools` now fails with `bad_request` and an `issues` entry per field, with no SDK call. ADR-029 item 9, which said Google forwarded `tools`, is corrected.

What hosts must change:

- Call `countTokens` on Google with `messages` only. To budget a call that has a system prompt or tools, read `usage.inputTokens` from a real `generate()` result.
