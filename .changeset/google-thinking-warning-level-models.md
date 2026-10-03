---
'@gullabs/google': minor
---

Warn when a Gemini 3.x call at `high` effort has a small output cap.

Level models have no thinking budget to compare with `maxOutputTokens`, so the rule comes from the measured distribution: with `reasoning.effort: 'high'` and `maxOutputTokens` below 4,096 the result carries a warning that thinking may consume the whole cap (thinking reached 4,000 tokens in 7 of 72 `high` calls on the 3.x models, up to 8,859). There is no rule for `low` or `medium` (no 3.x call reached 4,000 tokens there) or for an omitted `reasoning`. It is a warning, never a rejection. `docs/thinking-token-distribution.md` corrects its claim about 2.5 budgets: the `low` budget is effectively reached (1,020 of 1,024), only `medium` and `high` were never approached.

What hosts must change:

- Nothing is required. Raise `maxOutputTokens` when you see the warning.
