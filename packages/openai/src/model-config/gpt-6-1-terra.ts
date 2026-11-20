/**
 * Strict Zod config schema for OpenAI's `gpt-6.1-terra` model.
 *
 * Documented, not live-verified (read 2026-11-20):
 *
 * - `reasoning.effort`: `none | low | medium | high | xhigh | max`, as the model
 *   page lists (https://developers.openai.com/api/docs/models/gpt-6.1-terra;
 *   documented default `medium`).
 * - Sampling: the model page says nothing about `temperature` or `top_p`, so the
 *   schema admits neither.
 * - `serviceTier`: `'flex' | 'fast'` (pricing page, Flex and Fast tables,
 *   https://developers.openai.com/api/docs/pricing). `ultrafast` has no row for
 *   this model and is not admitted.
 * - `maxOutputTokens`: at most 128,000 (model page), reasoning tokens included.
 *
 * @module
 */

import { maxOutputTokensSchema } from '@gullabs/core'
import { z } from 'zod'

import { OPENAI_MAX_TIMEOUT_MS } from '../client.js'
import { OPENAI_MODEL_LIMITS } from '../model-limits.js'

export const Gpt61TerraConfigSchema = z
  .strictObject({
    maxOutputTokens: maxOutputTokensSchema(OPENAI_MODEL_LIMITS['gpt-6.1-terra'])
      .optional()
      .meta({
        title: 'Max Output Tokens',
        description:
          'Responses `max_output_tokens` for gpt-6.1-terra: an integer from 1 to 128,000 (the documented maximum output), reasoning tokens included. A cut answer ends with finishReason "length".',
      }),
    reasoning: z
      .strictObject({
        effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']).meta({
          title: 'Reasoning Effort',
          description:
            'Responses `reasoning.effort` for gpt-6.1-terra: "none", "low", "medium", "high", "xhigh" or "max" (model page). The documented default when omitted is "medium".',
        }),
      })
      .optional()
      .meta({
        title: 'Reasoning',
        description:
          'gpt-6.1-terra effort-level reasoning. No budgetTokens and no thought summaries in this release.',
      }),
    serviceTier: z.enum(['flex', 'fast']).optional().meta({
      title: 'Service Tier',
      description:
        'Responses `service_tier`: "flex" (50% of the standard rates on every lane) or "fast" (2x). Omitted requests use the default tier.',
    }),
    timeoutMs: z.number().int().positive().max(OPENAI_MAX_TIMEOUT_MS).optional().meta({
      title: 'Timeout',
      description: 'Logical request timeout in milliseconds (at most 2147478647).',
    }),
  })
  .meta({
    title: 'Gpt61TerraConfig',
    description:
      'Strict Responses API config for model gpt-6.1-terra: reasoning effort none to max, optional Flex or Fast service tier, no sampling keys, output cap 128,000.',
    examples: [{ reasoning: { effort: 'medium' } }],
  })
