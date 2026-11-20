import { maxOutputTokensSchema } from '@gullabs/core'
import { z } from 'zod'

import { GOOGLE_MAX_TIMEOUT_MS, MAX_TIMER_MS } from '../client.js'
import { GOOGLE_MODEL_LIMITS } from '../model-limits.js'
import { GOOGLE_SAFETY_CATEGORIES, GOOGLE_SAFETY_THRESHOLDS } from '../safety-settings.js'

/**
 * Strict config for `gemini-4-argon`, from Google's documentation only (documented, not
 * live-verified): https://aistudio.google.com/docs/models/gemini-4-argon.md,
 * https://aistudio.google.com/docs/thinking.md and
 * https://aistudio.google.com/docs/whats-new-gemini-4-carbon.md, read 2026-11-20.
 *
 * - Thinking levels low, medium, high; default medium, sent explicitly when no effort is
 *   set. No `none` (Google rejects `minimal`) and no `budgetTokens`.
 * - No sampling keys (ADR-017; Google ignores them on Gemini 4).
 * - No `cachedContent`: explicit caching is not supported on Gemini 4.
 * - No `allowSchemaWithSearch`: nothing shows Search running beside a response schema on
 *   Gemini 4, so the pair is rejected.
 * - Search only at the standard or omitted tier: the flex branch has no `tools` and no
 *   `requireGrounding`.
 * - `maxOutputTokens` at most 32,768, the per-request cap on a non-streaming call.
 */
