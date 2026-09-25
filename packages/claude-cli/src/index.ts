/**
 * @gullabs/claude-cli — dev-only Claude Code CLI provider adapter.
 *
 * > **DEV-ONLY.** Routes calls through a locally-authenticated `claude` CLI
 * > session for $0 API spend during workflow iteration. Never use this as a
 * > fallback for an API provider.
 *
 * @example
 * ```ts
 * import { claudeCliAdapter } from '@gullabs/claude-cli'
 * import { createClient } from '@gullabs/core'
 *
 * const client = createClient({ adapters: [claudeCliAdapter()] })
 *
 * const result = await client.generate(
 *   {
 *     provider: 'claude-cli',
 *     model: 'claude-haiku-4-5-20251001',
 *     messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello' }] }],
 *   },
 *   { auth: { cliSession: true } },
 * )
 * ```
 *
 * @module
 */

export { claudeCliAdapter } from './adapter.js'
export type {
  ClaudeCliAdapterOptions,
  ClaudeCliEnvelope,
  ClaudeCliUsageShape,
} from './adapter.js'
export { claudeCliProvider } from './provider.js'

export { buildClaudeCliRunner } from './runner.js'
export type {
  ClaudeCliRunner,
  ClaudeCliRunResult,
  ClaudeCliRunOptions,
} from './runner.js'

export { claudeCliModelDescriptors, claudeCliRegistry } from './models.js'
export type { ClaudeCliModelId } from './models.js'
export {
  ClaudeFable51ConfigSchema,
  ClaudeOpus55ConfigSchema,
  ClaudeSonnet5ConfigSchema,
  ClaudeHaiku45ConfigSchema,
  CLAUDE_CLI_MODEL_IDS,
  CLAUDE_CLI_EFFORTS,
  DELETED_CLAUDE_CLI_MODEL_IDS,
} from './models.js'
