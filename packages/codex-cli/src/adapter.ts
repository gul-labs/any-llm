/**
 * codexCliAdapter — @gullabs/codex-cli provider adapter.
 *
 * Pure request⇄response mapping over a locally-authenticated `codex` CLI
 * session (via {@link CodexCliRunner}).  Never persists, never computes
 * cost, never loops, never validates structured output.
 *
 * DEV-ONLY: this adapter requires `ctx.auth = { cliSession: true }` and
 * shells out to the `codex` binary on `PATH`.  It has no API-key code path
 * whatsoever — see `packages/core/src/ports.ts` for the `AuthMaterial`
 * union this narrows against.
 *
 * @module
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LlmError, classifyError, classifyHttpStatus } from '@gullabs/core'
import type {
  ProviderAdapter,
  ResolvedRequest,
  AdapterCtx,
  AdapterResult,
  Usage,
  Warning,
  JsonValue,
  Message,
  Part,
} from '@gullabs/core'
import { parseExtraEnv } from './env.js'
import { createCodexCliRunner } from './runner.js'
import type { CodexCliRunner } from './runner.js'
import { assertOpenAiStrictOutputSchema } from './output-schema.js'

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface CodexCliAdapterOptions {
  /**
   * Inject a runner (real or fake).  When omitted, the real
   * `node:child_process`-backed runner from {@link createCodexCliRunner} is
   * used.  Committed tests ALWAYS inject a fake here — the real runner is
   * never exercised by the test suite.
   */
  runner?: CodexCliRunner
  /** Path (or bare command name resolved via `PATH`) to the `codex` binary. */
  codexPath?: string
  /** Maximum number of concurrent `runner.run` invocations. Defaults to 2. */
  maxConcurrency?: number
  /**
   * Variables handed to the `codex` child on top of the allowlisted copy of the
   * host environment (PATH, HOME, locale, proxy, `CODEX_HOME`, `CODEX_CA_CERTIFICATE`).
   * They win over the allowlisted ones. The host's `CODEX_API_KEY`, `OPENAI_API_KEY`
   * and provider-routing variables are never inherited, so the CLI uses its saved
   * login; passing one here is the explicit opt-in, and the call is then billed to
   * it while the ledger still records it as unpriced. Values must be strings, else
   * `bad_request` at construction.
   */
  env?: Readonly<Record<string, string>>
}

// ---------------------------------------------------------------------------
// In-file concurrency semaphore — no external dep, no core RateLimiter port.
// ---------------------------------------------------------------------------

function abortError(): Error {
  const err = new Error('codex-cli call aborted')
  err.name = 'AbortError'
  return err
}

