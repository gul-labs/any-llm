---
'@gullabs/google': minor
---

Warn when a Gemini 2.5 thinking budget is not below `maxOutputTokens`.

When a budget model's `thinkingBudget` (from `reasoning.effort` or `reasoning.budgetTokens`) is at or above `maxOutputTokens`, the result carries a warning that thinking may consume the whole cap. It is a warning, not a rejection: Google says actual thinking can under- or overflow the budget. The README documents the effort-to-budget defaults (`low` 1,024, `medium` 8,192, `high` 24,576) and `docs/thinking-token-distribution.md` publishes the measured thinking-token p50, p95 and max per model and effort. A library-level `answerTokens` allowance is rejected by that measurement (p95 is 2.5 to 6 times the p50 and prompt-driven); the existing warnings are the final state.

What hosts must change:

- Nothing is required. Size `maxOutputTokens` for the answer plus thinking: under 4,096 is unsafe at `high`.
