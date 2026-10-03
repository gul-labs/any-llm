/**
 * @gullabs/claude-cli — adapter contract tests.
 *
 * All tests use a hand-rolled fake implementing `ClaudeCliRunner` — NO real
 * subprocess is ever spawned.
 *
 * @module
 */

import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import { LlmError, normalizeUsage } from '@gullabs/core'
import type { AdapterCtx, ResolvedRequest } from '@gullabs/core'
import { claudeCliAdapter } from './adapter.js'
import { claudeCliRegistry } from './models.js'
import type { ClaudeCliEnvelope } from './adapter.js'
import type {
  ClaudeCliRunner,
  ClaudeCliRunOptions,
  ClaudeCliRunResult,
} from './runner.js'

// ---------------------------------------------------------------------------
// Synthetic envelopes for narrow contract tests. The separate P-A1 fixture
// below retains selected verbatim fields from four live CLI responses.
// ---------------------------------------------------------------------------

const PLAIN_ENVELOPE: ClaudeCliEnvelope = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'hi',
  stop_reason: 'end_turn',
  session_id: 'dda3ede4-b359-47a8-9750-ebe867989e30',
  total_cost_usd: 0.003755,
  num_turns: 1,
  usage: {
    input_tokens: 3605,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 30,
  },
  modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 3605, outputTokens: 30 } },
}

const STRUCTURED_ENVELOPE: ClaudeCliEnvelope = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '{"greeting":"hi"}',
  stop_reason: 'tool_use',
  session_id: '5660b6c8-636b-453e-9798-70daec48bb93',
  total_cost_usd: 0.010202,
  num_turns: 2,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 4321,
    cache_read_input_tokens: 0,
    output_tokens: 195,
  },
  modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 195 } },
}

const pA1Fixture = JSON.parse(
  readFileSync(
    new URL('./__fixtures__/model-refresh-p-a1.json', import.meta.url),
    'utf8',
  ),
) as {
  schema: NonNullable<ResolvedRequest['outputJsonSchema']>
  responses: Record<string, ClaudeCliEnvelope>
}

// ---------------------------------------------------------------------------
// Fake runner
// ---------------------------------------------------------------------------

type RunCall = { args: string[]; input: string; opts: ClaudeCliRunOptions }

function makeFakeRunner(
  handler: (call: RunCall) => Promise<ClaudeCliRunResult> | ClaudeCliRunResult,
): { runner: ClaudeCliRunner; calls: RunCall[] } {
  const calls: RunCall[] = []
  const runner: ClaudeCliRunner = {
    async run(args, input, opts) {
      const call = { args, input, opts }
      calls.push(call)
      return handler(call)
    },
  }
  return { runner, calls }
}

function envelopeResult(envelope: ClaudeCliEnvelope): ClaudeCliRunResult {
  return { stdout: JSON.stringify(envelope), stderr: '', exitCode: 0 }
}

function makeResolvedReq(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  const model = overrides.model ?? 'claude-haiku-4-5-20251001'
  return {
    provider: 'claude-cli',
    model,
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Say exactly: hi' }] }],
    config: {},
    modelDescriptor: claudeCliRegistry.resolve('claude-cli', model)!,
    ...overrides,
  }
}

