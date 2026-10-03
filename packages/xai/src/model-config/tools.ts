/**
 * Structurally representable Zod schemas for xAI Live Search tools.
 *
 * Public config constraints are encoded as unions of exclusive shapes so
 * derived JSON Schema is exact. The one exception is the cross-field rule that
 * `providerOptions.xai.searchBudget` needs the tools it counts: a `superRefine`
 * on the provider options, which JSON Schema cannot express.
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

const maxWebSearchCalls = z
  .number()
  .int()
  .min(1)
  .meta({
    title: 'Max Web Search Calls',
    description:
      "Ceiling on web_search calls. Requires a web_search tool. Compared with xAI's " +
      'reported counter after the call.',
  })

const maxXItems = z
  .number()
  .int()
  .min(1)
  .meta({
    title: 'Max X Items',
    description:
      'Ceiling on X posts plus users fetched. Requires an x_search tool. Compared ' +
      "with xAI's reported counters after the call.",
  })

/**
 * At least one ceiling, as a union of shapes so the derived JSON Schema says it
 * exactly: `{}` is not a budget.
 */
const XaiSearchBudgetSchema = z
  .union([
    z.strictObject({ maxWebSearchCalls, maxXItems: maxXItems.optional() }),
    z.strictObject({ maxWebSearchCalls: maxWebSearchCalls.optional(), maxXItems }),
  ])
  .meta({
    title: 'Search Budget',
    description:
      'Observed after the call, never sent to xAI (which has no per-call search ' +
      'ceiling). Over budget: a warning and usage.details.search_budget_exceeded = 1; ' +
      'the already-billed result is still returned. Needs at least one ceiling, and ' +
      'the tool each ceiling counts (maxWebSearchCalls: web_search, maxXItems: ' +
      'x_search) in tools.',
  })

/**
 * `toolChoice` and `maxTurns` need a non-empty `tools`; the adapter enforces
 * that dependency. Encoding it here as a union of shapes made zod report an
 * invalid `toolChoice` value as an unrecognized key.
 */
export const XaiProviderOptionsSchema = z
  .strictObject({
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
    tools: XaiToolsSchema.optional().meta({
      title: 'Live Search Tools',
      description: 'xAI server-side web_search / x_search tools.',
    }),
    parallelToolCalls: z.boolean().optional().meta({
      title: 'Parallel Tool Calls',
      description: 'xAI Responses parallel_tool_calls. Not a generic contract field.',
    }),
    toolChoice: z
      .enum(['auto', 'required', 'none'])
      .optional()
      .meta({
        title: 'Server Tool Choice',
        description:
          'xAI Responses `tool_choice` for the server-side search tools; `required` ' +
          'forces at least one search, `none` disables them. Requires `tools`. Cannot ' +
          'be combined with function tools, file attachments or the request-level ' +
          'toolChoice.',
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
          'server-side search tools. Requires `tools`. A turn can run several ' +
          'searches. Not enforced by xAI as of 2026-10-02.',
      }),
    searchBudget: XaiSearchBudgetSchema.optional(),
  })
  .superRefine((options, ctx) => {
    // `searchBudget` counts what the search tools did, so each ceiling needs its
    // tool. Stated here, not left to the adapter, so the schema accepts exactly
    // what the adapter does and a bad budget never reaches a ledger row.
    const budget = options.searchBudget
    if (budget === undefined) return
    const kinds = new Set((options.tools ?? []).map((tool) => tool.type))
    const need = (ceiling: 'maxWebSearchCalls' | 'maxXItems', tool: string): void => {
      if (
        budget[ceiling] !== undefined &&
        !kinds.has(tool as 'web_search' | 'x_search')
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['searchBudget', ceiling],
          message: `searchBudget.${ceiling} requires ${tool === 'x_search' ? 'an' : 'a'} ${tool} tool in tools.`,
        })
      }
    }
    need('maxWebSearchCalls', 'web_search')
    need('maxXItems', 'x_search')
  })
  .meta({
    title: 'xAI Provider Options',
    description: 'Allowlisted xAI provider options.',
  })
