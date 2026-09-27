/**
 * @gullabs/codex-cli model config schemas + registry.
 *
 * Deliberate deviation from the rest of the monorepo: these schemas are
 * defined IN this package rather than under `packages/core/src/model-config/`.
 * `@gullabs/codex-cli` is a dev-only, $0-spend provider that shells out to a
 * locally-authenticated CLI session — it must never leak into the production
 * core surface that ships model config for real, billed API providers.
 *
 * @module
 */

import { z } from 'zod'

import {
  createModelRegistry,
  toConfigJsonSchema,
  zodToStandardSchema,
} from '@gullabs/core'
import type { ModelDescriptor, ModelRegistry } from '@gullabs/core'

// ---------------------------------------------------------------------------
// Model ids
// ---------------------------------------------------------------------------

/** The exact set of Codex CLI model identifiers this package supports. */
export type CodexCliModelId = 'gpt-6-astra' | 'gpt-6-sol' | 'gpt-6-luna'

/** All supported {@link CodexCliModelId} values, in registry order. */
export const CODEX_CLI_MODEL_IDS: readonly CodexCliModelId[] = [
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
]

// ---------------------------------------------------------------------------
// Reasoning effort
// ---------------------------------------------------------------------------

/**
 * Codex CLI's `model_reasoning_effort` levels.
 *
 * Codex admits `low` through `max`, but not core's `'none'`. `'ultra'` is a CLI delegation switch,
 * not a server reasoning level, so it is excluded.
 */
export const CODEX_CLI_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type CodexCliReasoningEffort = (typeof CODEX_CLI_REASONING_EFFORTS)[number]

// ---------------------------------------------------------------------------
// Per-model config schema factory
// ---------------------------------------------------------------------------

/**
 * Build the strict per-model config schema shared by every Codex CLI model.
 *
 * No temperature/topP/topK/maxOutputTokens/stopSequences on any model — the
 * `codex exec` CLI does not expose sampling knobs, only a reasoning-effort
 * level and a logical timeout.
 */
function buildCodexCliConfigSchema(modelName: string, title: string) {
  return z
    .strictObject({
      reasoning: z
        .strictObject({
          effort: z.enum(CODEX_CLI_REASONING_EFFORTS).meta({
            title: 'Reasoning Effort',
            description: `Reasoning effort forwarded to codex exec's -c model_reasoning_effort for ${modelName}.`,
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
      title,
      description: `Strict codex exec config for model ${modelName}. Dev-only, text-only, $0 CLI-routed calls.`,
      examples: [{ reasoning: { effort: 'medium' } }],
    })
}

export const Gpt6AstraConfigSchema = buildCodexCliConfigSchema(
  'gpt-6-astra',
  'Gpt6AstraConfig',
)
export const Gpt6SolConfigSchema = buildCodexCliConfigSchema('gpt-6-sol', 'Gpt6SolConfig')
export const Gpt6LunaConfigSchema = buildCodexCliConfigSchema(
  'gpt-6-luna',
  'Gpt6LunaConfig',
)

const CONFIG_SCHEMA_BY_ID: Record<CodexCliModelId, z.ZodType> = {
  'gpt-6-astra': Gpt6AstraConfigSchema,
  'gpt-6-sol': Gpt6SolConfigSchema,
  'gpt-6-luna': Gpt6LunaConfigSchema,
}

// ---------------------------------------------------------------------------
// Model descriptors
// ---------------------------------------------------------------------------

/**
 * `ModelDescriptor[]` for every Codex CLI model.
 *
 * The descriptor and strict Zod schema expose the same admitted effort set.
 */
export const codexCliModelDescriptors: ModelDescriptor[] = CODEX_CLI_MODEL_IDS.map(
  (id): ModelDescriptor => {
    const configSchema = CONFIG_SCHEMA_BY_ID[id]
    return {
      model: id,
      provider: 'codex-cli',
      capabilities: {
        structuredOutput: true,
        nativeStructuredOutput: true,
        reasoningApi: 'level',
        admittedReasoningEfforts: CODEX_CLI_REASONING_EFFORTS,
        sampling: 'fixed',
        vision: false,
      },
      configSchema,
      configJsonSchema: toConfigJsonSchema(configSchema),
      validateConfig: zodToStandardSchema(configSchema),
    }
  },
)

/** Registry over every {@link codexCliModelDescriptors} entry. */
export const codexCliRegistry: ModelRegistry = createModelRegistry(
  codexCliModelDescriptors,
)
