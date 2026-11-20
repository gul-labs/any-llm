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
  'claude-fable-5-2' | 'claude-opus-5-5' | 'claude-sonnet-5-5' | 'claude-haiku-5-5'

export const CLAUDE_CLI_MODEL_IDS: readonly ClaudeCliModelId[] = [
  'claude-fable-5-2',
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
]

/**
 * Reasoning effort levels admitted by the `claude` CLI's `--effort` flag, and by
 * all four registered models.
 *
 * Documented, not live-verified: the Anthropic effort page
 * (`https://platform.claude.com/docs/en/build-with-claude/effort`, read 2026-11-20)
 * says Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5 each support all five levels,
 * and the Claude Code model configuration page
 * (`https://code.claude.com/docs/en/model-config`, read 2026-11-20) lists the same
 * five for the Fable models and for Opus 5.5, Sonnet 5.5 and Haiku 5.5.
 *
 * `ultracode` is deliberately absent. `--effort ultracode` is a Claude Code workflow
 * switch (it also sets the level to `xhigh`), not a model effort level, so a
 * request for it is rejected like any other unknown value.
 */
export const CLAUDE_CLI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Build the strict per-model config schema for a `claude-cli` model.
 *
 * No `temperature`/`topP`/`topK`/`maxOutputTokens`/`stopSequences` fields —
 * the CLI does not support tuning any of these, and `z.strictObject` rejects
 * any unknown key outright (reject, don't map/clamp).
 */
function buildConfigSchema(modelName: string): z.ZodType {
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

export const ClaudeFable52ConfigSchema = buildConfigSchema('claude-fable-5-2')
export const ClaudeOpus55ConfigSchema = buildConfigSchema('claude-opus-5-5')
export const ClaudeSonnet55ConfigSchema = buildConfigSchema('claude-sonnet-5-5')
export const ClaudeHaiku55ConfigSchema = buildConfigSchema('claude-haiku-5-5')

const CONFIG_SCHEMAS: Record<ClaudeCliModelId, z.ZodType> = {
  'claude-fable-5-2': ClaudeFable52ConfigSchema,
  'claude-opus-5-5': ClaudeOpus55ConfigSchema,
  'claude-sonnet-5-5': ClaudeSonnet55ConfigSchema,
  'claude-haiku-5-5': ClaudeHaiku55ConfigSchema,
}

// ---------------------------------------------------------------------------
// Descriptors + registry
// ---------------------------------------------------------------------------

/**
 * Context window and maximum output per model, as the Anthropic models overview
 * documents them for the API: 1M tokens of context and 128K tokens of output for
 * Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5
 * (`https://platform.claude.com/docs/en/about-claude/models/overview`, read
 * 2026-11-20). For `claude-opus-5-5` the CLI itself reported the same two figures in
 * the captured `modelUsage` (`__fixtures__/model-refresh-p-a1.json`, Claude Code
 * 2.1.282, 2026-09-26). For the three ids registered on 2026-11-20 (Fable 5.2,
 * Sonnet 5.5, Haiku 5.5) the figures are documented, not live-verified: no
 * `modelUsage` has been captured for them, and the CLI exposes no output-size knob,
 * so a call may run under a smaller output limit than the API's.
 */
const CLAUDE_CLI_LIMITS: ModelLimits = {
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
}

export const claudeCliModelDescriptors: ModelDescriptor[] = CLAUDE_CLI_MODEL_IDS.map(
  (id): ModelDescriptor => {
    const configSchema = CONFIG_SCHEMAS[id]
    return {
      model: id,
      provider: 'claude-cli',
      limits: { ...CLAUDE_CLI_LIMITS },
      capabilities: {
        // The CLI runs text-only: the adapter rejects every non-text part.
        inputMimeTypes: [],
        structuredOutput: true,
        nativeStructuredOutput: true,
        reasoningApi: 'level',
        admittedReasoningEfforts: CLAUDE_CLI_EFFORTS,
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
