---
'@gullabs/core': minor
'@gullabs/google': minor
---

No silent empty answers when reasoning uses up the output cap.

When any provider returns `finishReason: 'length'` with no answer text, no structured output and no tool call, and the call spent reasoning tokens, the engine adds a warning to the result and the record: `maxOutputTokens (M) was used up by reasoning (T tokens); no answer was produced`. A Gemini HTTP 200 with no candidates but billed thought tokens now carries the same hint in its retryable `server` error. `GenConfig.maxOutputTokens` is documented as including reasoning tokens on providers that reason.

What hosts must change:

- Nothing is required. Raise `maxOutputTokens` or lower the reasoning effort when you see the warning; check `result.warnings` where an empty `text` was previously treated as a successful answer.
