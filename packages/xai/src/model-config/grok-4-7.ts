/**
 * Strict Zod config schema for xAI's `grok-4.7` model.
 *
 * Same Responses-API surface as grok-4.6: `reasoning.effort` of
 * `'low' | 'medium' | 'high' | 'xhigh'` and `serviceTier: 'priority'`.
 * Shaped from the grok-4.6 contract. The 2026-09-25 priority success and
 * effort-none rejection, and the encrypted-reasoning multi-turn replay captured
 * live on 2026-09-26, are fixture-backed. `'none'` stays rejected.
 * Unknown tiers (`flex`, `standard`, `batch`) are rejected.
 *
 * @module
 */

import { maxOutputTokensSchema } from '@gullabs/core'
import { z } from 'zod'

import { XAI_MODEL_LIMITS } from '../model-limits.js'
import { XAI_MAX_TIMEOUT_MS } from '../client.js'
import { XaiProviderOptionsSchema } from './tools.js'

export const Grok47ConfigSchema = z
  .strictObject({
    temperature: z.number().min(0).max(2).optional().meta({
      title: 'Temperature',
      description:
        'Sampling temperature forwarded verbatim to grok-4.7, from 0 to 2 (the range xAI documents for the Responses API: "between 0 and 2"); a value outside it is rejected.',
    }),
    topP: z.number().min(0).max(1).optional().meta({
      title: 'Top P',
      description:
        'Nucleus sampling probability forwarded verbatim to grok-4.7, from 0 to 1 (xAI documents no range for it; a probability mass outside 0 to 1 is meaningless); a value outside it is rejected.',
    }),
    maxOutputTokens: maxOutputTokensSchema(XAI_MODEL_LIMITS['grok-4.7'])
      .optional()
      .meta({
        title: 'Max Output Tokens',
        description:
          'Maximum output token cap for grok-4.7, including reasoning tokens. No ' +
          'ceiling is applied: xAI documents no output limit and has accepted very ' +
          "large values (live-verified). Truncation surfaces as finishReason:'length', " +
          'not an error.',
      }),
    reasoning: z
      .strictObject({
        effort: z.enum(['low', 'medium', 'high', 'xhigh']).meta({
          title: 'Reasoning Effort',
          description:
            'Reasoning effort for grok-4.7. "low", ' +
            '"medium", "high", and "xhigh" are accepted; "none" is rejected. ' +
            'Vendor default when omitted is "high".',
        }),
      })
      .optional()
      .meta({
        title: 'Reasoning',
        description:
          'grok-4.7 effort-level reasoning configuration. No budgetTokens field — ' +
          'xAI uses level-style reasoning, not token budgets.',
      }),
    serviceTier: z
      .literal('priority')
      .optional()
      .meta({
        title: 'Service Tier',
        description:
          'xAI priority processing for grok-4.7 (Responses `service_tier: ' +
          '"priority"`). Bills at 2× after the ' +
          'cache discount (uncached standard-list 2× ' +
          'cached/long-context legs follow the official 2× rule). ' +
          'Omitted requests stay on xAI default. ' +
          '"flex"/"standard"/"batch" are rejected.',
      }),
    timeoutMs: z.number().int().positive().max(XAI_MAX_TIMEOUT_MS).optional().meta({
      title: 'Timeout',
      description: 'Logical request timeout in milliseconds (at most 2147478647).',
    }),
    providerOptions: z
      .strictObject({
        xai: XaiProviderOptionsSchema.optional(),
      })
      .optional()
      .meta({
        title: 'Provider Options',
        description: 'Provider-specific options accepted for grok-4.7.',
      }),
  })
  .meta({
    title: 'Grok47Config',
    description:
      'Strict Responses API config for model grok-4.7. Level reasoning ' +
      '(low/medium/high/xhigh), optional priority service tier, tunable sampling, ' +
      'structured output, vision, priced.',
    examples: [{ reasoning: { effort: 'high' } }],
  })
