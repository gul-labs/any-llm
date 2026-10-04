import { maxOutputTokensSchema } from '@gullabs/core'
import { z } from 'zod'

import { GOOGLE_MAX_TIMEOUT_MS, MAX_TIMER_MS } from '../client.js'
import { cachedContentSchema } from './cached-content.js'
import { GOOGLE_MODEL_LIMITS } from '../model-limits.js'
import { GOOGLE_SAFETY_CATEGORIES, GOOGLE_SAFETY_THRESHOLDS } from '../safety-settings.js'

export const Gemini31FlashLiteConfigSchema = z
  .union([
    z.strictObject({
      maxOutputTokens: maxOutputTokensSchema(GOOGLE_MODEL_LIMITS['gemini-3.1-flash-lite'])
        .optional()
        .meta({
          title: 'Max Output Tokens',
          description: 'Maximum output token cap for gemini-3.1-flash-lite.',
        }),
      stopSequences: z.array(z.string()).max(5).optional().meta({
        title: 'Stop Sequences',
        description: 'Up to five stop sequences for gemini-3.1-flash-lite.',
      }),
      serviceTier: z.literal('flex').meta({
        title: 'Service Tier',
        description: 'Explicit flex tier for gemini-3.1-flash-lite.',
      }),
      reasoning: z
        .union([
          z.strictObject({
            effort: z.enum(['none', 'low', 'medium', 'high']).meta({
              title: 'Reasoning Effort',
              description:
                'Reasoning effort for gemini-3.1-flash-lite; none maps to minimal thinking.',
            }),
            includeThoughts: z.boolean().optional().meta({
              title: 'Include Thoughts',
              description: 'Return provider thought summaries when supported.',
            }),
          }),
          z.strictObject({
            includeThoughts: z.boolean().meta({
              title: 'Include Thoughts',
              description: 'Return provider thought summaries when supported.',
            }),
          }),
        ])
        .optional()
        .meta({
          title: 'Reasoning',
          description: 'Gemini 3.1 Flash-Lite thinkingLevel configuration.',
        }),
      timeoutMs: z.number().int().positive().max(GOOGLE_MAX_TIMEOUT_MS).optional().meta({
        title: 'Timeout',
        description: 'Logical request timeout in milliseconds.',
      }),
      providerOptions: z
        .strictObject({
          google: z
            .strictObject({
              allowSchemaWithSearch: z.boolean().optional().meta({
                title: 'Allow Schema With Search',
                description:
                  'Admit googleSearch together with a response schema. Turns requireGrounding on unless it is false.',
              }),
              requireGrounding: z.boolean().optional().meta({
                title: 'Require Grounding',
                description:
                  'Fail the call unless the response proves Google Search ran (grounding metadata with at least one query). Judged only on a candidate that finished with STOP: a MAX_TOKENS or other abnormal finish returns with its own finish reason, a filtered one throws content_filter. The error is retryable only when no response schema is attached.',
              }),
              cachedContent: cachedContentSchema,
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
                  description: 'Allowlisted Google tools for gemini-3.1-flash-lite.',
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
              description:
                'Allowlisted Google provider options for gemini-3.1-flash-lite.',
            }),
        })
        .optional()
        .meta({
          title: 'Provider Options',
          description: 'Provider-specific options accepted for gemini-3.1-flash-lite.',
        }),
    }),
    z.strictObject({
      maxOutputTokens: maxOutputTokensSchema(GOOGLE_MODEL_LIMITS['gemini-3.1-flash-lite'])
        .optional()
        .meta({
          title: 'Max Output Tokens',
          description: 'Maximum output token cap for gemini-3.1-flash-lite.',
        }),
      stopSequences: z.array(z.string()).max(5).optional().meta({
        title: 'Stop Sequences',
        description: 'Up to five stop sequences for gemini-3.1-flash-lite.',
      }),
      serviceTier: z.literal('standard').optional().meta({
        title: 'Service Tier',
        description: 'Standard tier or omitted tier for gemini-3.1-flash-lite.',
      }),
      reasoning: z
        .union([
          z.strictObject({
            effort: z.enum(['none', 'low', 'medium', 'high']).meta({
              title: 'Reasoning Effort',
              description:
                'Reasoning effort for gemini-3.1-flash-lite; none maps to minimal thinking.',
            }),
            includeThoughts: z.boolean().optional().meta({
              title: 'Include Thoughts',
              description: 'Return provider thought summaries when supported.',
            }),
          }),
          z.strictObject({
            includeThoughts: z.boolean().meta({
              title: 'Include Thoughts',
              description: 'Return provider thought summaries when supported.',
            }),
          }),
        ])
        .optional()
        .meta({
          title: 'Reasoning',
          description: 'Gemini 3.1 Flash-Lite thinkingLevel configuration.',
        }),
      timeoutMs: z.number().int().positive().max(GOOGLE_MAX_TIMEOUT_MS).optional().meta({
        title: 'Timeout',
        description: 'Logical request timeout in milliseconds.',
      }),
      providerOptions: z
        .strictObject({
          google: z
            .strictObject({
              allowSchemaWithSearch: z.boolean().optional().meta({
                title: 'Allow Schema With Search',
                description:
                  'Admit googleSearch together with a response schema. Turns requireGrounding on unless it is false.',
              }),
              requireGrounding: z.boolean().optional().meta({
                title: 'Require Grounding',
                description:
                  'Fail the call unless the response proves Google Search ran (grounding metadata with at least one query). Judged only on a candidate that finished with STOP: a MAX_TOKENS or other abnormal finish returns with its own finish reason, a filtered one throws content_filter. The error is retryable only when no response schema is attached.',
              }),
              cachedContent: cachedContentSchema,
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
                  description: 'Allowlisted Google tools for gemini-3.1-flash-lite.',
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
              description:
                'Allowlisted Google provider options for gemini-3.1-flash-lite.',
            }),
        })
        .optional()
        .meta({
          title: 'Provider Options',
          description: 'Provider-specific options accepted for gemini-3.1-flash-lite.',
        }),
    }),
  ])
  .meta({
    title: 'Gemini31FlashLiteConfig',
    description:
      'Strict generateContent config for model gemini-3.1-flash-lite. Level reasoning, fixed sampling, flex/standard tiers, structured output, grounding, priced.',
    examples: [{ serviceTier: 'flex', reasoning: { effort: 'medium' } }],
  })
