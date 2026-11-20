/**
 * Strict Zod config schema for OpenAI's `gpt-6.2-astra` model.
 *
 * Documented, not live-verified (read 2026-11-20):
 *
 * - `reasoning.effort`: `'low' | 'medium'` only. The model page states "The API
 *   rejects requests that set reasoning effort to `none`", and the GPT-6.2 guide
 *   (https://developers.openai.com/api/docs/guides/latest-model) names only `low`
 *   ("Integrations currently using none or minimal should move to low") and
 *   `medium` ("Start with `medium` for a new integration"). `high`, `xhigh` and
 *   `max` are named for no 6.2 model and are rejected until a probe shows them.
 * - Sampling: "Responses: omit temperature, top_p, and top_logprobs" (same guide),
 *   so no sampling key exists.
 * - `serviceTier`: `'fast'` only. GPT-6.2 models "don't support Flex processing
 *   (`service_tier: flex`)" (same guide); Fast mode is documented at
 *   https://developers.openai.com/api/docs/guides/fast-mode. `ultrafast` is not
 *   admitted in this release.
 * - `maxOutputTokens`: at most 128,000 (model page), reasoning tokens included.
 *
 * @module
 */

import { maxOutputTokensSchema } from '@gullabs/core'
import { z } from 'zod'

import { OPENAI_MAX_TIMEOUT_MS } from '../client.js'
import { OPENAI_MODEL_LIMITS } from '../model-limits.js'

export const Gpt62AstraConfigSchema = z
  .strictObject({
    maxOutputTokens: maxOutputTokensSchema(OPENAI_MODEL_LIMITS['gpt-6.2-astra'])
      .optional()
      .meta({
        title: 'Max Output Tokens',
        description:
          'Responses `max_output_tokens` for gpt-6.2-astra: an integer from 1 to 128,000 (the documented maximum output), reasoning tokens included. A cut answer ends with finishReason "length".',
      }),
    reasoning: z
      .strictObject({
        effort: z.enum(['low', 'medium']).meta({
          title: 'Reasoning Effort',
          description:
            'Responses `reasoning.effort` for gpt-6.2-astra: "low" or "medium" (the only values OpenAI names for GPT-6.2; "none" is documented as rejected). Omit it to take the model default, which OpenAI does not state.',
        }),
      })
      .optional()
      .meta({
        title: 'Reasoning',
        description:
          'gpt-6.2-astra effort-level reasoning. No budgetTokens and no thought summaries in this release.',
      }),
    serviceTier: z.literal('fast').optional().meta({
      title: 'Service Tier',
      description:
        'Responses `service_tier: "fast"` (Fast mode, 2x the standard rates on every lane). Omitted requests use the default tier. gpt-6.2-astra does not support Flex.',
    }),
    timeoutMs: z.number().int().positive().max(OPENAI_MAX_TIMEOUT_MS).optional().meta({
      title: 'Timeout',
      description: 'Logical request timeout in milliseconds (at most 2147478647).',
    }),
  })
  .meta({
    title: 'Gpt62AstraConfig',
    description:
      'Strict Responses API config for model gpt-6.2-astra: reasoning effort low/medium, optional Fast service tier, no sampling keys, output cap 128,000.',
    examples: [{ reasoning: { effort: 'medium' } }],
  })
