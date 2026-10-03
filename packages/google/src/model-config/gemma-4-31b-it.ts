import { z } from 'zod'

export const Gemma431bItConfigSchema = z
  .strictObject({
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .meta({
        title: 'Temperature',
        description: 'Sampling temperature for gemma-4-31b-it.',
        examples: [0.7],
      }),
    topP: z.number().min(0).max(1).optional().meta({
      title: 'Top P',
      description: 'Nucleus sampling probability for gemma-4-31b-it.',
    }),
    topK: z.number().int().positive().optional().meta({
      title: 'Top K',
      description: 'Top-k sampling limit for gemma-4-31b-it.',
    }),
    maxOutputTokens: z.number().int().positive().optional().meta({
      title: 'Max Output Tokens',
      description: 'Maximum output token cap for gemma-4-31b-it.',
    }),
    stopSequences: z.array(z.string()).max(5).optional().meta({
      title: 'Stop Sequences',
      description: 'Up to five stop sequences for gemma-4-31b-it.',
    }),
    reasoning: z
      .union([
        z.strictObject({
          effort: z.enum(['none', 'high']).meta({
            title: 'Reasoning Effort',
            description: 'Reasoning effort for gemma-4-31b-it.',
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
        description: 'Gemma 4 31B IT thinkingLevel configuration.',
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
                description: 'Allowlisted Google tools for gemma-4-31b-it.',
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
            description: 'Allowlisted Google provider options for gemma-4-31b-it.',
          }),
      })
      .optional()
      .meta({
        title: 'Provider Options',
        description: 'Provider-specific options accepted for gemma-4-31b-it.',
      }),
  })
  .meta({
    title: 'Gemma431bItConfig',
    description:
      'Strict generateContent config for model gemma-4-31b-it. Level reasoning, tunable sampling, no service tier, structured output, grounding, intentionally unpriced.',
    examples: [{ temperature: 0.7, reasoning: { effort: 'high' } }],
  })