const CLI_SESSION_CTX: AdapterCtx = {
  auth: { cliSession: true },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('auth', () => {
  it('rejects ApiKeyAuth with invalid_auth', async () => {
    const { runner } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await expect(
      adapter.run(makeResolvedReq(), {
        auth: { apiKey: 'sk-test' },
        logger: CLI_SESSION_CTX.logger,
      }),
    ).rejects.toMatchObject({ kind: 'invalid_auth', retryable: false })
  })

  it('accepts CliSessionAuth', async () => {
    const { runner } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    const result = await adapter.run(makeResolvedReq(), CLI_SESSION_CTX)
    expect(result.text).toBe('hi')
  })
})

// ---------------------------------------------------------------------------
// Happy path — text
// ---------------------------------------------------------------------------

describe('happy path: text', () => {
  it('maps text, model, finishReason, providerMetadata', async () => {
    const { runner } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    const result = await adapter.run(makeResolvedReq(), CLI_SESSION_CTX)

    expect(result.text).toBe('hi')
    expect(result.model).toBe('claude-haiku-4-5-20251001')
    expect(result.finishReason).toBe('stop')
    expect(result.providerMetadata).toMatchObject({
      totalCostUsd: 0.003755,
      sessionId: 'dda3ede4-b359-47a8-9750-ebe867989e30',
    })
    expect(result.rawStructured).toBeUndefined()
  })

  it('maps GROSS usage numbers from the fixture', async () => {
    const { runner } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    const result = await adapter.run(makeResolvedReq(), CLI_SESSION_CTX)

    expect(result.usage.inputTokens).toBe(3605)
    expect(result.usage.outputTokens).toBe(30)
    expect(result.usage.cachedInputTokens).toBe(0)
    expect(result.usage.details).toEqual({
      input: 3605,
      output: 30,
      cached: 0,
      cacheWrite: 0,
      total: 3635,
    })
    expect(result.usage.totalTokens).toBe(3635)
    expect(result.usage.raw).toEqual(PLAIN_ENVELOPE.usage)
  })
})

// ---------------------------------------------------------------------------
// Happy path — structured output
// ---------------------------------------------------------------------------

describe('happy path: structured output', () => {
  it('parses rawStructured from envelope.result', async () => {
    const { runner } = makeFakeRunner(() => envelopeResult(STRUCTURED_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    const result = await adapter.run(
      makeResolvedReq({ outputJsonSchema: { type: 'object' } }),
      CLI_SESSION_CTX,
    )

    expect(result.rawStructured).toEqual({ greeting: 'hi' })
    // input_tokens 10 + cache_creation 4,321 + cache_read 0.
    expect(result.usage.inputTokens).toBe(4331)
    expect(result.usage.outputTokens).toBe(195)
    expect(result.usage.cachedInputTokens).toBe(0)
    expect(result.usage.details['cacheWrite']).toBe(4321)
  })

  it('pushes a warning and leaves rawStructured undefined on parse failure', async () => {
    const badEnvelope: ClaudeCliEnvelope = { ...STRUCTURED_ENVELOPE, result: 'not json' }
    const { runner } = makeFakeRunner(() => envelopeResult(badEnvelope))
    const adapter = claudeCliAdapter({ runner })

    const result = await adapter.run(
      makeResolvedReq({ outputJsonSchema: { type: 'object' } }),
      CLI_SESSION_CTX,
    )

    expect(result.rawStructured).toBeUndefined()
    expect(result.warnings).toContainEqual({
      type: 'other',
      message: 'claude-cli: failed to parse structured output as JSON',
    })
  })
})

// ---------------------------------------------------------------------------
// Argv construction
// ---------------------------------------------------------------------------

describe('P-A1 live CLI envelopes', () => {
  for (const model of [
    'claude-fable-5-1',
    'claude-opus-5-5',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
  ]) {
    it(`maps ${model} with model switching disabled and JSON schema`, async () => {
      const captured = pA1Fixture.responses[model]
      expect(captured).toBeDefined()
      expect(Object.keys(captured?.modelUsage ?? {})).toEqual([model])
      const { runner, calls } = makeFakeRunner(() => envelopeResult(captured!))
      const result = await claudeCliAdapter({ runner }).run(
        makeResolvedReq({ model, outputJsonSchema: pA1Fixture.schema }),
        CLI_SESSION_CTX,
      )
      expect(result.model).toBe(model)
      expect(result.rawStructured).toEqual({ answer: 'OK' })
      expect(calls[0]?.args).toContain('{"switchModelsOnFlag":false}')
      expect(calls[0]?.args).toContain('--json-schema')
    })
  }
})

describe('argv construction', () => {
  it('builds the exact invariant + mapped argv in order', async () => {
    const { runner, calls } = makeFakeRunner(() =>
      envelopeResult({
        ...PLAIN_ENVELOPE,
        modelUsage: { 'claude-sonnet-5': { inputTokens: 10, outputTokens: 195 } },
      }),
    )
    const adapter = claudeCliAdapter({ runner })

    await adapter.run(
      makeResolvedReq({
        model: 'claude-sonnet-5',
        system: 'be terse',
        config: { reasoning: { effort: 'max' } },
        outputJsonSchema: { type: 'object', properties: {} },
      }),
      CLI_SESSION_CTX,
    )

    expect(calls[0]?.args).toEqual([
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
      '--model',
      'claude-sonnet-5',
      '--effort',
      'max',
      '--system-prompt',
      'be terse',
      '--json-schema',
      JSON.stringify({ type: 'object', properties: {} }),
    ])
  })

  it('never passes --bare', async () => {
    const { runner, calls } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await adapter.run(makeResolvedReq(), CLI_SESSION_CTX)

    expect(calls[0]?.args).not.toContain('--bare')
  })

  it('omits --effort, --system-prompt, --json-schema when unset', async () => {
    const { runner, calls } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await adapter.run(makeResolvedReq(), CLI_SESSION_CTX)

    expect(calls[0]?.args).not.toContain('--effort')
    expect(calls[0]?.args).not.toContain('--system-prompt')
    expect(calls[0]?.args).not.toContain('--json-schema')
  })

  it('rejects reasoning for Haiku before invoking the CLI', async () => {
    const { runner, calls } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await expect(
      adapter.run(
        makeResolvedReq({ config: { reasoning: { effort: 'high' } } }),
        CLI_SESSION_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(calls).toHaveLength(0)
  })

  it('rejects a descriptor for another model before invoking the CLI', async () => {
    const { runner, calls } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })
    await expect(
      adapter.run(
        makeResolvedReq({
          modelDescriptor: claudeCliRegistry.resolve('claude-cli', 'claude-sonnet-5')!,
          config: { reasoning: { effort: 'high' } },
        }),
        CLI_SESSION_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(calls).toHaveLength(0)
  })

  it('throws server when modelUsage names a different model', async () => {
    const switched: ClaudeCliEnvelope = {
      ...PLAIN_ENVELOPE,
      modelUsage: { 'claude-opus-5': { input_tokens: 1 } },
    }
    const { runner } = makeFakeRunner(() => envelopeResult(switched))
    const adapter = claudeCliAdapter({ runner })

    await expect(
      adapter.run(makeResolvedReq({ model: 'claude-fable-5-1' }), CLI_SESSION_CTX),
    ).rejects.toMatchObject({
      kind: 'server',
      retryable: false,
    })
  })

  it('rejects a Haiku helper beside the requested model', async () => {
    const response: ClaudeCliEnvelope = {
      ...PLAIN_ENVELOPE,
      modelUsage: {
        'claude-fable-5-1': { inputTokens: 10, outputTokens: 3 },
        'claude-haiku-4-5-20251001': { inputTokens: 2, outputTokens: 1 },
      },
    }
    const { runner } = makeFakeRunner(() => envelopeResult(response))
    const adapter = claudeCliAdapter({ runner })

    await expect(
      adapter.run(makeResolvedReq({ model: 'claude-fable-5-1' }), CLI_SESSION_CTX),
    ).rejects.toMatchObject({ kind: 'server', retryable: false })
  })

  it('rejects helper-only modelUsage without the requested model', async () => {
    const response: ClaudeCliEnvelope = {
      ...PLAIN_ENVELOPE,
      modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 2 } },
    }
    const { runner } = makeFakeRunner(() => envelopeResult(response))
    const adapter = claudeCliAdapter({ runner })

    await expect(
      adapter.run(makeResolvedReq({ model: 'claude-fable-5-1' }), CLI_SESSION_CTX),
    ).rejects.toMatchObject({ kind: 'server', retryable: false })
  })

  it('rejects a success envelope without modelUsage', async () => {
    const response: ClaudeCliEnvelope = { ...PLAIN_ENVELOPE }
    delete response.modelUsage
    const { runner } = makeFakeRunner(() => envelopeResult(response))
    const adapter = claudeCliAdapter({ runner })

    await expect(adapter.run(makeResolvedReq(), CLI_SESSION_CTX)).rejects.toMatchObject({
      kind: 'server',
      retryable: false,
    })
  })

  it('names both ids when modelUsage mismatches', async () => {
    const switched: ClaudeCliEnvelope = {
      ...PLAIN_ENVELOPE,
      modelUsage: { 'claude-opus-5': { input_tokens: 1 } },
    }
    const { runner } = makeFakeRunner(() => envelopeResult(switched))
    const adapter = claudeCliAdapter({ runner })

    await expect(
      adapter.run(makeResolvedReq({ model: 'claude-fable-5-1' }), CLI_SESSION_CTX),
    ).rejects.toThrow(
      /claude-opus-5[\s\S]*claude-fable-5-1|claude-fable-5-1[\s\S]*claude-opus-5/,
    )
  })

  it('returns a successful refusal with content_filter and billed usage', async () => {
    const refused: ClaudeCliEnvelope = {
      ...PLAIN_ENVELOPE,
      is_error: false,
      stop_reason: 'refusal',
    }
    const { runner } = makeFakeRunner(() => envelopeResult(refused))
    const adapter = claudeCliAdapter({ runner })

    const result = await adapter.run(makeResolvedReq(), CLI_SESSION_CTX)
    expect(result.finishReason).toBe('content_filter')
    expect(result.usage.inputTokens).toBeGreaterThan(0)
    expect(result.usage.outputTokens).toBeGreaterThan(0)
  })

  it('classifies stop_reason refusal as content_filter', async () => {
    const refused: ClaudeCliEnvelope = {
      ...PLAIN_ENVELOPE,
      is_error: true,
      stop_reason: 'refusal',
    }
    const { runner } = makeFakeRunner(() => ({
      stdout: JSON.stringify(refused),
      stderr: '',
      exitCode: 1,
    }))
    const adapter = claudeCliAdapter({ runner })

    await expect(adapter.run(makeResolvedReq(), CLI_SESSION_CTX)).rejects.toMatchObject({
      kind: 'content_filter',
      retryable: false,
    })
  })
})

// ---------------------------------------------------------------------------
// Prompt serialization
// ---------------------------------------------------------------------------

describe('prompt serialization', () => {
  it('passes a single user/single-text message verbatim', async () => {
    const { runner, calls } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await adapter.run(
      makeResolvedReq({
        messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Say exactly: hi' }] }],
      }),
      CLI_SESSION_CTX,
    )

    expect(calls[0]?.input).toBe('Say exactly: hi')
  })

  it('builds a role-labelled transcript for multi-message requests', async () => {
    const { runner, calls } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await adapter.run(
      makeResolvedReq({
        messages: [
          { role: 'user', parts: [{ kind: 'text', text: 'Hi' }] },
          { role: 'assistant', parts: [{ kind: 'text', text: 'Hello' }] },
          { role: 'user', parts: [{ kind: 'text', text: 'How are you?' }] },
        ],
      }),
      CLI_SESSION_CTX,
    )

    expect(calls[0]?.input).toBe('User:\nHi\n\nAssistant:\nHello\n\nUser:\nHow are you?')
  })

  it('rejects non-text parts with bad_request before invoking the runner', async () => {
    const { runner, calls } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await expect(
      adapter.run(
        makeResolvedReq({
          messages: [
            {
              role: 'user',
              parts: [{ kind: 'inline-media', mimeType: 'image/png', data: 'AAAA' }],
            },
          ],
        }),
        CLI_SESSION_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })

    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe('error classification', () => {
  it('maps ENOENT (runner rejects with code ENOENT) to unknown', async () => {
    const { runner } = makeFakeRunner(() => {
      const err = new Error('spawn claude ENOENT') as Error & { code: string }
      err.code = 'ENOENT'
      throw err
    })
    const adapter = claudeCliAdapter({ runner })

    await expect(adapter.run(makeResolvedReq(), CLI_SESSION_CTX)).rejects.toMatchObject({
      kind: 'unknown',
      retryable: false,
    })
  })

  it('maps an is_error envelope with auth-ish stderr to invalid_auth', async () => {
    const { runner } = makeFakeRunner(() => ({
      stdout: JSON.stringify({ type: 'result', subtype: 'error_auth', is_error: true }),
      stderr: 'Please run `claude auth login` — not authorized',
      exitCode: 1,
    }))
    const adapter = claudeCliAdapter({ runner })

    await expect(adapter.run(makeResolvedReq(), CLI_SESSION_CTX)).rejects.toMatchObject({
      kind: 'invalid_auth',
      retryable: false,
    })
  })

  it('maps an is_error envelope with rate-limit-ish stderr to rate_limited (retryable)', async () => {
    const { runner } = makeFakeRunner(() => ({
      stdout: JSON.stringify({ type: 'result', subtype: 'error_rate', is_error: true }),
      stderr: 'HTTP 429: rate limit exceeded',
      exitCode: 1,
    }))
    const adapter = claudeCliAdapter({ runner })

    await expect(adapter.run(makeResolvedReq(), CLI_SESSION_CTX)).rejects.toMatchObject({
      kind: 'rate_limited',
      retryable: true,
    })
  })

  it('maps a generic is_error envelope to server, retryable false', async () => {
    const { runner } = makeFakeRunner(() => ({
      stdout: JSON.stringify({ type: 'result', subtype: 'error_other', is_error: true }),
      stderr: 'something went wrong',
      exitCode: 1,
    }))
    const adapter = claudeCliAdapter({ runner })

    await expect(adapter.run(makeResolvedReq(), CLI_SESSION_CTX)).rejects.toMatchObject({
      kind: 'server',
      retryable: false,
    })
  })

  it('maps a non-zero exit with unparseable stdout to unknown', async () => {
    const { runner } = makeFakeRunner(() => ({
      stdout: 'not json at all',
      stderr: 'boom',
      exitCode: 1,
    }))
    const adapter = claudeCliAdapter({ runner })

    await expect(adapter.run(makeResolvedReq(), CLI_SESSION_CTX)).rejects.toMatchObject({
      kind: 'unknown',
      retryable: false,
    })
  })
})

// ---------------------------------------------------------------------------
// Timeout / abort
// ---------------------------------------------------------------------------

describe('timeout and abort', () => {
  it('throws kind:timeout, retryable:true when the runner reports a timeout', async () => {
    // The runner now owns timeout enforcement end-to-end (it only settles
    // once the simulated child has "closed") — the adapter no longer races
    // an independent timer, so the fake must itself honor opts.timeoutMs
    // and reject with a TimeoutError-named Error, mirroring the real
    // runner's contract.
    const { runner } = makeFakeRunner(
      (call) =>
        new Promise<ClaudeCliRunResult>((_resolve, reject) => {
          setTimeout(() => {
            const err = new Error(
              `claude-cli call exceeded ${call.opts.timeoutMs}ms timeout`,
            )
            err.name = 'TimeoutError'
            reject(err)
          }, call.opts.timeoutMs)
        }),
    )
    const adapter = claudeCliAdapter({ runner })

    await expect(
      adapter.run(makeResolvedReq({ config: { timeoutMs: 10 } }), CLI_SESSION_CTX),
    ).rejects.toMatchObject({ kind: 'timeout', retryable: true })
  })

  it('throws kind:aborted when the AbortSignal fires', async () => {
    const controller = new AbortController()
    const { runner } = makeFakeRunner(
      () =>
        new Promise<ClaudeCliRunResult>((_resolve, reject) => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          if (controller.signal.aborted) {
            reject(err)
            return
          }
          controller.signal.addEventListener('abort', () => reject(err))
        }),
    )
    const adapter = claudeCliAdapter({ runner })

    const runPromise = adapter.run(makeResolvedReq(), {
      ...CLI_SESSION_CTX,
      signal: controller.signal,
    })
    controller.abort()

    await expect(runPromise).rejects.toMatchObject({ kind: 'aborted' })
  })
})

// ---------------------------------------------------------------------------
// Timeout/abort lifecycle — semaphore + scratch dir must outlive the child
// ---------------------------------------------------------------------------

describe('timeout/abort lifecycle: semaphore + scratch dir vs runner settlement', () => {
  it('does not release the semaphore or rm the scratch dir until a late-settling runner promise settles', async () => {
    const fs = await import('node:fs/promises')
    let callCount = 0
    let capturedCwd: string | undefined
    let rejectFirst: ((err: Error) => void) | undefined

    const { runner } = makeFakeRunner((call) => {
      callCount += 1
      if (callCount === 1) {
        capturedCwd = call.opts.cwd
        return new Promise<ClaudeCliRunResult>((_resolve, reject) => {
          rejectFirst = reject
        })
      }
      return envelopeResult(PLAIN_ENVELOPE)
    })
    const adapter = claudeCliAdapter({ runner, maxConcurrency: 1 })

    const firstPromise = adapter
      .run(makeResolvedReq({ config: { timeoutMs: 10 } }), CLI_SESSION_CTX)
      .catch((e: unknown) => e)
    await vi.waitFor(() => expect(capturedCwd).toBeDefined())

    // A second call queues behind maxConcurrency:1 — it must NOT start
    // while the first call's runner promise is still pending, even though
    // the (simulated) timeout has long since fired on the caller side.
    let secondStarted = false
    const secondPromise = adapter.run(makeResolvedReq(), CLI_SESSION_CTX).then((r) => {
      secondStarted = true
      return r
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(secondStarted).toBe(false)
    // The scratch dir must still be on disk — it must not be rm'd while the
    // runner promise (standing in for "the real child process") is pending.
    await expect(fs.access(capturedCwd as string)).resolves.toBeUndefined()

    // Now the injected runner finally settles — simulating the child's
    // 'close' event firing after the SIGTERM/SIGKILL escalation completes.
    const timeoutErr = new Error('claude-cli call exceeded 10ms timeout')
    timeoutErr.name = 'TimeoutError'
    rejectFirst?.(timeoutErr)

    const firstOutcome = await firstPromise
    expect(firstOutcome).toMatchObject({ kind: 'timeout', retryable: true })

    await secondPromise
    expect(secondStarted).toBe(true)
    // Only now should the first call's scratch dir have been removed.
    await expect(fs.access(capturedCwd as string)).rejects.toThrow()
  })

  it('never admits more than maxConcurrency calls under a timeout storm', async () => {
    let active = 0
    let maxActive = 0

    const { runner } = makeFakeRunner(
      () =>
        new Promise<ClaudeCliRunResult>((_resolve, reject) => {
          active += 1
          maxActive = Math.max(maxActive, active)
          setTimeout(() => {
            active -= 1
            const err = new Error('claude-cli call exceeded 10ms timeout')
            err.name = 'TimeoutError'
            reject(err)
          }, 15)
        }),
    )
    const adapter = claudeCliAdapter({ runner, maxConcurrency: 2 })

    const results = await Promise.allSettled([
      adapter.run(makeResolvedReq({ config: { timeoutMs: 10 } }), CLI_SESSION_CTX),
      adapter.run(makeResolvedReq({ config: { timeoutMs: 10 } }), CLI_SESSION_CTX),
      adapter.run(makeResolvedReq({ config: { timeoutMs: 10 } }), CLI_SESSION_CTX),
    ])

    expect(maxActive).toBeLessThanOrEqual(2)
    for (const r of results) {
      expect(r.status).toBe('rejected')
    }
  })
})

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('concurrency semaphore', () => {
  it('with maxConcurrency:1, the second call waits for the first to resolve', async () => {
    const order: string[] = []
    let releaseFirst: (() => void) | undefined
    const { runner } = makeFakeRunner(async (call) => {
      if (call.input === 'first') {
        order.push('first-start')
        await new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        order.push('first-end')
        return envelopeResult(PLAIN_ENVELOPE)
      }
      order.push('second-start')
      return envelopeResult(PLAIN_ENVELOPE)
    })
    const adapter = claudeCliAdapter({ runner, maxConcurrency: 1 })

    const firstReq = makeResolvedReq({
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'first' }] }],
    })
    const secondReq = makeResolvedReq({
      messages: [{ role: 'user', parts: [{ kind: 'text', text: 'second' }] }],
    })

    const p1 = adapter.run(firstReq, CLI_SESSION_CTX)
    // Give the first call a tick to actually start and register as pending.
    await vi.waitFor(() => expect(order).toContain('first-start'))
    const p2 = adapter.run(secondReq, CLI_SESSION_CTX)

    // second must not have started yet
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(['first-start'])

    releaseFirst?.()
    await Promise.all([p1, p2])

    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
  })
})

// ---------------------------------------------------------------------------
// Scratch dir
// ---------------------------------------------------------------------------

describe('scratch dir', () => {
  it('passes a cwd under os.tmpdir() that differs across calls', async () => {
    const { runner, calls } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    await adapter.run(makeResolvedReq(), CLI_SESSION_CTX)
    await adapter.run(makeResolvedReq(), CLI_SESSION_CTX)

    expect(calls).toHaveLength(2)
    const cwd1 = calls[0]?.opts.cwd
    const cwd2 = calls[1]?.opts.cwd
    expect(cwd1).toBeDefined()
    expect(cwd2).toBeDefined()
    expect(cwd1?.startsWith(tmpdir())).toBe(true)
    expect(cwd1).toContain('claude-cli-')
    expect(cwd1).not.toBe(cwd2)
  })
})

// ---------------------------------------------------------------------------
// LlmError sanity
// ---------------------------------------------------------------------------

describe('LlmError shape', () => {
  it('auth rejection is an instance of LlmError with provider tag', async () => {
    const { runner } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })

    try {
      await adapter.run(makeResolvedReq(), {
        auth: { apiKey: 'x' },
        logger: CLI_SESSION_CTX.logger,
      })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).provider).toBe('claude-cli')
    }
  })
})