export const Gemini4ArgonConfigSchema = z
  .union([
    z.strictObject({
      maxOutputTokens: maxOutputTokensSchema(GOOGLE_MODEL_LIMITS['gemini-4-argon'])
        .optional()
        .meta({
          title: 'Max Output Tokens',
          description:
            'Maximum output token cap for gemini-4-argon, thinking included: at most 32,768, the per-request cap on a non-streaming call.',
        }),
      stopSequences: z.array(z.string()).max(5).optional().meta({
        title: 'Stop Sequences',
        description: 'Up to five stop sequences for gemini-4-argon.',
      }),
      serviceTier: z.literal('flex').meta({
        title: 'Service Tier',
        description: 'Explicit flex tier for gemini-4-argon.',
      }),
      reasoning: z
        .union([
          z.strictObject({
            effort: z.enum(['low', 'medium', 'high']).meta({
              title: 'Reasoning Effort',
              description:
                'Thinking level for gemini-4-argon: low, medium, high. none is not admitted (thinking cannot be turned off). xhigh is not admitted.',
            }),
            includeThoughts: z.boolean().optional().meta({
              title: 'Include Thoughts',
              description: 'Return provider thought summaries when supported.',
            }),
          }),
          z.strictObject({
            includeThoughts: z.boolean().meta({
              title: 'Include Thoughts',
              description:
                'Return provider thought summaries when supported. The documented default level, medium, is sent.',
            }),
          }),
        ])
        .optional()
        .meta({
          title: 'Reasoning',
          description:
            'Gemini 4 Argon thinkingLevel configuration. Without an effort the documented default level, medium, is sent explicitly (Google calls thinkingLevel required for Gemini 4). thinkingBudget is not admitted.',
        }),
      timeoutMs: z.number().int().positive().max(GOOGLE_MAX_TIMEOUT_MS).optional().meta({
        title: 'Timeout',
        description:
          'Logical request timeout in milliseconds. Without it a flex call gets a 25-minute default deadline.',
      }),
      providerOptions: z
        .strictObject({
          google: z
            .strictObject({
              safetySettings: z
                .array(
                  z.strictObject({
                    category: z.enum(GOOGLE_SAFETY_CATEGORIES).meta({
                      title: 'Safety Category',
                      description: 'Documented Google safety category.',
                    }),
                    threshold: z.enum(GOOGLE_SAFETY_THRESHOLDS).meta({
                      title: 'Safety Threshold',
                      description: 'Documented Google safety threshold.',
                    }),
                  }),
                )
                .optional()
                .meta({
                  title: 'Safety Settings',
                  description: 'Allowlisted Google safety settings.',
                }),
              httpOptions: z
                .strictObject({
                  timeout: z.number().int().positive().max(MAX_TIMER_MS).optional().meta({
                    title: 'HTTP Timeout',
                    description:
                      'Per-request Google transport timeout in milliseconds, at most 2147483647; with timeoutMs set, at least timeoutMs + 5000.',
                  }),
                })
                .optional()
                .meta({
                  title: 'HTTP Options',
                  description: 'Allowlisted Google transport options.',
                }),
              flexFallback: z.boolean().optional().meta({
                title: 'Flex Fallback',
                description:
                  'Allow provider fallback from flex when flex was explicitly selected.',
              }),
            })
            .optional()
            .meta({
              title: 'Google Provider Options',
              description: 'Allowlisted Google provider options for gemini-4-argon.',
            }),
        })
        .optional()
        .meta({
          title: 'Provider Options',
          description: 'Provider-specific options accepted for gemini-4-argon.',
        }),
    }),
    z.strictObject({
      maxOutputTokens: maxOutputTokensSchema(GOOGLE_MODEL_LIMITS['gemini-4-argon'])
        .optional()
        .meta({
          title: 'Max Output Tokens',
          description:
            'Maximum output token cap for gemini-4-argon, thinking included: at most 32,768, the per-request cap on a non-streaming call.',
        }),
      stopSequences: z.array(z.string()).max(5).optional().meta({
        title: 'Stop Sequences',
        description: 'Up to five stop sequences for gemini-4-argon.',
      }),
      serviceTier: z.literal('standard').optional().meta({
        title: 'Service Tier',
        description: 'Standard tier or omitted tier for gemini-4-argon.',
      }),
      reasoning: z
        .union([
          z.strictObject({
            effort: z.enum(['low', 'medium', 'high']).meta({
              title: 'Reasoning Effort',
              description:
                'Thinking level for gemini-4-argon: low, medium, high. none is not admitted (thinking cannot be turned off). xhigh is not admitted.',
            }),
            includeThoughts: z.boolean().optional().meta({
              title: 'Include Thoughts',
              description: 'Return provider thought summaries when supported.',
            }),
          }),
          z.strictObject({
            includeThoughts: z.boolean().meta({
              title: 'Include Thoughts',
              description:
                'Return provider thought summaries when supported. The documented default level, medium, is sent.',
            }),
          }),
        ])
        .optional()
        .meta({
          title: 'Reasoning',
          description:
            'Gemini 4 Argon thinkingLevel configuration. Without an effort the documented default level, medium, is sent explicitly (Google calls thinkingLevel required for Gemini 4). thinkingBudget is not admitted.',
        }),
      timeoutMs: z.number().int().positive().max(GOOGLE_MAX_TIMEOUT_MS).optional().meta({
        title: 'Timeout',
        description:
          'Logical request timeout in milliseconds. Without it the call gets a 20-minute default deadline (Google asks for at least 20 minutes per call).',
      }),
      providerOptions: z
        .strictObject({
          google: z
            .strictObject({
              requireGrounding: z.boolean().optional().meta({
                title: 'Require Grounding',
                description:
                  'Fail the call unless the response proves Google Search ran (grounding metadata with at least one query). Judged only on a candidate that finished with STOP: a MAX_TOKENS or other abnormal finish returns with its own finish reason, a filtered one throws content_filter. The error is retryable only when no response schema is attached.',
              }),
              safetySettings: z
                .array(
                  z.strictObject({
                    category: z.enum(GOOGLE_SAFETY_CATEGORIES).meta({
                      title: 'Safety Category',
                      description: 'Documented Google safety category.',
                    }),
                    threshold: z.enum(GOOGLE_SAFETY_THRESHOLDS).meta({
                      title: 'Safety Threshold',
                      description: 'Documented Google safety threshold.',
                    }),
                  }),
                )
                .optional()
                .meta({
                  title: 'Safety Settings',
                  description: 'Allowlisted Google safety settings.',
                }),
              tools: z
                .array(
                  z.strictObject({
                    googleSearch: z.strictObject({}).meta({
                      title: 'Google Search',
                      description: 'Google Search grounding tool.',
                    }),
                  }),
                )
                .min(1)
                .optional()
                .meta({
                  title: 'Tools',
                  description:
                    'Allowlisted Google tools for gemini-4-argon. Standard or omitted tier only: Search with flex is not admitted.',
                }),
              httpOptions: z
                .strictObject({
                  timeout: z.number().int().positive().max(MAX_TIMER_MS).optional().meta({
                    title: 'HTTP Timeout',
                    description:
                      'Per-request Google transport timeout in milliseconds, at most 2147483647; with timeoutMs set, at least timeoutMs + 5000.',
                  }),
                })
                .optional()
                .meta({
                  title: 'HTTP Options',
                  description: 'Allowlisted Google transport options.',
                }),
            })
            .optional()
            .meta({
              title: 'Google Provider Options',
              description: 'Allowlisted Google provider options for gemini-4-argon.',
            }),
        })
        .optional()
        .meta({
          title: 'Provider Options',
          description: 'Provider-specific options accepted for gemini-4-argon.',
        }),
    }),
  ])
  .meta({
    title: 'Gemini4ArgonConfig',
    description:
      'Strict generateContent config for model gemini-4-argon. Level reasoning (low, medium, high; default medium), fixed sampling, flex/standard tiers, structured output, grounding at the standard tier, no explicit caching, priced. Documented, not live-verified.',
    examples: [{ reasoning: { effort: 'medium' } }],
  })
