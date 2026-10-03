import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'
import type { Message, Part } from '@gullabs/core'
import {
  parseSignatureState,
  partSha256,
  resolveSignatures,
  signatureEntry,
} from './thought-signatures.js'

const sha = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

describe('partSha256', () => {
  it('hashes the RFC 8785 canonical JSON of a text part', () => {
    expect(partSha256({ kind: 'text', text: 'hi' })).toBe(
      sha('{"kind":"text","text":"hi"}'),
    )
  })

  it('hashes a tool call by id, name and arguments, independent of key order', () => {
    const a: Part = {
      kind: 'tool-call',
      toolCallId: 'c1',
      toolName: 'get',
      args: { b: [1, { y: 2, x: 1 }], a: 'é' },
    }
    const b: Part = {
      kind: 'tool-call',
      toolName: 'get',
      args: { a: 'é', b: [1, { x: 1, y: 2 }] },
      toolCallId: 'c1',
    }
    expect(partSha256(a)).toBe(partSha256(b))
    expect(partSha256(a)).toBe(
      sha(
        '{"args":{"a":"é","b":[1,{"x":1,"y":2}]},"kind":"tool-call","toolCallId":"c1","toolName":"get"}',
      ),
    )
  })

  it('changes when text, an argument, the id or the name changes', () => {
    const base: Part = {
      kind: 'tool-call',
      toolCallId: 'c1',
      toolName: 'get',
      args: { n: 1 },
    }
    const digest = partSha256(base)
    expect(partSha256({ ...base, args: { n: 2 } })).not.toBe(digest)
    expect(partSha256({ ...base, toolCallId: 'c2' })).not.toBe(digest)
    expect(partSha256({ ...base, toolName: 'put' })).not.toBe(digest)
    expect(partSha256({ kind: 'text', text: 'a' })).not.toBe(
      partSha256({ kind: 'text', text: 'b' }),
    )
  })

  it('rejects arguments outside the JSON domain instead of hashing a lossy form', () => {
    expect(() =>
      partSha256({
        kind: 'tool-call',
        toolCallId: 'c',
        toolName: 't',
        args: { n: Number.NaN },
      }),
    ).toThrow(LlmError)
  })

  it('rejects part kinds Google does not sign', () => {
    expect(() =>
      partSha256({ kind: 'inline-media', mimeType: 'image/png', data: 'AA==' }),
    ).toThrow(/cannot be attached to a "inline-media" part/)
  })
})

describe('parseSignatureState', () => {
  it('returns [] for no state', () => {
    expect(parseSignatureState(undefined)).toEqual([])
  })

  it('round-trips an entry built by signatureEntry through JSON', () => {
    const entry = signatureEntry(3, 1, 'm', { kind: 'text', text: 'x' }, 'c2ln')
    const parsed = parseSignatureState(
      JSON.parse(JSON.stringify({ google: { signatures: [entry] } })),
    )
    expect(parsed).toEqual([entry])
  })
})

describe('resolveSignatures', () => {
  const messages: Message[] = [
    { role: 'user', parts: [{ kind: 'text', text: 'q' }] },
    {
      role: 'assistant',
      parts: [{ kind: 'tool-call', toolCallId: 'c1', toolName: 'get', args: {} }],
    },
  ]

  it('maps "messageIndex:partIndex" to the signature', () => {
    const entry = signatureEntry(1, 0, 'm', messages[1]!.parts[0]!, 'c2ln')
    expect(resolveSignatures([entry], messages, 'm').get('1:0')).toBe('c2ln')
  })

  it('rejects an entry on a part kind Google does not sign', () => {
    const withMedia: Message[] = [
      {
        role: 'assistant',
        parts: [{ kind: 'inline-media', mimeType: 'image/png', data: 'AA==' }],
      },
    ]
    expect(() =>
      resolveSignatures(
        [
          {
            messageIndex: 0,
            partIndex: 0,
            model: 'm',
            partSha256: 'a'.repeat(64),
            signature: 's',
          },
        ],
        withMedia,
        'm',
      ),
    ).toThrow(/cannot be attached/)
  })

  it('reports the offending state path on every failure', () => {
    const entry = signatureEntry(1, 0, 'other', messages[1]!.parts[0]!, 'c2ln')
    try {
      resolveSignatures([entry], messages, 'm')
      expect.unreachable()
    } catch (error) {
      expect((error as LlmError).issues?.[0]?.path).toBe(
        'transientProviderState.google.signatures.0.model',
      )
    }
  })
})
