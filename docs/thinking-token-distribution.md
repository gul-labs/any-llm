# Gemini thinking-token distribution

How many thinking tokens Gemini models spend, per model and reasoning effort, measured on 2026-10-03.
It backs two decisions: the warning when a thinking budget is not below `maxOutputTokens`, and the
rejection of a library-level `answerTokens` allowance (see the verdict at the end).

## Method

- Six fixed prompts, two repeats each: arithmetic, a logic puzzle, code, a summary, planning, extraction.
  That is 12 calls per model and effort, 336 calls in all.
- `maxOutputTokens` was 32,000, so thinking was never cut off by the cap.
- Gemini 3.x models use `thinkingLevel` (`reasoning.effort`); Gemini 2.5 uses the adapter's
  effort-to-budget defaults (0, 1,024, 8,192 and 24,576 for `none`, `low`, `medium` and `high`).
- `gemini-2.5-flash-lite` is not in the table: the API returned 404 for the key used.
- Each cell has n = 12, so p95 is close to the maximum. Treat the numbers as an order of magnitude, not
  a guarantee: six prompt types are a small sample.

## Thinking tokens per call

Each cell is `p50 / p95 / max`. A dash means the effort is not admitted on that model.

| Model                  | `none`    | `low`               | `medium`              | `high`                |
| ---------------------- | --------- | ------------------- | --------------------- | --------------------- |
| gemini-3.1-flash-lite  | 0 / 0 / 0 | 141 / 169 / 169     | 628 / 2,263 / 2,816   | 1,288 / 5,897 / 7,762 |
| gemini-3.5-flash-lite  | 0 / 0 / 0 | 130 / 2,567 / 2,791 | 692 / 3,328 / 3,824   | 1,091 / 6,994 / 8,859 |
| gemini-3.6-flash       | 0 / 0 / 0 | 522 / 1,586 / 1,746 | 1,010 / 2,214 / 2,466 | 1,114 / 3,088 / 3,377 |
| gemini-3.7-flash       | -         | 342 / 1,179 / 1,293 | 637 / 1,481 / 1,490   | 936 / 3,645 / 3,728   |
| gemini-3.8-flash       | -         | 0 / 1,339 / 1,707   | 551 / 1,917 / 2,055   | 1,088 / 6,892 / 7,139 |
| gemini-3.1-pro-preview | -         | 618 / 1,452 / 1,592 | 1,102 / 2,648 / 3,113 | 1,297 / 4,401 / 4,930 |
| gemini-2.5-flash       | 0 / 0 / 0 | 809 / 965 / 1,020   | 1,580 / 3,611 / 3,686 | 1,548 / 4,831 / 5,767 |
| gemini-2.5-pro         | -         | 762 / 906 / 924     | 1,876 / 3,247 / 3,269 | 1,966 / 4,907 / 5,153 |

Calls that produced no thinking at all, out of 12:

| Model                 | Calls with zero thinking |
| --------------------- | ------------------------ |
| gemini-3.1-flash-lite | `none` 12                |
| gemini-3.5-flash-lite | `none` 12, `low` 6       |
| gemini-3.6-flash      | `none` 12                |
| gemini-3.7-flash      | `low` 4                  |
| gemini-3.8-flash      | `low` 8                  |
| gemini-2.5-flash      | `none` 12                |

`none` produced exactly 0 thinking tokens on every model that admits it.

## Share of calls whose thinking reached a threshold

Pooled over all models and prompts:

| Effort   | at 1,000 tokens | at 2,000 | at 4,000 | at 8,000 |
| -------- | --------------- | -------- | -------- | -------- |
| `low`    | 14%             | 2%       | -        | -        |
| `medium` | 44%             | 21%      | 0%       | -        |
| `high`   | 63%             | 24%      | 11%      | 1%       |

The largest value seen was 8,859 thinking tokens (`gemini-3.5-flash-lite`, `high`, the logic puzzle).
The Gemini 2.5 budgets (1,024, 8,192, 24,576) were never approached; the maximum was 5,767.

## What drives it

The prompt, far more than the model or the knob. At `high`, the logic puzzle has a p50 of 4,930
(max 8,859) while the summary and extraction prompts sit at 515 to 576.

## Verdict

- **p95 is not stable.** At `high` it is 2.5 to 6 times the p50 for most models, and the prompt, not the
  model or the effort, sets it. A per-model allowance for the answer (`GenConfig.answerTokens`) would be
  wrong for most prompts, so it is not offered. It is recorded as rejected in `BACKLOG.md`.
- **The warnings are the final state.** The library warns (never rejects) when a thinking budget is at or
  above `maxOutputTokens`, and when `finishReason` is `length` with no answer and thinking tokens were
  spent. Google says actual thinking can under- or overflow the budget, so neither is an invalid request.
- **Guidance for hosts.** A cap of 1,024 is used up by thinking in a majority of `high` calls here, and
  a cap under 4,096 is unsafe at `high`. The `high` default budget of 24,576 on Gemini 2.5 is a ceiling
  the calls measured here stayed far below.