describe('function-calling seam reject', () => {
  it('rejects LlmRequest.tools', async () => {
    const { runner } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })
    await expect(
      adapter.run(
        makeResolvedReq({
          tools: [{ name: 'f', description: 'd', inputJsonSchema: { type: 'object' } }],
        }),
        CLI_SESSION_CTX,
      ),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining('tools'),
    })
  })

  it('rejects tool-call parts', async () => {
    const { runner } = makeFakeRunner(() => envelopeResult(PLAIN_ENVELOPE))
    const adapter = claudeCliAdapter({ runner })
    await expect(
      adapter.run(
        makeResolvedReq({
          messages: [
            {
              role: 'assistant',
              parts: [
                {
                  kind: 'tool-call',
                  toolCallId: 'c1',
                  toolName: 'f',
                  args: {},
                },
              ],
            },
          ],
        }),
        CLI_SESSION_CTX,
      ),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining('tool-call'),
    })
  })
})

// ---------------------------------------------------------------------------
// R7.7 — usage mapping: both cache lanes are input, thinking is reported
// ---------------------------------------------------------------------------

describe('usage mapping (both cache lanes are input)', () => {
  function envelopeWith(usage: ClaudeCliEnvelope['usage']): ClaudeCliEnvelope {
    return { ...PLAIN_ENVELOPE, ...(usage !== undefined ? { usage } : {}) }
  }
  async function map(usage: ClaudeCliEnvelope['usage']) {
    const { runner } = makeFakeRunner(() => envelopeResult(envelopeWith(usage)))
    return claudeCliAdapter({ runner }).run(makeResolvedReq(), CLI_SESSION_CTX)
  }

  it('the live P-A1 capture: input 2 + cache write 4,011 is 4,013 input tokens, no clamp warning', async () => {
    const captured = pA1Fixture.responses['claude-fable-5-1'] as ClaudeCliEnvelope
    const { runner } = makeFakeRunner(() => envelopeResult(captured))
    const result = await claudeCliAdapter({ runner }).run(
      makeResolvedReq({ model: 'claude-fable-5-1', outputJsonSchema: pA1Fixture.schema }),
      CLI_SESSION_CTX,
    )
    expect(result.usage.inputTokens).toBe(4_013)
    expect(result.usage.cachedInputTokens).toBe(0)
    expect(result.usage.details['cacheWrite']).toBe(4_011)
    expect(result.usage.thinkingTokens).toBe(0)
    expect(result.usage.outputTokens).toBe(53)
    expect(result.usage.totalTokens).toBe(4_013 + 53)
    expect(result.warnings).toEqual([])
  })

  it('cachedInputTokens is cache_read; a cache read larger than input_tokens no longer needs clamping', async () => {
    const result = await map({
      input_tokens: 2,
      cache_read_input_tokens: 5_000,
      cache_creation_input_tokens: 300,
      output_tokens: 40,
    })
    expect(result.usage.inputTokens).toBe(5_302)
    expect(result.usage.cachedInputTokens).toBe(5_000)
    expect(result.usage.details).toEqual({
      input: 5_302,
      output: 40,
      cached: 5_000,
      cacheWrite: 300,
      total: 5_342,
    })
    // The engine's GROSS invariant holds with no clamp warning.
    const { warnings } = normalizeUsage(result.usage)
    expect(warnings).toEqual([])
  })

  it('thinkingTokens comes from output_tokens_details.thinking_tokens and stays inside output', async () => {
    const result = await map({
      input_tokens: 5,
      output_tokens: 900,
      output_tokens_details: { thinking_tokens: 700 },
    })
    expect(result.usage.thinkingTokens).toBe(700)
    expect(result.usage.outputTokens).toBe(900)
    expect(result.usage.details['thinking']).toBe(700)
  })

  it('absent lanes stay absent: no cached, cacheWrite or thinking keys invented', async () => {
    const result = await map({ input_tokens: 7, output_tokens: 3 })
    expect(result.usage.inputTokens).toBe(7)
    expect(result.usage.cachedInputTokens).toBeUndefined()
    expect(result.usage.thinkingTokens).toBeUndefined()
    expect(Object.keys(result.usage.details).sort()).toEqual(['input', 'output', 'total'])
  })

  it('the raw usage object is kept verbatim', async () => {
    const usage = {
      input_tokens: 2,
      cache_creation_input_tokens: 9,
      cache_read_input_tokens: 1,
      output_tokens: 4,
      output_tokens_details: { thinking_tokens: 1 },
      speed: 'standard',
    }
    expect((await map(usage)).usage.raw).toEqual(usage)
  })
})