function createSemaphore(maxConcurrency: number): {
  acquire: (signal?: AbortSignal) => Promise<() => void>
} {
  let active = 0
  const queue: Array<() => void> = []

  // A freed slot goes straight to the next waiter, so a new caller cannot
  // overtake it between the release and the waiter's wake-up.
  const release = (): void => {
    const next = queue.shift()
    if (next !== undefined) next()
    else active -= 1
  }

  return {
    /**
     * Take a slot. A caller that has to wait leaves the queue, and rejects with an
     * `AbortError`, as soon as `signal` fires: a call the engine already gave up
     * on must not hold a place in line.
     */
    acquire(signal?: AbortSignal): Promise<() => void> {
      if (signal?.aborted === true) return Promise.reject(abortError())
      if (active < maxConcurrency) {
        active += 1
        return Promise.resolve(release)
      }
      return new Promise((resolve, reject) => {
        const grant = (): void => {
          signal?.removeEventListener('abort', onAbort)
          resolve(release)
        }
        const onAbort = (): void => {
          const at = queue.indexOf(grant)
          if (at >= 0) queue.splice(at, 1)
          reject(abortError())
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        queue.push(grant)
      })
    },
  }
}

// ---------------------------------------------------------------------------
// Invariant argv — adapter-owned, never caller-configurable.
// ---------------------------------------------------------------------------

const INVARIANT_ARGS = [
  'exec',
  '--json',
  '--ephemeral',
  '--skip-git-repo-check',
  '--ignore-user-config',
  '--ignore-rules',
  '--sandbox',
  'read-only',
  '--strict-config',
]

// ---------------------------------------------------------------------------
// Prompt serialization
// ---------------------------------------------------------------------------

/** Extracts the single text string from a text-only part list, else throws. */
function requireTextOnly(parts: Part[]): string[] {
  return parts.map((p) => {
    if (p.kind !== 'text') {
      throw new LlmError(
        'codex-cli is text-only; non-text message parts (inline media, file URIs, tool-call, tool-result) are not supported — do not use -i images in v1',
        { kind: 'bad_request', retryable: false, provider: 'codex-cli' },
      )
    }
    return p.text
  })
}

/**
 * Serialize the conversation into a single prompt string.
 *
 * A single user message with a single text part is passed verbatim (matches
 * the captured smoke-test invocation shape). Otherwise, messages are
 * rendered as role-labelled `User:`/`Assistant:` blocks separated by blank
 * lines.
 */
function serializeMessages(messages: Message[]): string {
  if (messages.length === 1 && messages[0]?.role === 'user') {
    const [text] = requireTextOnly(messages[0].parts)
    if (messages[0].parts.length === 1 && text !== undefined) {
      return text
    }
  }

  return messages
    .map((msg) => {
      const label = msg.role === 'assistant' ? 'Assistant' : 'User'
      const text = requireTextOnly(msg.parts).join('')
      return `${label}:\n${text}`
    })
    .join('\n\n')
}

/**
 * Fold the optional system instruction into the prompt as a delimited
 * preamble block.
 *
 * This is TRANSPORT ENCODING, not capability mapping — `codex exec` has no
 * system-prompt flag, so the content reaches the model verbatim as part of
 * the user turn.  It is not a distinct system-role message the way
 * Gemini/Claude support natively.  See the README for the same caveat.
 */
function buildPrompt(system: string | undefined, messages: Message[]): string {
  const body = serializeMessages(messages)
  if (system === undefined) return body
  return `<system>\n${system}\n</system>\n\n${body}`
}

// ---------------------------------------------------------------------------
// JSONL event shapes (structural — only the fields we read)
// ---------------------------------------------------------------------------

interface ThreadStartedEvent {
  type: 'thread.started'
  thread_id: string
}

interface ItemCompletedEvent {
  type: 'item.completed'
  item: { id: string; type: string; text?: string; message?: string }
}

interface TurnUsage {
  input_tokens?: number
  cached_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
}

interface TurnCompletedEvent {
  type: 'turn.completed'
  usage?: TurnUsage
}

interface StreamErrorEvent {
  type: 'error'
  message: string
}

interface TurnFailedEvent {
  type: 'turn.failed'
  error?: { message?: string }
}

type CodexJsonlEvent =
  | ThreadStartedEvent
  | ItemCompletedEvent
  | TurnCompletedEvent
  | StreamErrorEvent
  | TurnFailedEvent
  | { type: string; [k: string]: unknown }

interface ParsedJsonlEvents {
  events: CodexJsonlEvent[]
  /** Number of non-blank lines that failed to parse as a recognized event. */
  malformedCount: number
}

/**
 * Defensively parse a JSONL stdout stream, skipping lines that fail to parse
 * or don't match the expected `{ type: string, ... }` event shape.
 *
 * Malformed lines are still counted (not just silently dropped) so the
 * caller can attach a `Warning` when any were skipped — see the
 * `malformedCount` field.
 */
function parseJsonlEvents(stdout: string): ParsedJsonlEvents {
  const events: CodexJsonlEvent[] = []
  let malformedCount = 0
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as { type?: unknown }).type === 'string'
      ) {
        events.push(parsed as CodexJsonlEvent)
      } else {
        malformedCount += 1
      }
    } catch {
      // Stray non-JSON stdout is possible — count it, don't throw.
      malformedCount += 1
    }
  }
  return { events, malformedCount }
}

