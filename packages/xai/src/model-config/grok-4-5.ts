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
    temperature: z.number().min(0).max(1).optional().meta({
      title: 'Temperature',
      description:
        'Sampling temperature forwarded verbatim to grok-4.5, from 0 to 1 inclusive. xAI accepts up to 2 but samples a temperature above 1 as 1 while echoing the value sent (Responses API reference, read 2026-11-20: "Sampling uses at most `temperature` 1"), so a higher value would be silently clamped; the schema does not admit it and a value outside 0 to 1 is rejected.',
    }),
    topP: z.number().min(0).max(0.95).optional().meta({
      title: 'Top P',
      description:
        'Nucleus sampling probability forwarded verbatim to grok-4.5, from 0 to 0.95 inclusive. xAI accepts up to 1 but samples a `top_p` above the model default, 0.95 for Grok models, as 0.95 while echoing the value sent (Responses API reference, read 2026-11-20), so a higher value would be silently clamped; the schema does not admit it and a value outside 0 to 0.95 is rejected.',
    }),
    maxOutputTokens: maxOutputTokensSchema(XAI_MODEL_LIMITS['grok-4.5'])
      .optional()
      .meta({
        title: 'Max Output Tokens',
        description:
          'Maximum output token cap for grok-4.5. xAI documents that it "only applies to ' +
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
