import { z } from 'zod'

export const Gemini25FlashLiteConfigSchema = z
  .union([
    z.strictObject({
      temperature: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .meta({
          title: 'Temperature',
          description: 'Sampling temperature for gemini-2.5-flash-lite.',
          examples: [0.7],
        }),
      topP: z.number().min(0).max(1).optional().meta({
        title: 'Top P',
        description: 'Nucleus sampling probability for gemini-2.5-flash-lite.',
      }),
      topK: z.number().int().positive().optional().meta({
        title: 'Top K',
        description: 'Top-k sampling limit for gemini-2.5-flash-lite.',
      }),
      maxOutputTokens: z.number().int().positive().optional().meta({
        title: 'Max Output Tokens',
        description: 'Maximum output token cap for gemini-2.5-flash-lite.',
      }),
      stopSequences: z.array(z.string()).max(5).optional().meta({
        title: 'Stop Sequences',
        description: 'Up to five stop sequences for gemini-2.5-flash-lite.',
      }),
      serviceTier: z.literal('flex').meta({
        title: 'Service Tier',
        description: 'Explicit flex tier for gemini-2.5-flash-lite.',
      }),
      reasoning: z
        .union([
          z.strictObject({
            effort: z.enum(['none', 'low', 'medium', 'high']).meta({
              title: 'Reasoning Effort',
              description: 'Reasoning effort for gemini-2.5-flash-lite.',
            }),
            includeThoughts: z.boolean().optional().meta({
              title: 'Include Thoughts',
              description: 'Return provider thought summaries when supported.',
            }),
          }),
          z.strictObject({
            budgetTokens: z
              .union([z.literal(0), z.number().int().min(512).max(24576)])
              .meta({
                title: 'Reasoning Budget Tokens',
                description:
                  'thinkingBudget token range for gemini-2.5-flash-lite. Zero disables thinking; non-zero values must be 512..24576.',
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
          description: 'Gemini 2.5 Flash-Lite thinkingBudget configuration.',
        }),
      timeoutMs: z.number().int().positive().optional().meta({
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
                    category: z.string().min(1).meta({
                      title: 'Safety Category',
                      description: 'Google safety category identifier.',
                    }),
                    threshold: z.string().min(1).meta({
                      title: 'Safety Threshold',
                      description: 'Google safety threshold identifier.',
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
                  description: 'Allowlisted Google tools for gemini-2.5-flash-lite.',
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
              description:
                'Allowlisted Google provider options for gemini-2.5-flash-lite.',
            }),
        })
        .optional()
        .meta({
          title: 'Provider Options',
          description: 'Provider-specific options accepted for gemini-2.5-flash-lite.',
        }),
    }),
    z.strictObject({
      temperature: z
        .number()
        .min(0)
        .max(2)
        .optional()
        .meta({
          title: 'Temperature',
          description: 'Sampling temperature for gemini-2.5-flash-lite.',
          examples: [0.7],
        }),
      topP: z.number().min(0).max(1).optional().meta({
        title: 'Top P',
        description: 'Nucleus sampling probability for gemini-2.5-flash-lite.',
      }),
      topK: z.number().int().positive().optional().meta({
        title: 'Top K',
        description: 'Top-k sampling limit for gemini-2.5-flash-lite.',
      }),
      maxOutputTokens: z.number().int().positive().optional().meta({
        title: 'Max Output Tokens',
        description: 'Maximum output token cap for gemini-2.5-flash-lite.',
      }),
      stopSequences: z.array(z.string()).max(5).optional().meta({
        title: 'Stop Sequences',
        description: 'Up to five stop sequences for gemini-2.5-flash-lite.',
      }),
      serviceTier: z.literal('standard').optional().meta({
        title: 'Service Tier',
        description: 'Standard tier or omitted tier for gemini-2.5-flash-lite.',
      }),
      reasoning: z
        .union([
          z.strictObject({
            effort: z.enum(['none', 'low', 'medium', 'high']).meta({
              title: 'Reasoning Effort',
              description: 'Reasoning effort for gemini-2.5-flash-lite.',
            }),
            includeThoughts: z.boolean().optional().meta({
              title: 'Include Thoughts',
              description: 'Return provider thought summaries when supported.',
            }),
          }),
          z.strictObject({
            budgetTokens: z
              .union([z.literal(0), z.number().int().min(512).max(24576)])
              .meta({
                title: 'Reasoning Budget Tokens',
                description:
                  'thinkingBudget token range for gemini-2.5-flash-lite. Zero disables thinking; non-zero values must be 512..24576.',
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
          description: 'Gemini 2.5 Flash-Lite thinkingBudget configuration.',
        }),
      timeoutMs: z.number().int().positive().optional().meta({
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
                    category: z.string().min(1).meta({
                      title: 'Safety Category',
                      description: 'Google safety category identifier.',
                    }),
                    threshold: z.string().min(1).meta({
                      title: 'Safety Threshold',
                      description: 'Google safety threshold identifier.',
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
                  description: 'Allowlisted Google tools for gemini-2.5-flash-lite.',
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
              description:
                'Allowlisted Google provider options for gemini-2.5-flash-lite.',
            }),
        })
        .optional()
        .meta({
          title: 'Provider Options',
          description: 'Provider-specific options accepted for gemini-2.5-flash-lite.',
        }),
    }),
  ])
  .meta({
    title: 'Gemini25FlashLiteConfig',
    description:
      'Strict generateContent config for model gemini-2.5-flash-lite. Budget reasoning, tunable sampling, flex/standard tiers, structured output, grounding, priced.',
    examples: [{ serviceTier: 'flex', temperature: 0.7, reasoning: { budgetTokens: 0 } }],
  })
