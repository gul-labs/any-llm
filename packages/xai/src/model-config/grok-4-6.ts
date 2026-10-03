/**
 * Strict Zod config schema for xAI's `grok-4.6` model.
 *
 * Same Responses-API surface as grok-4.5, plus live-verified (2026-08-12)
 * `reasoning.effort` of `'low' | 'medium' | 'high' | 'xhigh'` and
 * `serviceTier: 'priority'`. `'none'` is rejected by the live API. Unknown
 * tiers (`flex`, `standard`, `batch`) are rejected — `flex` is silently
 * remapped to `default` by xAI, so this schema never admits it.
 *
 * @module
 */

import { z } from 'zod'

import { XAI_MAX_TIMEOUT_MS } from '../client.js'
import { XaiProviderOptionsSchema } from './tools.js'

export const Grok46ConfigSchema = z
  .strictObject({
    temperature: z.number().optional().meta({
      title: 'Temperature',
      description: 'Sampling temperature forwarded verbatim to grok-4.6.',
    }),
    topP: z.number().optional().meta({
      title: 'Top P',
      description: 'Nucleus sampling parameter forwarded verbatim to grok-4.6.',
    }),
    maxOutputTokens: z
      .number()
      .int()
      .positive()
      .optional()
      .meta({
        title: 'Max Output Tokens',
        description:
          'Maximum output token cap for grok-4.6. No artificial ceiling — xAI ' +
          'accepts arbitrarily large values; truncation surfaces as ' +
          "finishReason:'length', not an error.",
      }),
    reasoning: z
      .strictObject({
        effort: z.enum(['low', 'medium', 'high', 'xhigh']).meta({
          title: 'Reasoning Effort',
          description:
            'Reasoning effort for grok-4.6. Live-verified 2026-08-12: "low", ' +
            '"medium", "high", and "xhigh" are accepted; "none" is rejected. ' +
            'Vendor default when omitted is "high".',
        }),
      })
      .optional()
      .meta({
        title: 'Reasoning',
        description:
          'grok-4.6 effort-level reasoning configuration. No budgetTokens field — ' +
          'xAI uses level-style reasoning, not token budgets.',
      }),
    serviceTier: z
      .literal('priority')
      .optional()
      .meta({
        title: 'Service Tier',
        description:
          'xAI priority processing for grok-4.6 (Responses `service_tier: ' +
          '"priority"`). Echo live-verified 2026-08-12. Bills at 2× after the ' +
          'cache discount (uncached standard-list 2× confirmed by live ticks; ' +
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
        description: 'Provider-specific options accepted for grok-4.6.',
      }),
  })
  .meta({
    title: 'Grok46Config',
    description:
      'Strict Responses API config for model grok-4.6. Level reasoning ' +
      '(low/medium/high/xhigh), optional priority service tier, tunable sampling, ' +
      'structured output, vision, priced.',
    examples: [{ reasoning: { effort: 'high' } }],
  })
