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
import type { ModelDescriptor, ModelRegistry } from '@gullabs/core'
import {
  createModelRegistry,
  toConfigJsonSchema,
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

/** Deleted ids. Resolve returns undefined; there is no alias. */
export const DELETED_CLAUDE_CLI_MODEL_IDS = ['claude-fable-5', 'claude-opus-4-8'] as const

/**
 * Reasoning effort levels admitted by the `claude` CLI's `--effort` flag.
 *
 * A strict superset of `@gullabs/core`'s `ReasoningEffort` union (which is
 * `'none' | 'low' | 'medium' | 'high' | 'xhigh'`) — `'max'` is the extra
 * value the CLI supports that core's engine-level type does not know about.
 * Because of this mismatch, `admittedReasoningEfforts` (typed
 * `ReadonlyArray<ReasoningEffort>` in `ModelDescriptor.capabilities`) is
 * intentionally OMITTED below rather than cast — this package's own zod
 * schema is the sole validator for `reasoning.effort`, so the field is
 * advisory-only and safe to skip.
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

export const claudeCliModelDescriptors: ModelDescriptor[] = CLAUDE_CLI_MODEL_IDS.map(
  (id): ModelDescriptor => {
    const configSchema = CONFIG_SCHEMAS[id]
    return {
      model: id,
      provider: 'claude-cli',
      capabilities: {
        structuredOutput: true,
        nativeStructuredOutput: true,
        reasoningApi: 'level',
        sampling: 'fixed',
        vision: false,
      },
      configSchema,
      configJsonSchema: toConfigJsonSchema(configSchema),
      validateConfig: zodToStandardSchema(configSchema),
    }
  },
)

export const claudeCliRegistry: ModelRegistry = createModelRegistry(
  claudeCliModelDescriptors,
)
