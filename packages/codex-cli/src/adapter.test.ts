/**
 * @gullabs/codex-cli — adapter contract tests.
 *
 * NO real subprocess spawns — every test injects a hand-rolled fake
 * CodexCliRunner implementing the {@link CodexCliRunner} interface.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LlmError } from '@gullabs/core'
import type { ResolvedRequest, AdapterCtx, Message } from '@gullabs/core'
import { codexCliAdapter } from './adapter.js'
import type { CodexCliRunner, CodexCliRunResult } from './runner.js'

// ---------------------------------------------------------------------------
// Fixtures — captured verbatim from the real CLI (see task spec).
// ---------------------------------------------------------------------------

const PLAIN_JSONL = [
  '{"type":"thread.started","thread_id":"019f435f-4756-7242-98ab-d536aa30e739"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest."}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"hi"}}',
  '{"type":"turn.completed","usage":{"input_tokens":14927,"cached_input_tokens":4480,"output_tokens":27,"reasoning_output_tokens":20}}',
].join('\n')

const STRUCTURED_JSONL = [
  '{"type":"thread.started","thread_id":"019f435f-8954-7983-b12b-64f821ab7572"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill descriptions were shortened to fit the 2% skills context budget."}}',
  '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\\"greeting\\":\\"hi\\"}"}}',
  '{"type":"turn.completed","usage":{"input_tokens":15674,"cached_input_tokens":2432,"output_tokens":86,"reasoning_output_tokens":68}}',
].join('\n')

const NESTED_ERROR_BODY = JSON.stringify({
  type: 'error',
  error: {
    type: 'invalid_request_error',
    code: 'invalid_json_schema',
    message:
      "Invalid schema for response_format 'codex_output_schema': In context=(), 'additionalProperties' is required to be supplied and to be false.",
    param: 'text.format.schema',
  },
  status: 400,
})

const TURN_FAILED_JSONL = [
  '{"type":"thread.started","thread_id":"019f435f-0000-0000-0000-000000000000"}',
  '{"type":"turn.started"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill descriptions were shortened."}}',
  `{"type":"error","message":${JSON.stringify(NESTED_ERROR_BODY)}}`,
  `{"type":"turn.failed","error":{"message":${JSON.stringify(NESTED_ERROR_BODY)}}}`,
].join('\n')

// ---------------------------------------------------------------------------
// Fake runner helpers
// ---------------------------------------------------------------------------

interface FakeRunnerCall {
  args: string[]
  input: string
  opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal }
}

/** Builds a fake CodexCliRunner that resolves with a fixed result and records calls. */
function makeFakeRunner(
  behavior: (call: FakeRunnerCall) => Promise<CodexCliRunResult> | CodexCliRunResult,
): { runner: CodexCliRunner; calls: FakeRunnerCall[] } {
  const calls: FakeRunnerCall[] = []
  const runner: CodexCliRunner = {
    async run(args, input, opts) {
      const call: FakeRunnerCall = { args, input, opts }
      calls.push(call)
      return behavior(call)
    },
  }
  return { runner, calls }
}

