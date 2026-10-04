/**
 * Model config schemas + registry for @gullabs/claude-cli.
 *
 * DEVIATION FROM CONVENTION: `@gullabs/core`'s `packages/core/src/model-config/`
 * only carries config schemas for production API providers (Gemini/Gemma).
 * This dev-only CLI provider intentionally keeps its own model config schemas
 * and registry local to this package instead — core stays free of any
 * knowledge of the local-CLI dev workflow.
 *
 * @module
 */

import { z } from 'zod'
import type { ModelDescriptor, ModelLimits, ModelRegistry } from '@gullabs/core'
import {
  createModelRegistry,
  toConfigJsonSchema,
  toConfigKeys,
  zodToStandardSchema,
} from '@gullabs/core'

// ---------------------------------------------------------------------------
// Model ids
// ---------------------------------------------------------------------------

/** Every model id `@gullabs/claude-cli` knows how to route. */
export type ClaudeCliModelId =
  'claude-fable-5-1' | 'claude-opus-5-5' | 'claude-sonnet-5' | 'claude-haiku-4-5-20251001'

export const CLAUDE_CLI_MODEL_IDS: readonly ClaudeCliModelId[] = [
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
]

/**
 * Reasoning effort levels admitted by the `claude` CLI's `--effort` flag.
 *
 * The CLI admits `low` through `max` on Fable, Opus, and Sonnet. Haiku drops
 * `--effort`, so its descriptor advertises an empty admitted set.
 */
export const CLAUDE_CLI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Build the strict per-model config schema for a `claude-cli` model that
 * admits `--effort`.
 *
 * No `temperature`/`topP`/`topK`/`maxOutputTokens`/`stopSequences` fields —
 * the CLI does not support tuning any of these, and `z.strictObject` rejects
 * any unknown key outright (reject, don't map/clamp).
 */
function buildEffortConfigSchema(modelName: string): z.ZodType {
  return z
    .strictObject({
      reasoning: z
        .strictObject({
          effort: z.enum(CLAUDE_CLI_EFFORTS).meta({
            title: 'Reasoning Effort',
            description: `Reasoning effort forwarded to the claude CLI's --effort flag for ${modelName}.`,
          }),
        })
        .optional()
        .meta({
          title: 'Reasoning',
          description: `Reasoning configuration for ${modelName}.`,
        }),
      timeoutMs: z.number().int().positive().max(1_800_000).optional().meta({
        title: 'Timeout',
        description:
          'Logical request timeout in milliseconds; forwarded to the CLI runner.',
      }),
    })
    .meta({
      title: `${modelName}Config`,
      description: `Strict claude-cli config for model ${modelName}. Text-only, no sampling knobs, effort-based reasoning.`,
    })
}

/**
 * Haiku 4.5 silently drops `--effort`. Accepting a reasoning key would be a
 * silent map, so the schema has no reasoning field.
 */
function buildHaikuConfigSchema(): z.ZodType {
  return z
    .strictObject({
      timeoutMs: z.number().int().positive().max(1_800_000).optional().meta({
        title: 'Timeout',
        description:
          'Logical request timeout in milliseconds; forwarded to the CLI runner.',
      }),
    })
    .meta({
      title: 'claude-haiku-4-5-20251001Config',
      description:
        'Strict claude-cli config for claude-haiku-4-5-20251001. No reasoning key: the CLI drops --effort.',
    })
}

export const ClaudeFable51ConfigSchema = buildEffortConfigSchema('claude-fable-5-1')
export const ClaudeOpus55ConfigSchema = buildEffortConfigSchema('claude-opus-5-5')
export const ClaudeSonnet5ConfigSchema = buildEffortConfigSchema('claude-sonnet-5')
export const ClaudeHaiku45ConfigSchema = buildHaikuConfigSchema()

const CONFIG_SCHEMAS: Record<ClaudeCliModelId, z.ZodType> = {
  'claude-fable-5-1': ClaudeFable51ConfigSchema,
  'claude-opus-5-5': ClaudeOpus55ConfigSchema,
  'claude-sonnet-5': ClaudeSonnet5ConfigSchema,
  'claude-haiku-4-5-20251001': ClaudeHaiku45ConfigSchema,
}

// ---------------------------------------------------------------------------
// Descriptors + registry
// ---------------------------------------------------------------------------

/**
 * Context window and maximum output per model, as the CLI itself reports them in
 * the captured `modelUsage` of every registered id
 * (`__fixtures__/model-refresh-p-a1.json`, Claude Code 2.1.282). The CLI exposes no
 * output-size knob, so the limit a call runs under is the CLI's, not the API's:
 * Fable 5.1 reports 64 000 and Haiku 4.5 reports 32 000, below the API maxima in
 * the Anthropic models overview (`https://platform.claude.com/docs/en/about-claude/models/overview`,
 * read 2026-10-03: Fable 5.1 "128K tokens", Haiku 4.5 "64K tokens"). Opus 5.5 and
 * Sonnet 5 report 128 000, equal to the documented value. The context windows
 * agree with the documentation.
 */
const CLAUDE_CLI_LIMITS: Record<ClaudeCliModelId, ModelLimits> = {
  'claude-fable-5-1': { contextWindow: 1_000_000, maxOutputTokens: 64_000 },
  'claude-opus-5-5': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  'claude-sonnet-5': { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
  'claude-haiku-4-5-20251001': { contextWindow: 200_000, maxOutputTokens: 32_000 },
}

export const claudeCliModelDescriptors: ModelDescriptor[] = CLAUDE_CLI_MODEL_IDS.map(
  (id): ModelDescriptor => {
    const configSchema = CONFIG_SCHEMAS[id]
    return {
      model: id,
      provider: 'claude-cli',
      limits: CLAUDE_CLI_LIMITS[id],
      capabilities: {
        // The CLI runs text-only: the adapter rejects every non-text part.
        inputMimeTypes: [],
        structuredOutput: true,
        nativeStructuredOutput: true,
        ...(id !== 'claude-haiku-4-5-20251001' ? { reasoningApi: 'level' as const } : {}),
        admittedReasoningEfforts:
          id === 'claude-haiku-4-5-20251001' ? [] : CLAUDE_CLI_EFFORTS,
        sampling: 'fixed',
      },
      configSchema,
      configKeys: toConfigKeys(configSchema),
      configJsonSchema: toConfigJsonSchema(configSchema),
      validateConfig: zodToStandardSchema(configSchema),
    }
  },
)

export const claudeCliRegistry: ModelRegistry = createModelRegistry(
  claudeCliModelDescriptors,
)
