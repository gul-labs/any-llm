import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'
import type { Message, Part } from '@gullabs/core'
import {
  dropMessagesFromSignatureState,
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

  it('maps "messageIndex:partIndex" to the signature and keeps the verified entries', () => {
    const entry = signatureEntry(1, 0, 'm', messages[1]!.parts[0]!, 'c2ln')
    const resolved = resolveSignatures([entry], messages, 'm')
    expect(resolved.bySlot.get('1:0')).toBe('c2ln')
    expect(resolved.kept).toEqual([entry])
    expect(resolved.dropped).toEqual([])
  })

  it('rejects a function-call entry whose part is now a kind Google does not sign', () => {
    const withMedia: Message[] = [
      {
        role: 'assistant',
        parts: [{ kind: 'inline-media', mimeType: 'image/png', data: 'AA==' }],
      },
    ]
    for (const kind of ['tool-call', 'text'] as const) {
      const entry = {
        messageIndex: 0,
        partIndex: 0,
        kind,
        model: 'm',
        partSha256: 'a'.repeat(64),
        signature: 's',
      }
      if (kind === 'tool-call') {
        expect(() => resolveSignatures([entry], withMedia, 'm')).toThrow(
          /is for a "tool-call" part but messages.0.parts.0 is a "inline-media" part/,
        )
      } else {
        // A stale text entry is dropped, never fatal.
        expect(resolveSignatures([entry], withMedia, 'm').dropped).toHaveLength(1)
      }
    }
  })

  it('reports the offending state path on every function-call failure', () => {
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

  describe('a stale text entry is dropped, a stale function-call entry is fatal', () => {
    const history: Message[] = [
      { role: 'user', parts: [{ kind: 'text', text: 'q' }] },
      {
        role: 'assistant',
        parts: [
          { kind: 'text', text: 'checking' },
          { kind: 'tool-call', toolCallId: 'c1', toolName: 'get', args: { a: 1 } },
        ],
      },
    ]
    const textEntry = signatureEntry(1, 0, 'm', history[1]!.parts[0]!, 'text-sig')
    const callEntry = signatureEntry(1, 1, 'm', history[1]!.parts[1]!, 'call-sig')

    // A text-only turn, so the only entry in play is the optional one.
    const textTurn: Message[] = [
      history[0]!,
      {
        role: 'assistant',
        parts: [
          { kind: 'text', text: 'checking' },
          { kind: 'text', text: 'second part' },
        ],
      },
    ]
    const textOnly = signatureEntry(1, 0, 'm', textTurn[1]!.parts[0]!, 'text-sig')

    it.each<[string, (m: Message[]) => Message[], string]>([
      [
        'edited',
        (m) => [
          m[0]!,
          {
            role: 'assistant',
            parts: [{ kind: 'text', text: 'checking!' }, m[1]!.parts[1]!],
          },
        ],
        'does not match',
      ],
      [
        'moved',
        (m) => [m[0]!, { role: 'assistant', parts: [m[1]!.parts[1]!, m[1]!.parts[0]!] }],
        'does not match',
      ],
      [
        'removed (the message is gone)',
        (m) => [m[0]!, { role: 'user', parts: [{ kind: 'text', text: 'x' }] }],
        'does not point at an assistant message',
      ],
    ])('a text entry that is %s is dropped, never fatal', (_l, mutate, why) => {
      const resolved = resolveSignatures([textOnly], mutate(textTurn), 'm')
      expect(resolved.dropped).toHaveLength(1)
      expect(resolved.dropped[0]).toContain(why)
      expect(resolved.kept).toEqual([])
    })

    it('the call entry beside a stale text entry still verifies', () => {
      const edited = clone(history)
      ;(edited[1]!.parts[0] as { text: string }).text = 'checking!'
      const resolved = resolveSignatures([textEntry, callEntry], edited, 'm')
      expect(resolved.dropped).toHaveLength(1)
      expect(resolved.kept).toEqual([callEntry])
      expect(resolved.bySlot.get('1:1')).toBe('call-sig')
    })

    it('a call entry whose message is removed or whose part moved is fatal', () => {
      const moved: Message[] = [
        history[0]!,
        { role: 'assistant', parts: [history[1]!.parts[1]!, history[1]!.parts[0]!] },
      ]
      expect(() => resolveSignatures([callEntry], moved, 'm')).toThrow(
        /is for a "tool-call" part/,
      )
      expect(() =>
        resolveSignatures([callEntry], [history[0]!, history[0]!], 'm'),
      ).toThrow(/does not point at an assistant message/)
    })

    it('a text entry issued for another model is dropped; the call entry for another model is fatal', () => {
      const other = { ...textEntry, model: 'other' }
      const resolved = resolveSignatures([other, callEntry], history, 'm')
      expect(resolved.dropped[0]).toContain('not replayed across models')
      expect(resolved.kept).toEqual([callEntry])
      expect(() =>
        resolveSignatures([{ ...callEntry, model: 'other' }], history, 'm'),
      ).toThrow(/not replayed across models/)
    })

    it('an edited call argument is fatal', () => {
      const edited = clone(history)
      ;(edited[1]!.parts[1] as { args: object }).args = { a: 2 }
      expect(() => resolveSignatures([callEntry], edited, 'm')).toThrow(
        /does not match messages.1.parts.1/,
      )
    })

    it('a duplicate slot is fatal even for text', () => {
      expect(() => resolveSignatures([textEntry, textEntry], history, 'm')).toThrow(
        /duplicates the entry/,
      )
    })

    it('a host part outside the JSON domain is rejected while verifying, never silently dropped', () => {
      const bad = clone(history)
      ;(bad[1]!.parts[0] as { text: string }).text = 'oops \ud83d'
      expect(() => resolveSignatures([textEntry], bad, 'm')).toThrow(/lone surrogate/)
    })
  })
})

describe('dropMessagesFromSignatureState', () => {
  const entry = (messageIndex: number, partIndex = 0) => ({
    messageIndex,
    partIndex,
    kind: 'tool-call' as const,
    model: 'm',
    partSha256: 'a'.repeat(64),
    signature: `s${messageIndex}.${partIndex}`,
  })
  const state = { google: { signatures: [entry(1), entry(3), entry(3, 1), entry(5)] } }
  /** The same entry, now pointing at `messageIndex` (signature unchanged). */
  const moved = (e: ReturnType<typeof entry>, messageIndex: number) => ({
    ...e,
    messageIndex,
  })

  it('removes the entries of removed messages and shifts later indices down', () => {
    expect(dropMessagesFromSignatureState(state, [0, 1, 2])).toEqual({
      google: {
        signatures: [moved(entry(3), 0), moved(entry(3, 1), 0), moved(entry(5), 2)],
      },
    })
    // A rewind: the tail is dropped.
    expect(dropMessagesFromSignatureState(state, [4, 5, 6])).toEqual({
      google: { signatures: [entry(1), entry(3), entry(3, 1)] },
    })
    // The order of the indices does not matter.
    expect(dropMessagesFromSignatureState(state, [2, 0, 1])).toEqual(
      dropMessagesFromSignatureState(state, [0, 1, 2]),
    )
  })

  it('returns undefined when nothing is left, and does not mutate the input', () => {
    const before = JSON.stringify(state)
    expect(dropMessagesFromSignatureState(state, [1, 3, 5])).toBeUndefined()
    expect(dropMessagesFromSignatureState(undefined, [0])).toBeUndefined()
    expect(JSON.stringify(state)).toBe(before)
  })

  it('removing nothing returns an equal state', () => {
    expect(dropMessagesFromSignatureState(state, [])).toEqual(state)
  })

  it('rejects bad indices and a malformed state with bad_request', () => {
    expect(() => dropMessagesFromSignatureState(state, [-1])).toThrow(LlmError)
    expect(() => dropMessagesFromSignatureState(state, [1.5])).toThrow(LlmError)
    expect(() => dropMessagesFromSignatureState(state, [1, 1])).toThrow(
      /repeats message 1/,
    )
    expect(() => dropMessagesFromSignatureState({ xai: {} }, [0])).toThrow(LlmError)
  })
})

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