const FAKE_CTX: AdapterCtx = {
  auth: { cliSession: true },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

function makeResolvedReq(overrides: Partial<ResolvedRequest> = {}): ResolvedRequest {
  return {
    provider: 'codex-cli',
    model: 'gpt-6-sol',
    messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Say exactly: hi' }] }],
    config: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. Happy path — plain text
// ---------------------------------------------------------------------------

describe('happy path: plain text', () => {
  it('returns text + threadId + usage from the JSONL stream', async () => {
    const { runner } = makeFakeRunner(async () => {
      // No -o file written by the CLI in this scenario — exercise the
      // JSONL fallback path.
      return { stdout: PLAIN_JSONL, stderr: '', exitCode: 0 }
    })
    const adapter = codexCliAdapter({ runner })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.text).toBe('hi')
    expect(result.model).toBe('gpt-6-sol')
    expect(result.finishReason).toBe('stop')
    expect(result.providerMetadata).toEqual({
      threadId: '019f435f-4756-7242-98ab-d536aa30e739',
    })
  })

  it('prefers the -o tmpfile content over the JSONL fallback when present', async () => {
    const { runner } = makeFakeRunner(async (call) => {
      await writeFile(
        call.args[call.args.indexOf('-o') + 1] as string,
        'from the -o file',
        'utf-8',
      )
      return { stdout: PLAIN_JSONL, stderr: '', exitCode: 0 }
    })
    const adapter = codexCliAdapter({ runner })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.text).toBe('from the -o file')
  })
})

// ---------------------------------------------------------------------------
// 2. Structured output
// ---------------------------------------------------------------------------

describe('structured output', () => {
  it('parses rawStructured from the -o file the fake runner writes to opts.cwd', async () => {
    const { runner, calls } = makeFakeRunner(async (call) => {
      const outputFlagIndex = call.args.indexOf('-o')
      const outputPath = call.args[outputFlagIndex + 1] as string
      // Simulate what the real CLI would have done: write the -o file into
      // the scratch dir it was given as cwd.
      await writeFile(outputPath, '{"greeting":"hi"}', 'utf-8')
      return { stdout: STRUCTURED_JSONL, stderr: '', exitCode: 0 }
    })
    const adapter = codexCliAdapter({ runner })
    const result = await adapter.run(
      makeResolvedReq({
        outputJsonSchema: {
          type: 'object',
          properties: { greeting: { type: 'string' } },
          required: ['greeting'],
          additionalProperties: false,
        },
      }),
      FAKE_CTX,
    )

    expect(result.rawStructured).toEqual({ greeting: 'hi' })
    expect(result.text).toBe('{"greeting":"hi"}')
    expect(calls[0]?.opts.cwd).toBeDefined()
  })

  it('rejects with bad_request when the caller schema omits top-level additionalProperties:false', async () => {
    const { runner, calls } = makeFakeRunner(async (call) => {
      const outputPath = call.args[call.args.indexOf('-o') + 1] as string
      await writeFile(outputPath, '{"greeting":"hi"}', 'utf-8')
      return { stdout: STRUCTURED_JSONL, stderr: '', exitCode: 0 }
    })
    const adapter = codexCliAdapter({ runner })

    try {
      await adapter.run(
        makeResolvedReq({
          outputJsonSchema: {
            type: 'object',
            properties: { greeting: { type: 'string' } },
            required: ['greeting'],
          },
        }),
        FAKE_CTX,
      )
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('bad_request')
      expect((e as LlmError).retryable).toBe(false)
    }
    expect(calls).toHaveLength(0)
  })

  it('rejects with bad_request when the caller schema sets additionalProperties:true', async () => {
    const { runner, calls } = makeFakeRunner(async (call) => {
      const outputPath = call.args[call.args.indexOf('-o') + 1] as string
      await writeFile(outputPath, '{"greeting":"hi"}', 'utf-8')
      return { stdout: STRUCTURED_JSONL, stderr: '', exitCode: 0 }
    })
    const adapter = codexCliAdapter({ runner })

    await expect(
      adapter.run(
        makeResolvedReq({
          outputJsonSchema: {
            type: 'object',
            properties: { greeting: { type: 'string' } },
            additionalProperties: true,
          },
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({ kind: 'bad_request', retryable: false })
    expect(calls).toHaveLength(0)
  })

  it('passes a schema with explicit additionalProperties:false through byte-identical', async () => {
    let writtenSchema: unknown
    const inputSchema = {
      type: 'object',
      properties: { greeting: { type: 'string' } },
      required: ['greeting'],
      additionalProperties: false,
    }
    const { runner } = makeFakeRunner(async (call) => {
      const schemaFlagIndex = call.args.indexOf('--output-schema')
      const schemaPath = call.args[schemaFlagIndex + 1] as string
      const fs = await import('node:fs/promises')
      writtenSchema = JSON.parse(await fs.readFile(schemaPath, 'utf-8'))
      const outputPath = call.args[call.args.indexOf('-o') + 1] as string
      await fs.writeFile(outputPath, '{"greeting":"hi"}', 'utf-8')
      return { stdout: STRUCTURED_JSONL, stderr: '', exitCode: 0 }
    })
    const adapter = codexCliAdapter({ runner })
    await adapter.run(makeResolvedReq({ outputJsonSchema: inputSchema }), FAKE_CTX)

    expect(writtenSchema).toEqual(inputSchema)
  })

  it('rejects with bad_request when a nested object schema omits additionalProperties:false, and the message includes the JSON path', async () => {
    const { runner, calls } = makeFakeRunner(async (call) => {
      const outputPath = call.args[call.args.indexOf('-o') + 1] as string
      await writeFile(outputPath, '{"greeting":"hi"}', 'utf-8')
      return { stdout: STRUCTURED_JSONL, stderr: '', exitCode: 0 }
    })
    const adapter = codexCliAdapter({ runner })

    try {
      await adapter.run(
        makeResolvedReq({
          outputJsonSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              nested: {
                type: 'object',
                properties: { a: { type: 'string' } },
              },
            },
          },
        }),
        FAKE_CTX,
      )
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('bad_request')
      expect((e as LlmError).retryable).toBe(false)
      expect((e as LlmError).message).toContain('properties.nested')
    }
    expect(calls).toHaveLength(0)
  })

  it('passes a deeply compliant schema (nested objects, array items, tuple items, prefixItems, $defs/definitions, anyOf/oneOf/allOf) through byte-identical', async () => {
    let writtenSchema: unknown
    const inputSchema = {
      type: 'object',
      additionalProperties: false,
      required: [
        'nested',
        'list',
        'tuple',
        'prefixed',
        'variant',
        'variantOne',
        'variantAll',
      ],
      properties: {
        nested: {
          type: 'object',
          additionalProperties: false,
          required: ['a'],
          properties: { a: { type: 'string' } },
        },
        list: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['b'],
            properties: { b: { type: 'number' } },
          },
        },
        tuple: {
          type: 'array',
          items: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['x'],
              properties: { x: { type: 'string' } },
            },
            { type: 'string' },
          ],
        },
        prefixed: {
          type: 'array',
          prefixItems: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['y'],
              properties: { y: { type: 'number' } },
            },
          ],
        },
        variant: {
          anyOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['c'],
              properties: { c: { type: 'string' } },
            },
            { type: 'string' },
          ],
        },
        variantOne: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['d'],
              properties: { d: { type: 'string' } },
            },
            { type: 'number' },
          ],
        },
        variantAll: {
          allOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['e'],
              properties: { e: { type: 'string' } },
            },
          ],
        },
      },
      $defs: {
        Foo: {
          type: 'object',
          additionalProperties: false,
          required: ['z'],
          properties: { z: { type: 'string' } },
        },
      },
      definitions: {
        Bar: {
          type: 'object',
          additionalProperties: false,
          required: ['w'],
          properties: { w: { type: 'string' } },
        },
      },
    }
    const { runner } = makeFakeRunner(async (call) => {
      const schemaFlagIndex = call.args.indexOf('--output-schema')
      const schemaPath = call.args[schemaFlagIndex + 1] as string
      const fs = await import('node:fs/promises')
      writtenSchema = JSON.parse(await fs.readFile(schemaPath, 'utf-8'))
      const outputPath = call.args[call.args.indexOf('-o') + 1] as string
      await fs.writeFile(outputPath, '{"greeting":"hi"}', 'utf-8')
      return { stdout: STRUCTURED_JSONL, stderr: '', exitCode: 0 }
    })
    const adapter = codexCliAdapter({ runner })
    await adapter.run(makeResolvedReq({ outputJsonSchema: inputSchema }), FAKE_CTX)

    expect(writtenSchema).toEqual(inputSchema)
  })

  it('leaves a non-object root schema unaffected (no throw)', async () => {
    const { runner, calls } = makeFakeRunner(async (call) => {
      const outputPath = call.args[call.args.indexOf('-o') + 1] as string
      await writeFile(outputPath, '"hi"', 'utf-8')
      return { stdout: STRUCTURED_JSONL, stderr: '', exitCode: 0 }
    })
    const adapter = codexCliAdapter({ runner })

    await expect(
      adapter.run(makeResolvedReq({ outputJsonSchema: { type: 'string' } }), FAKE_CTX),
    ).resolves.toBeDefined()
    expect(calls).toHaveLength(1)
  })

  it('pushes a warning and leaves rawStructured undefined on unparseable -o content', async () => {
    const { runner } = makeFakeRunner(async (call) => {
      const outputPath = call.args[call.args.indexOf('-o') + 1] as string
      await writeFile(outputPath, 'not json', 'utf-8')
      return { stdout: STRUCTURED_JSONL, stderr: '', exitCode: 0 }
    })
    const adapter = codexCliAdapter({ runner })
    const result = await adapter.run(
      makeResolvedReq({
        outputJsonSchema: { type: 'object', additionalProperties: false },
      }),
      FAKE_CTX,
    )

    expect(result.rawStructured).toBeUndefined()
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.type).toBe('other')
  })
})

