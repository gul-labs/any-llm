import { z } from 'zod'

import type { ModelLimits } from '../registry.js'

/**
 * The `maxOutputTokens` field of a per-model config schema: a positive integer,
 * capped at `limits.maxOutputTokens` only when the provider documents one. A
 * `null` limit (no documented output limit) applies no cap, so a value the
 * provider accepts is never refused here. The schema and the descriptor read
 * the same {@link ModelLimits}, so they cannot disagree.
 */
export function maxOutputTokensSchema(limits: ModelLimits): z.ZodNumber {
  const base = z.number().int().positive()
  return limits.maxOutputTokens === null ? base : base.max(limits.maxOutputTokens)
}
