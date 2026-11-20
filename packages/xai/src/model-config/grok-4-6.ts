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

import { maxOutputTokensSchema } from '@gullabs/core'
import { z } from 'zod'

import { XAI_MODEL_LIMITS } from '../model-limits.js'
import { XAI_MAX_TIMEOUT_MS } from '../client.js'
import { XaiProviderOptionsSchema } from './tools.js'

export const Grok46ConfigSchema = z
  .strictObject({
    temperature: z.number().min(0).max(1).optional().meta({
      title: 'Temperature',
      description:
        'Sampling temperature forwarded verbatim to grok-4.6, from 0 to 1 inclusive. xAI accepts up to 2 but samples a temperature above 1 as 1 while echoing the value sent (Responses API reference, read 2026-11-20: "Sampling uses at most `temperature` 1"), so a higher value would be silently clamped; the schema does not admit it and a value outside 0 to 1 is rejected.',
    }),
    topP: z.number().min(0).max(0.95).optional().meta({
      title: 'Top P',
      description:
        'Nucleus sampling probability forwarded verbatim to grok-4.6, from 0 to 0.95 inclusive. xAI accepts up to 1 but samples a `top_p` above the model default, 0.95 for Grok models, as 0.95 while echoing the value sent (Responses API reference, read 2026-11-20), so a higher value would be silently clamped; the schema does not admit it and a value outside 0 to 0.95 is rejected.',
    }),
    maxOutputTokens: maxOutputTokensSchema(XAI_MODEL_LIMITS['grok-4.6'])
      .optional()
      .meta({
        title: 'Max Output Tokens',
        description:
          'Maximum output token cap for grok-4.6. xAI documents that it "only applies to ' +
          'visible output tokens (i.e. does not apply to tokens used for reasoning or ' +
          'function calls)" (Responses API reference, read 2026-11-20). In the live ' +
          'grok-4.5 capture (fixture 08) a cap of 16 returned status "incomplete" with ' +
          'reason "max_output_tokens", 51 output tokens, 35 of them reasoning. No ' +
          'ceiling is applied: xAI documents no output limit and has accepted very ' +
          "large values (live-verified). Truncation surfaces as finishReason:'length', " +
          'not an error.',
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