// ---------------------------------------------------------------------------
// 3. Usage mapping — GROSS convention
// ---------------------------------------------------------------------------

describe('usage mapping', () => {
  it('treats reasoning_output_tokens as a SUBSET of output_tokens (not additive)', async () => {
    const { runner } = makeFakeRunner(async () => ({
      stdout: PLAIN_JSONL,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.usage.inputTokens).toBe(14927)
    expect(result.usage.outputTokens).toBe(27)
    expect(result.usage.cachedInputTokens).toBe(4480)
    expect(result.usage.thinkingTokens).toBe(20)
    expect(result.usage.totalTokens).toBe(14954)
    expect(result.usage.details).toEqual({
      input: 14927,
      output: 27,
      cached: 4480,
      thinking: 20,
      total: 14954,
    })
    expect(result.usage.raw).toEqual({
      input_tokens: 14927,
      cached_input_tokens: 4480,
      output_tokens: 27,
      reasoning_output_tokens: 20,
    })
  })
})

// ---------------------------------------------------------------------------
// 4. Argv construction
// ---------------------------------------------------------------------------

describe('argv construction', () => {
  it('builds the exact ordered argv for a plain call', async () => {
    const { runner, calls } = makeFakeRunner(async () => ({
      stdout: PLAIN_JSONL,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })
    await adapter.run(makeResolvedReq(), FAKE_CTX)

    const cwd = calls[0]?.opts.cwd
    expect(cwd).toBeDefined()
    expect(calls[0]?.args).toEqual([
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      '--strict-config',
      '-C',
      cwd,
      '-c',
      'approval_policy=never',
      '--color',
      'never',
      '-m',
      'gpt-6-sol',
      '-o',
      join(cwd!, 'output.json'),
      '-',
    ])
    // The prompt is on stdin, never in argv (a large one would hit E2BIG).
    expect(calls[0]?.input).toBe('Say exactly: hi')
  })

  it('passes -C <scratchDir> matching the runner cwd', async () => {
    const { runner, calls } = makeFakeRunner(async () => ({
      stdout: PLAIN_JSONL,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })
    await adapter.run(makeResolvedReq(), FAKE_CTX)

    const call = calls[0]
    expect(call).toBeDefined()
    const cIndex = call?.args.indexOf('-C') ?? -1
    expect(cIndex).toBeGreaterThanOrEqual(0)
    expect(call?.args[cIndex + 1]).toBe(call?.opts.cwd)
  })

  it('interleaves -m <model>, effort, --output-schema and -o correctly', async () => {
    const { runner, calls } = makeFakeRunner(async (call) => {
      const outputPath = call.args[call.args.indexOf('-o') + 1] as string
      await writeFile(outputPath, '{"greeting":"hi"}', 'utf-8')
      return { stdout: STRUCTURED_JSONL, stderr: '', exitCode: 0 }
    })
    const adapter = codexCliAdapter({ runner })
    await adapter.run(
      makeResolvedReq({
        config: { reasoning: { effort: 'max' } },
        outputJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
      }),
      FAKE_CTX,
    )

    const args = calls[0]?.args ?? []
    const mIndex = args.indexOf('-m')
    expect(args[mIndex + 1]).toBe('gpt-6-sol')
    expect(args).toContain('model_reasoning_effort=max')
    expect(args).toContain('--output-schema')
    expect(args).toContain('-o')
    // The final positional argument is `-` (read the prompt from stdin).
    expect(args[args.length - 1]).toBe('-')
    expect(calls[0]?.input).toBe('Say exactly: hi')
  })

  it('omits -c model_reasoning_effort when reasoning.effort is unset', async () => {
    const { runner, calls } = makeFakeRunner(async () => ({
      stdout: PLAIN_JSONL,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })
    await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(calls[0]?.args.some((a) => a.startsWith('model_reasoning_effort='))).toBe(
      false,
    )
  })

  it('sends the prompt on stdin and keeps it out of argv, however large', async () => {
    const { runner, calls } = makeFakeRunner(async () => ({
      stdout: PLAIN_JSONL,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })
    const big = 'x'.repeat(300_000)
    await adapter.run(
      makeResolvedReq({
        messages: [{ role: 'user', parts: [{ kind: 'text', text: big }] }],
      }),
      FAKE_CTX,
    )

    expect(calls[0]?.input).toBe(big)
    expect(calls[0]?.args.some((arg) => arg.length > 1000)).toBe(false)
    expect(calls[0]?.args.at(-1)).toBe('-')
  })
})

// ---------------------------------------------------------------------------
// 5. System preamble folding
// ---------------------------------------------------------------------------

describe('<system> preamble folding', () => {
  it('folds req.system into a <system>...</system> preamble ahead of the prompt', async () => {
    const { runner, calls } = makeFakeRunner(async () => ({
      stdout: PLAIN_JSONL,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })
    await adapter.run(
      makeResolvedReq({ system: 'You are a helpful assistant.' }),
      FAKE_CTX,
    )

    expect(calls[0]?.input).toBe(
      '<system>\nYou are a helpful assistant.\n</system>\n\nSay exactly: hi',
    )
  })
})

// ---------------------------------------------------------------------------
// 6. Multi-message transcript serialization
// ---------------------------------------------------------------------------

describe('multi-message transcript serialization', () => {
  it('renders role-labelled User:/Assistant: blocks for multi-message transcripts', async () => {
    const { runner, calls } = makeFakeRunner(async () => ({
      stdout: PLAIN_JSONL,
      stderr: '',
      exitCode: 0,
    }))
    const messages: Message[] = [
      { role: 'user', parts: [{ kind: 'text', text: 'first' }] },
      { role: 'assistant', parts: [{ kind: 'text', text: 'second' }] },
      { role: 'user', parts: [{ kind: 'text', text: 'third' }] },
    ]
    const adapter = codexCliAdapter({ runner })
    await adapter.run(makeResolvedReq({ messages }), FAKE_CTX)

    expect(calls[0]?.input).toBe('User:\nfirst\n\nAssistant:\nsecond\n\nUser:\nthird')
  })
})

// ---------------------------------------------------------------------------
// 7. Non-text parts
// ---------------------------------------------------------------------------

describe('non-text parts', () => {
  it('throws bad_request before invoking the runner', async () => {
    const { runner, calls } = makeFakeRunner(async () => ({
      stdout: PLAIN_JSONL,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })
    const messages: Message[] = [
      {
        role: 'user',
        parts: [{ kind: 'inline-media', mimeType: 'image/png', data: 'AAAA' }],
      },
    ]

    await expect(adapter.run(makeResolvedReq({ messages }), FAKE_CTX)).rejects.toThrow(
      LlmError,
    )
    try {
      await adapter.run(makeResolvedReq({ messages }), FAKE_CTX)
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('bad_request')
      expect((e as LlmError).retryable).toBe(false)
    }
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 8. ENOENT
// ---------------------------------------------------------------------------

describe('ENOENT', () => {
  it('maps a spawn ENOENT to kind:"unknown", retryable:false', async () => {
    const { runner } = makeFakeRunner(async () => {
      const err = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })
      throw err
    })
    const adapter = codexCliAdapter({ runner })

    try {
      await adapter.run(makeResolvedReq(), FAKE_CTX)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('unknown')
      expect((e as LlmError).retryable).toBe(false)
      expect((e as LlmError).message).toContain('codex login')
    }
  })
})

// ---------------------------------------------------------------------------
// 9. turn.failed / top-level error envelope classification
// ---------------------------------------------------------------------------

describe('fatal stream error classification', () => {
  it('classifies the captured 400 schema error as bad_request, non-retryable', async () => {
    const { runner } = makeFakeRunner(async () => ({
      stdout: TURN_FAILED_JSONL,
      stderr: '',
      exitCode: 1,
    }))
    const adapter = codexCliAdapter({ runner })

    try {
      await adapter.run(makeResolvedReq(), FAKE_CTX)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('bad_request')
      expect((e as LlmError).retryable).toBe(false)
      expect((e as LlmError).httpStatus).toBe(400)
    }
  })

  it('does NOT treat an item.completed error item as fatal', async () => {
    const { runner } = makeFakeRunner(async () => ({
      stdout: PLAIN_JSONL,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)
    expect(result.text).toBe('hi')
  })

  it('classifies a rate-limit-text non-JSON top-level error as rate_limited, retryable', async () => {
    const stream = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"error","message":"Error: rate limit exceeded, please retry later"}',
    ].join('\n')
    const { runner } = makeFakeRunner(async () => ({
      stdout: stream,
      stderr: '',
      exitCode: 1,
    }))
    const adapter = codexCliAdapter({ runner })

    try {
      await adapter.run(makeResolvedReq(), FAKE_CTX)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('rate_limited')
      expect((e as LlmError).retryable).toBe(true)
    }
  })

  it('classifies an auth-text non-JSON top-level error as invalid_auth, non-retryable', async () => {
    const stream = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"error","message":"Not logged in — run codex login to authenticate"}',
    ].join('\n')
    const { runner } = makeFakeRunner(async () => ({
      stdout: stream,
      stderr: '',
      exitCode: 1,
    }))
    const adapter = codexCliAdapter({ runner })

    try {
      await adapter.run(makeResolvedReq(), FAKE_CTX)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('invalid_auth')
      expect((e as LlmError).retryable).toBe(false)
    }
  })

  it('falls back to a non-retryable "server" bucket for an unclassifiable error message', async () => {
    const stream = [
      '{"type":"thread.started","thread_id":"abc"}',
      '{"type":"error","message":"totally unexpected gremlin"}',
    ].join('\n')
    const { runner } = makeFakeRunner(async () => ({
      stdout: stream,
      stderr: '',
      exitCode: 1,
    }))
    const adapter = codexCliAdapter({ runner })

    try {
      await adapter.run(makeResolvedReq(), FAKE_CTX)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('server')
      expect((e as LlmError).retryable).toBe(false)
    }
  })

  it('falls back to the generic server bucket on a non-zero exit with no parseable JSONL error line', async () => {
    const { runner } = makeFakeRunner(async () => ({
      stdout: 'not jsonl at all',
      stderr: 'boom: something broke',
      exitCode: 1,
    }))
    const adapter = codexCliAdapter({ runner })

    try {
      await adapter.run(makeResolvedReq(), FAKE_CTX)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('server')
      expect((e as LlmError).retryable).toBe(false)
      expect((e as LlmError).message).toContain('boom: something broke')
    }
  })
})

// ---------------------------------------------------------------------------
// 9b. False success on empty/truncated/malformed JSONL (exitCode 0)
// ---------------------------------------------------------------------------

describe('false success on empty/truncated/malformed JSONL', () => {
  it('throws kind:"server" on empty stdout with exitCode 0', async () => {
    const { runner } = makeFakeRunner(async () => ({
      stdout: '',
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })

    try {
      await adapter.run(makeResolvedReq(), FAKE_CTX)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('server')
      expect((e as LlmError).retryable).toBe(false)
    }
  })

  it('throws kind:"server" on a truncated stream with only thread.started (no turn.completed, no text)', async () => {
    const { runner } = makeFakeRunner(async () => ({
      stdout:
        '{"type":"thread.started","thread_id":"019f435f-0000-0000-0000-000000000abc"}',
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })

    try {
      await adapter.run(makeResolvedReq(), FAKE_CTX)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('server')
      expect((e as LlmError).retryable).toBe(false)
      expect((e as LlmError).message).toContain('codex completed without a final message')
    }
  })

  it('succeeds with a warning when malformed lines are interleaved with a valid, complete turn', async () => {
    const stream = [
      'not json at all',
      '{"type":"thread.started","thread_id":"019f435f-4756-7242-98ab-d536aa30e739"}',
      '{this is also not valid json}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"hi"}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}',
    ].join('\n')
    const { runner } = makeFakeRunner(async () => ({
      stdout: stream,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.text).toBe('hi')
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(5)
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        type: 'other',
        message: expect.stringContaining('malformed') as unknown as string,
      }),
    )
  })

  it('succeeds with a warning when turn.completed carries no usage but final text is present', async () => {
    const stream = [
      '{"type":"thread.started","thread_id":"019f435f-4756-7242-98ab-d536aa30e739"}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"hi"}}',
      '{"type":"turn.completed"}',
    ].join('\n')
    const { runner } = makeFakeRunner(async () => ({
      stdout: stream,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.text).toBe('hi')
    expect(result.usage.inputTokens).toBe(0)
    expect(result.usage.totalTokens).toBeUndefined()
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        type: 'other',
        message: expect.stringContaining('usage') as unknown as string,
      }),
    )
  })

  it('throws kind:"server" when turn.completed is present but no -o file and no agent_message text exist', async () => {
    const stream = [
      '{"type":"thread.started","thread_id":"019f435f-4756-7242-98ab-d536aa30e739"}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":0}}',
    ].join('\n')
    const { runner } = makeFakeRunner(async () => ({
      stdout: stream,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })

    try {
      await adapter.run(makeResolvedReq(), FAKE_CTX)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('server')
      expect((e as LlmError).retryable).toBe(false)
      expect((e as LlmError).message).toContain('codex completed without a final message')
    }
  })

  it('succeeds (does not throw) when the final agent_message text is an empty string', async () => {
    const stream = [
      '{"type":"thread.started","thread_id":"019f435f-4756-7242-98ab-d536aa30e739"}',
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":""}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":0}}',
    ].join('\n')
    const { runner } = makeFakeRunner(async () => ({
      stdout: stream,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(result.text).toBeUndefined()
    expect(result.finishReason).toBe('stop')
  })
})

// ---------------------------------------------------------------------------
// 10. Timeout
// ---------------------------------------------------------------------------

describe('timeout', () => {
  it('throws kind:"timeout", retryable:true when the runner reports a timeout', async () => {
    // The runner now owns timeout enforcement end-to-end (it only settles
    // once the simulated child has "closed") — the adapter no longer races
    // an independent timer, so the fake must itself honor opts.timeoutMs
    // and reject with a TimeoutError-named Error, mirroring the real
    // runner's contract.
    const { runner } = makeFakeRunner(
      (call) =>
        new Promise<CodexCliRunResult>((_resolve, reject) => {
          setTimeout(() => {
            const err = new Error(
              `codex-cli call exceeded ${call.opts.timeoutMs}ms timeout`,
            )
            err.name = 'TimeoutError'
            reject(err)
          }, call.opts.timeoutMs)
        }),
    )
    const adapter = codexCliAdapter({ runner })

    try {
      await adapter.run(makeResolvedReq({ config: { timeoutMs: 10 } }), FAKE_CTX)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('timeout')
      expect((e as LlmError).retryable).toBe(true)
    }
  })

  it('forwards timeoutMs to the runner opts', async () => {
    const { runner, calls } = makeFakeRunner(async () => ({
      stdout: PLAIN_JSONL,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })
    await adapter.run(makeResolvedReq({ config: { timeoutMs: 5000 } }), FAKE_CTX)

    expect(calls[0]?.opts.timeoutMs).toBe(5000)
  })

  it('prefers attemptTimeoutMs over config.timeoutMs', async () => {
    const { runner, calls } = makeFakeRunner(async () => ({
      stdout: PLAIN_JSONL,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })
    await adapter.run(
      makeResolvedReq({ config: { timeoutMs: 5000 }, attemptTimeoutMs: 1234 }),
      FAKE_CTX,
    )

    expect(calls[0]?.opts.timeoutMs).toBe(1234)
  })
})

// ---------------------------------------------------------------------------
// 11. AbortSignal
// ---------------------------------------------------------------------------

describe('AbortSignal', () => {
  it('maps a runner AbortError to kind:"aborted"', async () => {
    const { runner } = makeFakeRunner(async () => {
      const err = new DOMException('aborted', 'AbortError')
      throw err
    })
    const adapter = codexCliAdapter({ runner })
    const controller = new AbortController()
    controller.abort()

    try {
      await adapter.run(makeResolvedReq({ signal: controller.signal }), FAKE_CTX)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('aborted')
    }
  })
})

// ---------------------------------------------------------------------------
// 11b. Timeout/abort lifecycle — semaphore + scratch dir vs runner settlement
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
        return new Promise<CodexCliRunResult>((_resolve, reject) => {
          rejectFirst = reject
        })
      }
      return { stdout: PLAIN_JSONL, stderr: '', exitCode: 0 }
    })
    const adapter = codexCliAdapter({ runner, maxConcurrency: 1 })

    const firstPromise = adapter
      .run(makeResolvedReq({ config: { timeoutMs: 10 } }), FAKE_CTX)
      .catch((e: unknown) => e)
    await vi.waitFor(() => expect(capturedCwd).toBeDefined())

    // A second call queues behind maxConcurrency:1 — it must NOT start
    // while the first call's runner promise is still pending, even though
    // the (simulated) timeout has long since fired on the caller side.
    let secondStarted = false
    const secondPromise = adapter.run(makeResolvedReq(), FAKE_CTX).then((r) => {
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
    const timeoutErr = new Error('codex-cli call exceeded 10ms timeout')
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
        new Promise<CodexCliRunResult>((_resolve, reject) => {
          active += 1
          maxActive = Math.max(maxActive, active)
          setTimeout(() => {
            active -= 1
            const err = new Error('codex-cli call exceeded 10ms timeout')
            err.name = 'TimeoutError'
            reject(err)
          }, 15)
        }),
    )
    const adapter = codexCliAdapter({ runner, maxConcurrency: 2 })

    const results = await Promise.allSettled([
      adapter.run(makeResolvedReq({ config: { timeoutMs: 10 } }), FAKE_CTX),
      adapter.run(makeResolvedReq({ config: { timeoutMs: 10 } }), FAKE_CTX),
      adapter.run(makeResolvedReq({ config: { timeoutMs: 10 } }), FAKE_CTX),
    ])

    expect(maxActive).toBeLessThanOrEqual(2)
    for (const r of results) {
      expect(r.status).toBe('rejected')
    }
  })
})

// ---------------------------------------------------------------------------
// 12. Concurrency semaphore
// ---------------------------------------------------------------------------

describe('concurrency semaphore', () => {
  it('limits concurrent runner.run calls to maxConcurrency, ordering releases', async () => {
    const order: string[] = []
    let active = 0
    let maxActive = 0
    const { runner } = makeFakeRunner(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      order.push('start')
      await new Promise((r) => setTimeout(r, 10))
      active -= 1
      order.push('end')
      return { stdout: PLAIN_JSONL, stderr: '', exitCode: 0 }
    })
    const adapter = codexCliAdapter({ runner, maxConcurrency: 2 })

    await Promise.all([
      adapter.run(makeResolvedReq(), FAKE_CTX),
      adapter.run(makeResolvedReq(), FAKE_CTX),
      adapter.run(makeResolvedReq(), FAKE_CTX),
      adapter.run(makeResolvedReq(), FAKE_CTX),
    ])

    expect(maxActive).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// 13. Scratch-dir cwd / -C consistency
// ---------------------------------------------------------------------------

describe('scratch dir consistency', () => {
  it('the runner cwd and -C argv value are the same path, and are cleaned up after', async () => {
    let capturedCwd: string | undefined
    const { runner } = makeFakeRunner(async (call) => {
      capturedCwd = call.opts.cwd
      return { stdout: PLAIN_JSONL, stderr: '', exitCode: 0 }
    })
    const adapter = codexCliAdapter({ runner })
    await adapter.run(makeResolvedReq(), FAKE_CTX)

    expect(capturedCwd).toBeDefined()
    const fs = await import('node:fs/promises')
    await expect(fs.access(capturedCwd as string)).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 14. Auth
// ---------------------------------------------------------------------------

describe('auth', () => {
  it('throws invalid_auth for apiKey auth material', async () => {
    const { runner } = makeFakeRunner(async () => ({
      stdout: PLAIN_JSONL,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })

    try {
      await adapter.run(makeResolvedReq(), {
        auth: { apiKey: 'sk-not-a-cli-session' },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(LlmError)
      expect((e as LlmError).kind).toBe('invalid_auth')
      expect((e as LlmError).retryable).toBe(false)
    }
  })

  it('accepts { cliSession: true }', async () => {
    const { runner } = makeFakeRunner(async () => ({
      stdout: PLAIN_JSONL,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })
    const result = await adapter.run(makeResolvedReq(), FAKE_CTX)
    expect(result.text).toBe('hi')
  })
})

describe('function-calling seam reject', () => {
  it('rejects LlmRequest.tools', async () => {
    const { runner } = makeFakeRunner(async () => ({
      stdout: PLAIN_JSONL,
      stderr: '',
      exitCode: 0,
    }))
    const adapter = codexCliAdapter({ runner })
    await expect(
      adapter.run(
        makeResolvedReq({
          tools: [{ name: 'f', description: 'd', inputJsonSchema: { type: 'object' } }],
        }),
        FAKE_CTX,
      ),
    ).rejects.toMatchObject({
      kind: 'bad_request',
      message: expect.stringContaining('tools'),
    })
  })
})
