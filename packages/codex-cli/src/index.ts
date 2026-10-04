/**
 * @gullabs/codex-cli — dev-only OpenAI Codex CLI provider adapter.
 *
 * DEV-ONLY: routes calls through a locally-authenticated `codex` CLI
 * session, never an API key.
 *
 * @example
 * ```ts
 * import { codexCliAdapter } from '@gullabs/codex-cli'
 * import { createClient } from '@gullabs/core'
 *
 * const client = createClient({ adapters: [codexCliAdapter()] })
 *
 * const result = await client.generate(
 *   {
 *     provider: 'codex-cli',
 *     model: 'gpt-6-sol',
 *     messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
 *   },
 *   { auth: { cliSession: true } },
 * )
 * ```
 *
 * @module
 */

export { codexCliAdapter } from './adapter.js'
export type { CodexCliAdapterOptions } from './adapter.js'
export { codexCliProvider } from './provider.js'

export { toOpenAiStrictOutputSchema } from './output-schema.js'

export { createCodexCliRunner } from './runner.js'
export type { CodexCliRunner, CodexCliRunOptions, CodexCliRunResult } from './runner.js'

export {
  codexCliModelDescriptors,
  codexCliRegistry,
  CODEX_CLI_MODEL_IDS,
  CODEX_CLI_REASONING_EFFORTS,
  Gpt6AstraConfigSchema,
  Gpt6SolConfigSchema,
  Gpt6LunaConfigSchema,
} from './models.js'
export type { CodexCliModelId, CodexCliReasoningEffort } from './models.js'
