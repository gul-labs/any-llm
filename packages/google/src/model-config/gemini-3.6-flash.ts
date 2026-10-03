import { z } from 'zod'

import { GOOGLE_MAX_TIMEOUT_MS } from '../client.js'
import { GOOGLE_MODEL_LIMITS } from '../model-limits.js'
import { GOOGLE_SAFETY_CATEGORIES, GOOGLE_SAFETY_THRESHOLDS } from '../safety-settings.js'

export const Gemini36FlashConfigSchema = z
  .union([
    z.strictObject({
      maxOutputTokens: z
        .number()
        .int()
        .positive()
        .max(GOOGLE_MODEL_LIMITS['gemini-3.6-flash'].maxOutputTokens)
        .optional()
        .meta({
          title: 'Max Output Tokens',
          description: 'Maximum output token cap for gemini-3.6-flash.',
        }),
      stopSequences: z.array(z.string()).max(5).optional().meta({
        title: 'Stop Sequences',
        description: 'Up to five stop sequences for gemini-3.6-flash.',
      }),
      serviceTier: z.literal('flex').meta({
        title: 'Service Tier',
        description: 'Explicit flex tier for gemini-3.6-flash.',
      }),
      reasoning: z
        .union([
          z.strictObject({
            effort: z.enum(['none', 'low', 'medium', 'high']).meta({
              title: 'Reasoning Effort',
              description:
                'Reasoning effort for gemini-3.6-flash; none maps to minimal thinking.',
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
          description: 'Gemini 3.6 Flash thinkingLevel configuration.',
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
                  'Fail the call unless the response proves Google Search ran (grounding metadata with at least one query).',
              }),
              cachedContent: z.string().min(1).optional().meta({
                title: 'Cached Content',
                description: 'Google cached content resource name.',
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
                  description: 'Allowlisted Google tools for gemini-3.6-flash.',
                }),
              httpOptions: z
                .strictObject({
                  timeout: z.number().int().positive().optional().meta({
                    title: 'HTTP Timeout',
                    description: 'Per-request Google transport timeout in milliseconds.',
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
              description: 'Allowlisted Google provider options for gemini-3.6-flash.',
            }),
        })
        .optional()
        .meta({
          title: 'Provider Options',
          description: 'Provider-specific options accepted for gemini-3.6-flash.',
        }),
    }),
    z.strictObject({
      maxOutputTokens: z
        .number()
        .int()
        .positive()
        .max(GOOGLE_MODEL_LIMITS['gemini-3.6-flash'].maxOutputTokens)
        .optional()
        .meta({
          title: 'Max Output Tokens',
          description: 'Maximum output token cap for gemini-3.6-flash.',
        }),
      stopSequences: z.array(z.string()).max(5).optional().meta({
        title: 'Stop Sequences',
        description: 'Up to five stop sequences for gemini-3.6-flash.',
      }),
      serviceTier: z.literal('standard').optional().meta({
        title: 'Service Tier',
        description: 'Standard tier or omitted tier for gemini-3.6-flash.',
      }),
      reasoning: z
        .union([
          z.strictObject({
            effort: z.enum(['none', 'low', 'medium', 'high']).meta({
              title: 'Reasoning Effort',
              description:
                'Reasoning effort for gemini-3.6-flash; none maps to minimal thinking.',
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
          description: 'Gemini 3.6 Flash thinkingLevel configuration.',
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
                  'Fail the call unless the response proves Google Search ran (grounding metadata with at least one query).',
              }),
              cachedContent: z.string().min(1).optional().meta({
                title: 'Cached Content',
                description: 'Google cached content resource name.',
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
                  description: 'Allowlisted Google tools for gemini-3.6-flash.',
                }),
              httpOptions: z
                .strictObject({
                  timeout: z.number().int().positive().optional().meta({
                    title: 'HTTP Timeout',
                    description: 'Per-request Google transport timeout in milliseconds.',
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
              description: 'Allowlisted Google provider options for gemini-3.6-flash.',
            }),
        })
        .optional()
        .meta({
          title: 'Provider Options',
          description: 'Provider-specific options accepted for gemini-3.6-flash.',
        }),
    }),
  ])
  .meta({
    title: 'Gemini36FlashConfig',
    description:
      'Strict generateContent config for model gemini-3.6-flash. Level reasoning, fixed sampling, flex/standard tiers, structured output, grounding, priced.',
    examples: [{ serviceTier: 'flex', reasoning: { effort: 'medium' } }],
  })
