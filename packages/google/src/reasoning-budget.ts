import type { ReasoningEffort } from '@gullabs/core'

export const GOOGLE_REASONING_EFFORT_BUDGET: Record<
  Exclude<ReasoningEffort, 'xhigh' | 'max'>,
  number
> = {
  none: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
}

/**
 * The `maxOutputTokens` below which a `high`-effort call on a level-reasoning
 * (Gemini 3.x) model draws a warning. The models have no thinking budget to
 * compare with the cap, so the figure comes from the measurement in
 * `docs/thinking-token-distribution.md` (2026-10-03, 3.x models at `high`:
 * thinking reached 4,000 tokens in 7 of 72 calls, about 10%, with a maximum
 * of 8,859): under 4,096 the cap can be used up before an answer appears. Lower
 * efforts have no such rule: at `medium` no call reached 4,000, and a rule
 * for them would rest on prompt-dependent tails the sample cannot pin.
 */
export const GOOGLE_HIGH_EFFORT_MIN_OUTPUT_TOKENS = 4096