// ---------------------------------------------------------------------------
// Nested error envelope (captured 400 shape)
// ---------------------------------------------------------------------------

interface NestedCodexErrorBody {
  type?: string
  error?: { type?: string; code?: string; message?: string; param?: string }
  status?: number
}

// Word-anchored: a bare `auth` would match "author" and "authority", and a bare
// `429` a port or a timestamp.
const AUTH_FAILURE = /\b(?:log ?in|auth|oauth|authentication|unauthori[sz]ed|401)\b/i
const RATE_LIMITED =
  /\brate[ -]?limit(?:ed|s|ing)?\b|\btoo many requests\b|(?<![\w.:/-])429(?![\w-]|\.\d)/i

/**
 * Classify a fatal codex stream error message into an `LlmError`.
 *
 * `rawMessage` is either:
 * - A JSON-encoded string (parse again) containing `{error:{...}, status}`.
 * - A raw non-JSON string (stderr tail, or an unparseable error line).
 */
function classifyCodexStreamError(rawMessage: string): LlmError {
  let nested: NestedCodexErrorBody | undefined
  try {
    const parsed: unknown = JSON.parse(rawMessage)
    if (parsed !== null && typeof parsed === 'object') {
      nested = parsed
    }
  } catch {
    // Not JSON — fall through to text-based heuristics below.
  }

  if (nested?.status !== undefined) {
    const cls = classifyHttpStatus(nested.status)
    const message = nested.error?.message ?? rawMessage
    return new LlmError(message, {
      kind: cls.kind,
      retryable: cls.retryable,
      httpStatus: nested.status,
      ...(cls.retryAfterMs !== undefined ? { retryAfterMs: cls.retryAfterMs } : {}),
      provider: 'codex-cli',
    })
  }

  // Text-based fallback — no numeric status found.
  // An explicit rate-limit signal wins over an incidental mention of auth.
  if (RATE_LIMITED.test(rawMessage)) {
    return new LlmError(rawMessage, {
      kind: 'rate_limited',
      retryable: true,
      provider: 'codex-cli',
    })
  }
  if (AUTH_FAILURE.test(rawMessage)) {
    return new LlmError(rawMessage, {
      kind: 'invalid_auth',
      retryable: false,
      provider: 'codex-cli',
    })
  }

  // Generic non-classified bucket — deliberately non-retryable per spec,
  // even though `server` is usually retryable.
  return new LlmError(rawMessage, {
    kind: 'server',
    retryable: false,
    provider: 'codex-cli',
  })
}

// ---------------------------------------------------------------------------
// Usage mapping
// ---------------------------------------------------------------------------

/**
 * Map codex's `turn.completed.usage` to our `Usage` type.
 *
 * **GROSS convention enforced here:**
 * `reasoning_output_tokens` is a SUBSET of `output_tokens` per OpenAI's
 * Responses API token accounting (mirrors Gemini's `thoughtsTokenCount`
 * being a subset of `candidatesTokenCount` + `thoughtsTokenCount` GROSS
 * total) — it is surfaced as `thinkingTokens` / `details.thinking` but is
 * NOT added on top of `outputTokens`, since it is already inside
 * `output_tokens`. Likewise `cached_input_tokens` is a subset of
 * `input_tokens`. `totalTokens` is not reported by codex's
 * `turn.completed.usage` payload — it is derived as
 * `inputTokens + outputTokens` (a GROSS total; `reasoning_output_tokens`/
 * `cached_input_tokens` are already subsets of those two, not added again)
 * whenever a usage payload was present; left undefined when there was no
 * usage payload at all.
 */
