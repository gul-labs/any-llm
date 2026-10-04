/**
 * Strict Zod config schema for xAI's `grok-4.5` model.
 *
 * Mirrors `@gullabs/core`'s `packages/core/src/model-config/*.ts` doc-density
 * style, but is a single self-contained `z.strictObject` — unlike Gemini's
 * schemas, xai has no service-tier branching (no `z.union` of tier variants
 * needed), no `topK`, and a reasoning-effort union of `'low'|'medium'|'high'`
 * (live-verified 2026-08-24).
 *
 * @module
 */

import { maxOutputTokensSchema } from '@gullabs/core'
import { z } from 'zod'

import { XAI_MODEL_LIMITS } from '../model-limits.js'
import { XAI_MAX_TIMEOUT_MS } from '../client.js'
import { XaiProviderOptionsSchema } from './tools.js'

export const Grok45ConfigSchema = z
  .strictObject({
    temperature: z.number().min(0).max(2).optional().meta({
      title: 'Temperature',
      description:
        'Sampling temperature forwarded verbatim to grok-4.5, from 0 to 2 (the range xAI documents for the Responses API: "between 0 and 2"); a value outside it is rejected.',
    }),
    topP: z.number().min(0).max(1).optional().meta({
      title: 'Top P',
      description:
        'Nucleus sampling probability forwarded verbatim to grok-4.5, from 0 to 1 (xAI documents no range for it; a probability mass outside 0 to 1 is meaningless); a value outside it is rejected.',
    }),
    maxOutputTokens: maxOutputTokensSchema(XAI_MODEL_LIMITS['grok-4.5'])
      .optional()
      .meta({
        title: 'Max Output Tokens',
        description:
          'Maximum output token cap for grok-4.5, including reasoning tokens. No ' +
          'ceiling is applied: xAI documents no output limit and has accepted very ' +
          "large values (live-verified). Truncation surfaces as finishReason:'length', " +
          'not an error.',
      }),
    reasoning: z
      .strictObject({
        effort: z.enum(['low', 'medium', 'high']).meta({
          title: 'Reasoning Effort',
          description:
            'Reasoning effort for grok-4.5. "low", "medium", and "high" are ' +
            'admitted (live-verified 2026-08-24). "xhigh" is rejected here even ' +
            'though /v1/language-models lists it: the reasoning guide says it is ' +
            'treated as high, and an echo does not prove a distinct level. ' +
            '"none" is rejected. Vendor default when omitted is "high".',
        }),
      })
      .optional()
      .meta({
        title: 'Reasoning',
        description:
          'grok-4.5 effort-level reasoning configuration. No budgetTokens field — ' +
          'xAI uses level-style reasoning, not token budgets.',
      }),
    serviceTier: z.literal('priority').optional().meta({
      title: 'Service Tier',
      description:
        'xAI priority processing for grok-4.5, billed at 2× on input, cached input, and output tokens. Live-verified 2026-09-25.',
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
        description: 'Provider-specific options accepted for grok-4.5.',
      }),
  })
  .meta({
    title: 'Grok45Config',
    description:
      'Strict Responses API config for model grok-4.5. Level reasoning ' +
      '(low/medium/high), optional priority service tier, tunable sampling, ' +
      'structured output, vision, Live Search tools, priced.',
    examples: [{ reasoning: { effort: 'high' } }],
  })
