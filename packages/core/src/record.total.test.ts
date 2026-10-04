/**
 * buildRecord is total over the JSON lanes of a record: hostile host input
 * (and provider JSON) is replaced by markers with a warning, never thrown.
 */

import { describe, expect, it } from 'vitest'
import { buildRecord } from './record.js'
import type { BuildRecordInput } from './record.js'
import type { JsonValue } from './types.js'

function input(overrides: Partial<BuildRecordInput> = {}): BuildRecordInput {
  return {
    callId: 'c',
    attemptId: 'a',
    attemptNumber: 1,
    provider: 'p',
    model: 'm',
    usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
    latencyMs: 1,
    status: 'ok',
    generationConfig: {},
    metadata: {},
    createdAt: '2026-10-03T00:00:00.000Z',
    ...overrides,
  }
}

const messages = (record: ReturnType<typeof buildRecord>): string[] =>
  ((record.warnings ?? []) as unknown as Array<{ message: string }>).map((w) => w.message)

describe('buildRecord totality', () => {
  it('a circular metadata object becomes a marker and a warning', () => {
    const metadata: Record<string, unknown> = { keep: 1 }
    metadata['loop'] = { back: metadata }
    const record = buildRecord(input({ metadata: metadata as JsonValue }))
    expect(record.metadata).toEqual({ keep: 1, loop: { back: '[circular]' } })
    expect(messages(record).join('\n')).toContain('circular reference')
    expect(() => JSON.stringify(record)).not.toThrow()
  })

  it('nesting past 64 levels is cut', () => {
    let node: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < 200; i += 1) node = { n: node }
    const record = buildRecord(input({ metadata: node as JsonValue }))
    expect(JSON.stringify(record.metadata)).toContain('[too deep]')
    expect(messages(record).join('\n')).toContain('deeper than 64 levels')
  })

  it('a value count past the cap is cut', () => {
    const wide = Array.from({ length: 150_000 }, (_, i) => ({ i }))
    const record = buildRecord(input({ metadata: { wide } as JsonValue }))
    expect(messages(record).join('\n')).toContain('more than 100000 values')
  })

  it('a throwing getter, a throwing toJSON, a bigint and a function are markers', () => {
    const metadata = {
      ok: 1,
      big: 10n,
      fn: () => 1,
      toJsonThrows: {
        toJSON() {
          throw new Error('nope')
        },
      },
    } as unknown as Record<string, unknown>
    Object.defineProperty(metadata, 'getter', {
      enumerable: true,
      get() {
        throw new Error('getter')
      },
    })
    const record = buildRecord(input({ metadata: metadata as JsonValue }))
    expect(record.metadata).toMatchObject({
      ok: 1,
      big: '[unserializable]',
      fn: '[unserializable]',
      toJsonThrows: '[unreadable]',
      getter: '[unreadable]',
    })
    expect(() => JSON.stringify(record)).not.toThrow()
  })

  it('circular providerOptions in the generation config, and circular tool-call args', () => {
    const providerOptions: Record<string, unknown> = { a: 1 }
    providerOptions['self'] = providerOptions
    const args: Record<string, unknown> = { q: 'x' }
    args['self'] = args
    const record = buildRecord(
      input({
        generationConfig: { providerOptions } as never,
        toolCalls: [{ toolCallId: 't', toolName: 'n', args: args as JsonValue }],
      }),
    )
    expect(() => JSON.stringify(record)).not.toThrow()
    expect(messages(record).join('\n')).toContain('generationConfig')
    expect(messages(record).join('\n')).toContain('toolCalls')
  })

  it('ordinary data is returned as the same object with no warning', () => {
    const metadata = { a: { b: [1, 2, { c: 'd' }] } }
    const record = buildRecord(input({ metadata }))
    expect(record.metadata).toBe(metadata)
    expect(record.warnings).toBeUndefined()
  })

  it('a Date in metadata is stored as its JSON form', () => {
    const record = buildRecord(
      input({ metadata: { at: new Date('2026-10-03T00:00:00.000Z') } as never }),
    )
    expect(record.metadata).toEqual({ at: '2026-10-03T00:00:00.000Z' })
    expect(record.warnings).toBeUndefined()
  })
})