function mapUsage(usage: TurnUsage | undefined): Usage {
  const inputTokens = usage?.input_tokens ?? 0
  const outputTokens = usage?.output_tokens ?? 0
  const cachedInputTokens = usage?.cached_input_tokens
  const thinkingTokens = usage?.reasoning_output_tokens
  const totalTokens = usage !== undefined ? inputTokens + outputTokens : undefined

  const details: Record<string, number> = {
    input: inputTokens,
    output: outputTokens,
    ...(cachedInputTokens !== undefined ? { cached: cachedInputTokens } : {}),
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
// codexCliAdapter factory
// ---------------------------------------------------------------------------

/**
 * Create a Codex CLI provider adapter.
 *
 * @param opts.runner - Optional injected runner (fakes in tests; real
 *   `createCodexCliRunner()` output in production dev usage).
 */
export function codexCliAdapter(opts?: CodexCliAdapterOptions): ProviderAdapter {
  const runner = opts?.runner ?? createCodexCliRunner(opts?.codexPath)
  const maxConcurrency = opts?.maxConcurrency ?? 2
  const semaphore = createSemaphore(maxConcurrency)
  const env = parseExtraEnv(opts?.env)

  return {
    id: 'codex-cli',

    async run(req: ResolvedRequest, ctx: AdapterCtx): Promise<AdapterResult> {
      // ------------------------------------------------------------------
      // 0. Auth — these providers only ever accept a CLI session opt-in.
      // ------------------------------------------------------------------
      const hasCliSession = 'cliSession' in ctx.auth && ctx.auth.cliSession
      if (!hasCliSession) {
        throw new LlmError(
          '@gullabs/codex-cli requires auth: { cliSession: true } — these dev-only providers route through a locally-authenticated `codex` CLI session, not an API key',
          { kind: 'invalid_auth', retryable: false, provider: 'codex-cli' },
        )
      }

      if (req.provider !== 'codex-cli') {
        throw new LlmError(
          `@gullabs/codex-cli received a request routed for provider "${req.provider}" — this adapter only serves "codex-cli"`,
          { kind: 'bad_request', retryable: false, provider: 'codex-cli' },
        )
      }
      if (req.tools !== undefined && req.tools.length > 0) {
        throw new LlmError(
          'codex-cli does not support LlmRequest.tools; CLI runtimes are out of the function-calling seam.',
          { kind: 'bad_request', retryable: false, provider: 'codex-cli' },
        )
      }

      const warnings: Warning[] = []
      const model = req.model
      if (
        req.modelDescriptor?.model !== model ||
        req.modelDescriptor.provider !== 'codex-cli'
      ) {
        throw new LlmError(`No matching Codex model descriptor for "${model}".`, {
          kind: 'bad_request',
          retryable: false,
          provider: 'codex-cli',
        })
      }
      if (req.transientProviderState !== undefined) {
        throw new LlmError(`Model "${model}" does not admit transientProviderState.`, {
          kind: 'bad_request',
          retryable: false,
          provider: 'codex-cli',
        })
      }

      // ------------------------------------------------------------------
      // 1. Validate + serialize the prompt (throws bad_request on non-text
      //    parts BEFORE invoking the runner).
      // ------------------------------------------------------------------
      const prompt = buildPrompt(req.system, req.messages)

      // ------------------------------------------------------------------
      // 2. Scratch dir — adapter-owned per call. Serves double duty: it is
      //    both the runner's `cwd` AND the `-C <scratchDir>` argv value,
      //    and it holds the --output-schema / -o temp files.
      // ------------------------------------------------------------------
      // A slot is taken first, and the directory made only once one is held: a
      // queued call owns nothing to clean up and leaves the queue on abort.
      let release: () => void
      try {
        release = await semaphore.acquire(req.signal)
      } catch (waitErr) {
        throw new LlmError(
          waitErr instanceof Error ? waitErr.message : 'codex-cli call aborted',
          { kind: 'aborted', retryable: false, provider: 'codex-cli' },
        )
      }
      let scratchDir: string
      try {
        scratchDir = await mkdtemp(join(tmpdir(), 'codex-cli-'))
      } catch (mkdirErr) {
        release()
        throw mkdirErr
      }

      try {
        try {
          // ----------------------------------------------------------------
          // 3. Build argv.
          // ----------------------------------------------------------------
          const args: string[] = [
            ...INVARIANT_ARGS,
            '-C',
            scratchDir,
            '-c',
            'approval_policy=never',
            '--color',
            'never',
            '-m',
            model,
          ]

          const effort = req.config.reasoning?.effort
          if (effort !== undefined) {
            args.push('-c', `model_reasoning_effort=${effort}`)
          }

          const structuredOutputRequested = req.outputJsonSchema !== undefined
          if (structuredOutputRequested) {
            const schema = req.outputJsonSchema as JsonValue
            assertOpenAiStrictOutputSchema(schema)
            const schemaPath = join(scratchDir, 'schema.json')
            await writeFile(schemaPath, JSON.stringify(schema), 'utf-8')
            args.push('--output-schema', schemaPath)
          }

          // -o is ALWAYS passed — plain-text calls also get a reliable
          // final-text capture path, per spec.
          const outputPath = join(scratchDir, 'output.json')
          args.push('-o', outputPath)

          // The fully-serialized prompt (with the optional <system> preamble
          // folded in) travels on stdin and the positional argument is `-`,
          // which `codex exec` documents as "read instructions from stdin".
          // A prompt in argv would hit the OS limit on one argument (128 KiB
          // on Linux, E2BIG) for a large history or file.
          args.push('-')

          // ----------------------------------------------------------------
          // 4. Timeout — the runner owns timeout/abort enforcement
          //    end-to-end: it only settles (resolve OR reject) once the
          //    child process has actually exited (its 'close' event
          //    fired). We deliberately do NOT race an independent timer
          //    against `runner.run(...)` here — doing so could let this
          //    adapter move on (and release the semaphore / rm the
          //    scratch dir) while the real OS child process is still
          //    alive and possibly still writing into `scratchDir`. We
          //    simply await the runner promise and classify whatever it
          //    settles with.
          // ----------------------------------------------------------------
          const timeoutMs = req.attemptTimeoutMs ?? req.config.timeoutMs

          let result: Awaited<ReturnType<CodexCliRunner['run']>>
          try {
            result = await runner.run(args, prompt, {
              cwd: scratchDir,
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
              ...(req.signal !== undefined ? { signal: req.signal } : {}),
              ...(env !== undefined ? { env } : {}),
            })
          } catch (rawErr) {
            if (
              rawErr !== null &&
              typeof rawErr === 'object' &&
              (rawErr as { code?: unknown }).code === 'ENOENT'
            ) {
              throw new LlmError(
                'codex CLI not found on PATH — install the OpenAI Codex CLI and authenticate (see `codex login`)',
                { kind: 'unknown', retryable: false, provider: 'codex-cli' },
              )
            }
            const classified = classifyError(rawErr)
            throw new LlmError(classified.message, {
              kind: classified.kind,
              retryable: classified.retryable,
              ...(classified.httpStatus !== undefined
                ? { httpStatus: classified.httpStatus }
                : {}),
              ...(classified.retryAfterMs !== undefined
                ? { retryAfterMs: classified.retryAfterMs }
                : {}),
              provider: 'codex-cli',
              cause: classified.cause ?? rawErr,
            })
          }

          const { stdout, exitCode } = result
          const { events, malformedCount } = parseJsonlEvents(stdout)

          // ----------------------------------------------------------------
          // 5. Fatal stream-level errors.
          // ----------------------------------------------------------------
          for (const event of events) {
            if (event.type === 'error') {
              const message = (event as StreamErrorEvent).message
              throw classifyCodexStreamError(message)
            }
            if (event.type === 'turn.failed') {
              const failed = event as TurnFailedEvent
              const message = failed.error?.message ?? 'codex turn failed'
              throw classifyCodexStreamError(message)
            }
          }

          // `null` is a process ended by a signal (an outside SIGKILL, the OOM
          // killer). With no `turn.completed` the turn never finished, whatever
          // intermediate message was streamed before the kill.
          if (
            exitCode === null &&
            !events.some((event) => event.type === 'turn.completed')
          ) {
            const stderrTail = result.stderr.slice(-2000)
            throw new LlmError(
              `codex exec was killed by a signal before the turn completed: ${stderrTail}`,
              { kind: 'server', retryable: false, provider: 'codex-cli' },
            )
          }

          if (exitCode !== 0 && exitCode !== null) {
            const stderrTail = result.stderr.slice(-2000)
            throw new LlmError(`codex exec exited with code ${exitCode}: ${stderrTail}`, {
              kind: 'server',
              retryable: false,
              provider: 'codex-cli',
            })
          }

          // ----------------------------------------------------------------
          // 6. Final text/structured payload — PREFER the -o tmpfile,
          //    FALLBACK to the last agent_message item.text.
          // ----------------------------------------------------------------
          let preferredText: string | undefined
          try {
            const fileContent = await readFile(outputPath, 'utf-8')
            if (fileContent.trim().length > 0) {
              preferredText = fileContent
            }
          } catch {
            // -o file missing — fall through to the JSONL fallback.
          }

          if (preferredText === undefined) {
            let lastAgentMessage: string | undefined
            for (const event of events) {
              if (event.type === 'item.completed') {
                const item = (event as ItemCompletedEvent).item
                if (item.type === 'agent_message' && item.text !== undefined) {
                  lastAgentMessage = item.text
                }
              }
            }
            preferredText = lastAgentMessage
          }

          // exitCode === 0 with no final text (from the -o file or an
          // item.completed agent_message) means codex produced nothing we
          // can parse a result out of — treat this as a false success
          // rather than silently returning an empty/zeroed AdapterResult.
          // This can happen even when turn.completed IS present: a
          // truncated stream can retain the turn.completed envelope while
          // losing the answer payload itself.
          if (preferredText === undefined) {
            const stdoutTail = stdout.slice(-1000)
            throw new LlmError(
              `codex completed without a final message — truncated or incompatible output. stdout tail: ${stdoutTail}`,
              { kind: 'server', retryable: false, provider: 'codex-cli' },
            )
          }

          if (malformedCount > 0) {
            warnings.push({
              type: 'other',
              message: `codex-cli: skipped ${malformedCount} malformed JSONL line${malformedCount === 1 ? '' : 's'} in the event stream`,
            })
          }

          let rawStructured: unknown
          if (structuredOutputRequested) {
            try {
              rawStructured = JSON.parse(preferredText)
            } catch {
              warnings.push({
                type: 'other',
                message: 'codex-cli: failed to JSON-parse structured output payload',
              })
            }
          }

          // ----------------------------------------------------------------
          // 7. Usage + threadId.
          // ----------------------------------------------------------------
          let usageEvent: TurnUsage | undefined
          let threadId: string | undefined
          for (const event of events) {
            if (event.type === 'turn.completed') {
              usageEvent = (event as TurnCompletedEvent).usage
            }
            if (event.type === 'thread.started') {
              threadId = (event as ThreadStartedEvent).thread_id
            }
          }

          if (usageEvent === undefined) {
            warnings.push({
              type: 'other',
              message:
                'codex-cli: no usage data available for this call (missing turn.completed usage) — token counts are unavailable',
            })
          }

          const usage = mapUsage(usageEvent)

          const adapterResult: AdapterResult = {
            model,
            message: {
              role: 'assistant',
              parts:
                preferredText.length > 0 ? [{ kind: 'text', text: preferredText }] : [],
            },
            usage,
            warnings,
            // No explicit finish-reason signal is present in the captured
            // envelope (no MAX_TOKENS/safety marker) — 'stop' is the only
            // supportable value on a successful turn.completed.
            finishReason: 'stop',
            ...(preferredText.length > 0 ? { text: preferredText } : {}),
            ...(rawStructured !== undefined ? { rawStructured } : {}),
            ...(threadId !== undefined ? { providerMetadata: { threadId } } : {}),
          }

          return adapterResult
        } finally {
          release()
        }
      } finally {
        await rm(scratchDir, { recursive: true, force: true })
      }
    },
  }
}
