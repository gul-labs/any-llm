/**
 * claudeCliAdapter — @gullabs/claude-cli provider adapter.
 *
 * Pure request⇄response mapping over the locally-authenticated `claude`
 * (Claude Code) CLI, via {@link ClaudeCliRunner}. Never persists, never
 * computes cost, never retries, never reads `process.env`.
 *
 * DEV-ONLY: this adapter requires `ctx.auth = { cliSession: true }` — it
 * shells out to a `claude` binary that owns its own local login/session
 * state. It is never usable in a production/serverless environment because
 * there is no interactive CLI login there by construction.
 *
 * @module
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LlmError } from '@gullabs/core'
import type {
  ProviderAdapter,
  ResolvedRequest,
  AdapterCtx,
  AdapterResult,
  Usage,
  Warning,
  FinishReason,
  JsonValue,
  Message,
  Part,
} from '@gullabs/core'
import { buildClaudeCliRunner } from './runner.js'
import type { ClaudeCliRunner, ClaudeCliRunResult } from './runner.js'

// ---------------------------------------------------------------------------
// Captured CLI envelope shape (see repo notes for the two captured fixtures)
// ---------------------------------------------------------------------------

/**
 * The `usage` object nested inside the `claude -p --output-format json`
 * result envelope. Only the fields this adapter consumes are typed here;
 * the full object is preserved verbatim in `Usage.raw`.
 */
export interface ClaudeCliUsageShape {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens_details?: { thinking_tokens?: number }
  [key: string]: unknown
}

/**
 * The top-level JSON envelope emitted on stdout by
 * `claude -p ... --output-format json` on completion (success or error).
 */
export interface ClaudeCliEnvelope {
  type: string
  subtype?: string
  is_error?: boolean
  result?: string
  stop_reason?: string
  session_id?: string
  total_cost_usd?: number
  num_turns?: number
  usage?: ClaudeCliUsageShape
  /** Per-model usage, checked for an exact requested-model match on success. */
  modelUsage?: Record<string, unknown>
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Tiny in-file semaphore — adapter-internal concurrency control
// ---------------------------------------------------------------------------

class Semaphore {
  private available: number
  private readonly queue: Array<() => void> = []

  constructor(max: number) {
    this.available = max
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1
      return () => {
        this.release()
      }
    }
    await new Promise<void>((resolve) => {
      this.queue.push(resolve)
    })
    this.available -= 1
    return () => {
      this.release()
    }
  }

  private release(): void {
    this.available += 1
    const next = this.queue.shift()
    if (next !== undefined) next()
  }
}

// ---------------------------------------------------------------------------
// FinishReason mapping
// ---------------------------------------------------------------------------

function mapFinishReason(stopReason: string | undefined): FinishReason | undefined {
  if (stopReason === undefined) return undefined
  switch (stopReason) {
    case 'end_turn':
      return 'stop'
    case 'refusal':
      return 'content_filter'
    case 'tool_use':
      // The CLI's own final answer, not a caller-visible tool call — treat
      // as a successful completion for our purposes.
      return 'stop'
    default:
      return 'other'
  }
}

// ---------------------------------------------------------------------------
// Usage mapping — GROSS convention
//
// Anthropic's `input_tokens` counts only the tokens that are neither read from
// nor written to the prompt cache. GROSS input is therefore
// `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
// (live fixture `model-refresh-p-a1.json`: `input_tokens: 2` beside
// `cache_creation_input_tokens: 4011`). `cachedInputTokens` is the cache-read
// part, and the cache-write part is kept as `details.cacheWrite`.
// `output_tokens` already includes thinking, whose own count
// (`output_tokens_details.thinking_tokens`) is `thinkingTokens`.
//
// `totalTokens` is not reported by the claude-cli usage payload — it is
// derived as `inputTokens + outputTokens` whenever a usage payload was
// present; left undefined when there was no usage payload at all.
// ---------------------------------------------------------------------------

