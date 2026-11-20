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
  toConfigKeys,
  zodToStandardSchema,
} from '@gullabs/core'
import type { ModelDescriptor, ModelLimits, ModelRegistry } from '@gullabs/core'

// ---------------------------------------------------------------------------
// Model ids
// ---------------------------------------------------------------------------

/** The exact set of Codex CLI model identifiers this package supports. */
export type CodexCliModelId =
  'gpt-6.2-sol' | 'gpt-6.2-astra' | 'gpt-6.1-terra' | 'gpt-6-luna'

/** All supported {@link CodexCliModelId} values, in registry order. */
export const CODEX_CLI_MODEL_IDS: readonly CodexCliModelId[] = [
  'gpt-6.2-sol',
  'gpt-6.2-astra',
  'gpt-6.1-terra',
  'gpt-6-luna',
]

// ---------------------------------------------------------------------------
// Reasoning effort
// ---------------------------------------------------------------------------

/**
 * Codex CLI's `model_reasoning_effort` levels.
 *
 * Codex admits `low` through `max`, but not core's `'none'`. `'ultra'` is a CLI delegation switch
 * ("Maximum reasoning with automatic task delegation" in the Codex model catalog), not a server
 * reasoning level, and `gpt-6-luna` does not offer it at all, so it is excluded.
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

export const Gpt62SolConfigSchema = buildCodexCliConfigSchema(
  'gpt-6.2-sol',
  'Gpt62SolConfig',
)
export const Gpt62AstraConfigSchema = buildCodexCliConfigSchema(
  'gpt-6.2-astra',
  'Gpt62AstraConfig',
)
export const Gpt61TerraConfigSchema = buildCodexCliConfigSchema(
  'gpt-6.1-terra',
  'Gpt61TerraConfig',
)
export const Gpt6LunaConfigSchema = buildCodexCliConfigSchema(
  'gpt-6-luna',
  'Gpt6LunaConfig',
)

const CONFIG_SCHEMA_BY_ID: Record<CodexCliModelId, z.ZodType> = {
  'gpt-6.2-sol': Gpt62SolConfigSchema,
  'gpt-6.2-astra': Gpt62AstraConfigSchema,
  'gpt-6.1-terra': Gpt61TerraConfigSchema,
  'gpt-6-luna': Gpt6LunaConfigSchema,
}

// ---------------------------------------------------------------------------
// Model descriptors
// ---------------------------------------------------------------------------

/**
 * Context window and maximum output per model.
 *
 * The context window is what Codex CLI runs the model with by default, from the
 * model catalog bundled with Codex CLI 0.171.0: 500,000 for `gpt-6.2-sol` and
 * `gpt-6.1-terra`, 272,000 for `gpt-6.2-astra` and `gpt-6-luna`. The same catalog
 * lists an effective context window of 95% of each nominal value (475,000 and
 * 258,400); `contextWindow` keeps the nominal figure. It is not the
 * API's 1,050,000 (OpenAI model pages, `https://developers.openai.com/api/docs/models/<id>`,
 * read 2026-11-20): a call through this provider runs under the CLI's window, so the
 * CLI's figure is the one a host can rely on. Documented, not live-verified.
 *
 * `maxOutputTokens` is the API's "128,000 max output tokens" from the same model
 * pages (read 2026-11-20). `codex exec` exposes no output-size knob, so the limits
 * are informational here: the config schemas carry no `maxOutputTokens`.
 */
const CODEX_CLI_LIMITS: Record<CodexCliModelId, ModelLimits> = {
  'gpt-6.2-sol': { contextWindow: 500_000, maxOutputTokens: 128_000 },
  'gpt-6.2-astra': { contextWindow: 272_000, maxOutputTokens: 128_000 },
  'gpt-6.1-terra': { contextWindow: 500_000, maxOutputTokens: 128_000 },
  'gpt-6-luna': { contextWindow: 272_000, maxOutputTokens: 128_000 },
}

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
      limits: CODEX_CLI_LIMITS[id],
      capabilities: {
        // `codex exec` runs text-only: the adapter rejects every non-text part.
        inputMimeTypes: [],
        structuredOutput: true,
        nativeStructuredOutput: true,
        reasoningApi: 'level',
        admittedReasoningEfforts: CODEX_CLI_REASONING_EFFORTS,
        sampling: 'fixed',
      },
      configSchema,
      configKeys: toConfigKeys(configSchema),
      configJsonSchema: toConfigJsonSchema(configSchema),
      validateConfig: zodToStandardSchema(configSchema),
    }
  },
)

/** Registry over every {@link codexCliModelDescriptors} entry. */
export const codexCliRegistry: ModelRegistry = createModelRegistry(
  codexCliModelDescriptors,
)
