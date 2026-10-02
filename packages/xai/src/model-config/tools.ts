/**
 * Structurally representable Zod schemas for xAI Live Search tools.
 *
 * Public config constraints are encoded as unions of exclusive shapes so
 * derived JSON Schema is exact (no `superRefine` / `check`).
 *
 * @module
 */

import { z } from 'zod'

const webSearchFlags = {
  enableImageUnderstanding: z.boolean().optional().meta({
    title: 'Enable Image Understanding',
    description: 'Ask xAI to analyze images found during web search.',
  }),
  enableImageSearch: z.boolean().optional().meta({
    title: 'Enable Image Search',
    description: 'Ask xAI to include image search results.',
  }),
}

export const XaiWebSearchToolSchema = z
  .union([
    z.strictObject({
      type: z.literal('web_search'),
      allowedDomains: z.array(z.string()).max(5),
      ...webSearchFlags,
    }),
    z.strictObject({
      type: z.literal('web_search'),
      excludedDomains: z.array(z.string()).max(5),
      ...webSearchFlags,
    }),
    z.strictObject({
      type: z.literal('web_search'),
      ...webSearchFlags,
    }),
  ])
  .meta({
    title: 'XaiWebSearchTool',
    description:
      'xAI web_search server tool. allowedDomains and excludedDomains are mutually exclusive (max 5).',
  })

const xSearchFlags = {
  fromDate: z.iso.date().optional().meta({
    title: 'From Date',
    description: 'Inclusive ISO-8601 date lower bound for X search.',
  }),
  toDate: z.iso.date().optional().meta({
    title: 'To Date',
    description: 'Inclusive ISO-8601 date upper bound for X search.',
  }),
  enableImageUnderstanding: z.boolean().optional().meta({
    title: 'Enable Image Understanding',
    description: 'Ask xAI to analyze images in matched posts.',
  }),
  enableVideoUnderstanding: z.boolean().optional().meta({
    title: 'Enable Video Understanding',
    description: 'Ask xAI to analyze videos in matched posts.',
  }),
}

export const XaiXSearchToolSchema = z
  .union([
    z.strictObject({
      type: z.literal('x_search'),
      allowedXHandles: z.array(z.string()).max(20),
      ...xSearchFlags,
    }),
    z.strictObject({
      type: z.literal('x_search'),
      excludedXHandles: z.array(z.string()).max(20),
      ...xSearchFlags,
    }),
    z.strictObject({
      type: z.literal('x_search'),
      ...xSearchFlags,
    }),
  ])
  .meta({
    title: 'XaiXSearchTool',
    description:
      'xAI x_search server tool. allowedXHandles and excludedXHandles are mutually exclusive (max 20).',
  })

/**
 * Admitted tools combinations: at most one web_search and at most one x_search.
 * Both orders are admitted so callers are not rejected for listing order.
 */
export const XaiToolsSchema = z
  .union([
    z.tuple([XaiWebSearchToolSchema]),
    z.tuple([XaiXSearchToolSchema]),
    z.tuple([XaiWebSearchToolSchema, XaiXSearchToolSchema]),
    z.tuple([XaiXSearchToolSchema, XaiWebSearchToolSchema]),
  ])
  .meta({
    title: 'XaiTools',
    description:
      'xAI Live Search tools. At most one web_search and at most one x_search.',
  })

const providerOptionFields = {
  promptCacheKey: z
    .string()
    .min(1)
    .optional()
    .meta({
      title: 'Prompt Cache Key',
      description:
        'xAI conversation-routing cache key — maps to Responses API ' +
        '`prompt_cache_key`.',
    }),
  parallelToolCalls: z.boolean().optional().meta({
    title: 'Parallel Tool Calls',
    description: 'xAI Responses parallel_tool_calls. Not a generic contract field.',
  }),
}

const toolsMeta = {
  title: 'Live Search Tools',
  description: 'xAI server-side web_search / x_search tools.',
}

/**
 * Two shapes: `toolChoice` and `maxTurns` are only admitted together with
 * `tools` (the tuple union is never empty), so the derived JSON Schema
 * carries the dependency without a refinement.
 */
export const XaiProviderOptionsSchema = z
  .union([
    z.strictObject({
      ...providerOptionFields,
      tools: XaiToolsSchema.meta(toolsMeta),
      toolChoice: z
        .enum(['auto', 'required', 'none'])
        .optional()
        .meta({
          title: 'Server Tool Choice',
          description:
            'xAI Responses `tool_choice` for the server-side search tools; `required` ' +
            'forces at least one search, `none` disables them. Cannot be combined ' +
            'with function tools or the request-level toolChoice.',
        }),
      maxTurns: z
        .number()
        .int()
        .min(1)
        .optional()
        .meta({
          title: 'Max Turns',
          description:
            'xAI Responses `max_turns`: cap on agentic tool-calling turns for the ' +
            'server-side search tools. A turn can run several searches. Not enforced ' +
            'by xAI as of 2026-10-02.',
        }),
    }),
    z.strictObject({
      ...providerOptionFields,
      tools: XaiToolsSchema.optional().meta(toolsMeta),
    }),
  ])
  .meta({
    title: 'xAI Provider Options',
    description: 'Allowlisted xAI provider options.',
  })