function mapUsage(usage: ClaudeCliUsageShape | undefined): Usage {
  const cacheRead = usage?.cache_read_input_tokens
  const cacheWrite = usage?.cache_creation_input_tokens
  const inputTokens = (usage?.input_tokens ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  const outputTokens = usage?.output_tokens ?? 0
  const cachedInputTokens = cacheRead
  const thinkingTokens = usage?.output_tokens_details?.thinking_tokens
  const totalTokens = usage !== undefined ? inputTokens + outputTokens : undefined

  const details: Record<string, number> = {
    input: inputTokens,
    output: outputTokens,
    ...(cachedInputTokens !== undefined ? { cached: cachedInputTokens } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(thinkingTokens !== undefined ? { thinking: thinkingTokens } : {}),
    ...(totalTokens !== undefined ? { total: totalTokens } : {}),
  }

  const raw: JsonValue = usage !== undefined ? (usage as unknown as JsonValue) : null

  return {
    inputTokens,
    outputTokens,
    details,
    raw,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  }
}

// ---------------------------------------------------------------------------
// Prompt serialization
// ---------------------------------------------------------------------------

function partText(part: Part): string {
  if (part.kind !== 'text') {
    throw new LlmError(
      'claude-cli is text-only; non-text message parts (inline media, file URIs, tool-call, tool-result) are not supported',
      {
        kind: 'bad_request',
        retryable: false,
        provider: 'claude-cli',
      },
    )
  }
  return part.text
}

function messageText(msg: Message): string {
  return msg.parts.map(partText).join('')
}

/**
 * Serialize `req.messages` into the single string sent to the CLI over
 * stdin.
 *
 * - Single user message, single text part → the text verbatim.
 * - Otherwise → a role-labelled transcript, blocks separated by a blank line.
 */
function buildPrompt(messages: Message[]): string {
  if (messages.length === 1 && messages[0]?.parts.length === 1) {
    return partText(messages[0].parts[0] as Part)
  }

  return messages
    .map((msg) => {
      const label = msg.role === 'assistant' ? 'Assistant' : 'User'
      return `${label}:\n${messageText(msg)}`
    })
    .join('\n\n')
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

function looksAuthy(text: string): boolean {
  return /login|auth|unauthorized/i.test(text)
}

function looksRateLimited(text: string): boolean {
  return /rate limit|429/i.test(text)
}

function assertServedModel(envelope: ClaudeCliEnvelope, requestedModel: string): void {
  const modelUsage: unknown = envelope.modelUsage
  if (
    modelUsage === null ||
    typeof modelUsage !== 'object' ||
    Array.isArray(modelUsage)
  ) {
    throw new LlmError('claude CLI did not report a valid modelUsage object.', {
      kind: 'server',
      retryable: false,
      provider: 'claude-cli',
    })
  }
  for (const served of Object.keys(modelUsage)) {
    if (served !== requestedModel) {
      throw new LlmError(
        `claude CLI served model "${served}" but the request asked for "${requestedModel}".`,
        { kind: 'server', retryable: false, provider: 'claude-cli' },
      )
    }
  }
  if (!Object.hasOwn(modelUsage, requestedModel)) {
    throw new LlmError(
      `claude CLI did not report the requested model "${requestedModel}" in modelUsage.`,
      { kind: 'server', retryable: false, provider: 'claude-cli' },
    )
  }
}

function classifyRunFailure(
  envelope: ClaudeCliEnvelope | undefined,
  result: ClaudeCliRunResult,
): LlmError {
  if (envelope?.stop_reason === 'refusal') {
    return new LlmError('claude CLI refused the prompt (stop_reason: refusal).', {
      kind: 'content_filter',
      retryable: false,
      provider: 'claude-cli',
    })
  }

  const combinedText = `${envelope?.subtype ?? ''} ${result.stderr}`

  if (looksAuthy(combinedText)) {
    return new LlmError(
      `claude CLI reported an authentication failure: ${result.stderr.slice(-500)}`,
      { kind: 'invalid_auth', retryable: false, provider: 'claude-cli' },
    )
  }

  if (looksRateLimited(combinedText)) {
    return new LlmError(
      `claude CLI reported rate limiting: ${result.stderr.slice(-500)}`,
      {
        kind: 'rate_limited',
        retryable: true,
        provider: 'claude-cli',
      },
    )
  }

  if (envelope?.is_error === true) {
    return new LlmError(
      `claude CLI reported an error (subtype: ${envelope.subtype ?? 'unknown'}): ${result.stderr.slice(-500)}`,
      { kind: 'server', retryable: false, provider: 'claude-cli' },
    )
  }

  const stderrTail = result.stderr.slice(-500)
  return new LlmError(
    `claude CLI exited with code ${String(result.exitCode)}: ${stderrTail}`,
    { kind: 'unknown', retryable: false, provider: 'claude-cli' },
  )
}

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface ClaudeCliAdapterOptions {
  /** Inject a runner (real or fake). Defaults to `buildClaudeCliRunner()`. */
  runner?: ClaudeCliRunner
  /** Path or bare command name for the `claude` binary. Defaults to `'claude'`. */
  claudePath?: string
  /** Max concurrent CLI invocations. Defaults to `2`. */
  maxConcurrency?: number
}

// ---------------------------------------------------------------------------
// claudeCliAdapter factory
// ---------------------------------------------------------------------------

/**
 * Create a dev-only Claude Code CLI provider adapter.
 *
 * Requires `ctx.auth = { cliSession: true }` — see module docs.
 */
export function claudeCliAdapter(opts?: ClaudeCliAdapterOptions): ProviderAdapter {
  // Constructed eagerly but never invoked unless `opts.runner` is absent —
  // `buildClaudeCliRunner` only closes over `node:child_process`, it does not
  // spawn anything until `.run()` is called.
  const runner: ClaudeCliRunner = opts?.runner ?? buildClaudeCliRunner(opts?.claudePath)

  const semaphore = new Semaphore(opts?.maxConcurrency ?? 2)

  return {
    id: 'claude-cli',

    async run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult> {
      // ------------------------------------------------------------------
      // 1. Auth — CliSessionAuth only.
      // ------------------------------------------------------------------
      const hasCliSession = 'cliSession' in ctx.auth && ctx.auth.cliSession
      if (!hasCliSession) {
        throw new LlmError(
          '@gullabs/claude-cli requires auth: { cliSession: true } — these dev-only providers route through a locally-authenticated `claude` CLI session, not an API key',
          { kind: 'invalid_auth', retryable: false, provider: 'claude-cli' },
        )
      }

      if (req.provider !== 'claude-cli') {
        throw new LlmError(
          `@gullabs/claude-cli received a request routed for provider "${req.provider}" — this adapter only serves "claude-cli"`,
          { kind: 'bad_request', retryable: false, provider: 'claude-cli' },
        )
      }
      if (req.tools !== undefined && req.tools.length > 0) {
        throw new LlmError(
          'claude-cli does not support LlmRequest.tools; CLI runtimes are out of the function-calling seam.',
          { kind: 'bad_request', retryable: false, provider: 'claude-cli' },
        )
      }

      const warnings: Warning[] = []
      const model = req.model
      const config = req.config

      if (
        req.modelDescriptor?.model !== model ||
        req.modelDescriptor.provider !== 'claude-cli'
      ) {
        throw new LlmError(`No matching Claude model descriptor for "${model}".`, {
          kind: 'bad_request',
          retryable: false,
          provider: 'claude-cli',
        })
      }
      if (req.transientProviderState !== undefined) {
        throw new LlmError(`Model "${model}" does not admit transientProviderState.`, {
          kind: 'bad_request',
          retryable: false,
          provider: 'claude-cli',
        })
      }
      if (
        config.reasoning !== undefined &&
        req.modelDescriptor.capabilities?.reasoningApi === undefined
      ) {
        throw new LlmError(`Model "${model}" does not admit reasoning.`, {
          kind: 'bad_request',
          retryable: false,
          provider: 'claude-cli',
        })
      }

      // ------------------------------------------------------------------
      // 2. Prompt serialization (throws bad_request on non-text parts).
      // ------------------------------------------------------------------
      const prompt = buildPrompt(req.messages)

      // ------------------------------------------------------------------
      // 3. Invariant argv — adapter-owned, never caller-configurable.
      //
      // We use --safe-mode, NEVER --bare: --bare disables OAuth/keychain
      // auth and would break subscription-based Claude Code auth — the
      // exact mechanism that lets these dev-only providers work with zero
      // API-key configuration at all.
      // ------------------------------------------------------------------
      const args: string[] = [
        '-p',
        '--output-format',
        'json',
        '--safe-mode',
        '--tools',
        '',
        '--disable-slash-commands',
        '--no-session-persistence',
        '--settings',
        '{"switchModelsOnFlag":false}',
      ]

      args.push('--model', model)

      const effort = config.reasoning?.effort
      if (effort !== undefined) {
        // `effort` was already validated against this package's own zod
        // schema at the config layer before the engine called us — forward
        // verbatim, no re-validation, no `any` cast.
        args.push('--effort', String(effort))
      }

      if (req.system !== undefined) {
        args.push('--system-prompt', req.system)
      }

      if (req.outputJsonSchema !== undefined) {
        args.push('--json-schema', JSON.stringify(req.outputJsonSchema))
      }

      // ------------------------------------------------------------------
      // 4. Timeout + scratch dir + runner invocation.
      // ------------------------------------------------------------------
      const timeoutMs = req.attemptTimeoutMs ?? config.timeoutMs

      // The runner owns timeout/abort enforcement end-to-end: it only
      // settles (resolve OR reject) once the child process has actually
      // exited (its 'close' event fired). We deliberately do NOT race an
      // independent timer against `runner.run(...)` here — doing so could
      // let this adapter move on (and release the semaphore / rm the
      // scratch dir) while the real OS child process is still alive and
      // possibly still writing into `cwd`. We simply await the runner
      // promise and classify whatever it settles with.
      const cwd = await mkdtemp(join(tmpdir(), 'claude-cli-'))
      const release = await semaphore.acquire()
      let result: ClaudeCliRunResult
      try {
        result = await runner.run(args, prompt, {
          cwd,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        })
      } catch (rawErr) {
        release()
        await rm(cwd, { recursive: true, force: true })

        if (rawErr instanceof LlmError) throw rawErr

        if (
          typeof rawErr === 'object' &&
          rawErr !== null &&
          'code' in rawErr &&
          (rawErr as { code?: unknown }).code === 'ENOENT'
        ) {
          throw new LlmError(
            'claude CLI not found on PATH — install Claude Code and run `claude auth login`',
            { kind: 'unknown', retryable: false, provider: 'claude-cli' },
          )
        }

        if (rawErr instanceof Error && rawErr.name === 'AbortError') {
          throw new LlmError(rawErr.message || 'claude-cli call aborted', {
            kind: 'aborted',
            retryable: false,
            provider: 'claude-cli',
          })
        }

        if (rawErr instanceof Error && rawErr.name === 'TimeoutError') {
          throw new LlmError(rawErr.message || 'claude-cli call timed out', {
            kind: 'timeout',
            retryable: true,
            provider: 'claude-cli',
          })
        }

        throw new LlmError(
          `claude-cli runner failed: ${rawErr instanceof Error ? rawErr.message : String(rawErr)}`,
          { kind: 'unknown', retryable: false, provider: 'claude-cli', cause: rawErr },
        )
      }
      release()
      await rm(cwd, { recursive: true, force: true })

      // ------------------------------------------------------------------
      // 5. Parse the envelope from stdout.
      // ------------------------------------------------------------------
      let envelope: ClaudeCliEnvelope | undefined
      try {
        envelope = JSON.parse(result.stdout) as ClaudeCliEnvelope
      } catch {
        envelope = undefined
      }

      if (
        result.exitCode !== 0 ||
        envelope?.is_error === true ||
        envelope === undefined
      ) {
        throw classifyRunFailure(envelope, result)
      }

      assertServedModel(envelope, model)

      // ------------------------------------------------------------------
      // 6. Map result → AdapterResult.
      // ------------------------------------------------------------------
      const text = envelope.result ?? ''

      let rawStructured: unknown
      if (req.outputJsonSchema !== undefined) {
        try {
          rawStructured = JSON.parse(text)
        } catch {
          warnings.push({
            type: 'other',
            message: 'claude-cli: failed to parse structured output as JSON',
          })
        }
      }

      const usage = mapUsage(envelope.usage)
      const finishReason = mapFinishReason(envelope.stop_reason)

      const providerMetadata: Record<string, JsonValue> = {
        ...(envelope.total_cost_usd !== undefined
          ? { totalCostUsd: envelope.total_cost_usd }
          : {}),
        ...(envelope.session_id !== undefined ? { sessionId: envelope.session_id } : {}),
        ...(envelope.subtype !== undefined ? { subtype: envelope.subtype } : {}),
        ...(envelope.num_turns !== undefined ? { numTurns: envelope.num_turns } : {}),
      }

      const adapterResult: AdapterResult = {
        model,
        message: {
          role: 'assistant',
          parts: text.length > 0 ? [{ kind: 'text', text }] : [],
        },
        usage,
        warnings,
        ...(text.length > 0 ? { text } : {}),
        ...(rawStructured !== undefined ? { rawStructured } : {}),
        ...(finishReason !== undefined ? { finishReason } : {}),
        ...(Object.keys(providerMetadata).length > 0 ? { providerMetadata } : {}),
      }

      return adapterResult
    },
  }
}
