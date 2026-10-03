/**
 * geminiContentToMessages — unit tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import type { Content } from '@google/genai'
import { LlmError } from '@gullabs/core'
import { geminiContentToMessages } from './content-to-messages.js'
import { partSha256 } from './thought-signatures.js'

describe('geminiContentToMessages: role mapping', () => {
  it('maps role "user" → "user"', () => {
    const { messages } = geminiContentToMessages({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    })
    expect(messages).toEqual([{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }])
  })

  it('maps role "model" → "assistant"', () => {
    const { messages } = geminiContentToMessages({
      contents: [{ role: 'model', parts: [{ text: 'hi' }] }],
    })
    expect(messages).toEqual([
      { role: 'assistant', parts: [{ kind: 'text', text: 'hi' }] },
    ])
  })

  it('throws bad_request naming the role for an unrecognized role', () => {
    const contents = [{ role: 'system', parts: [{ text: 'hi' }] }] as unknown as Content[]
    try {
      geminiContentToMessages({ contents })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).retryable).toBe(false)
      expect((err as LlmError).message).toContain('system')
    }
  })

  it('throws bad_request naming the role when role is missing (no inference)', () => {
    const contents = [{ parts: [{ text: 'hi' }] }] as unknown as Content[]
    expect(() => geminiContentToMessages({ contents })).toThrow(LlmError)
    try {
      geminiContentToMessages({ contents })
      expect.unreachable()
    } catch (err) {
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).message).toContain('undefined')
    }
  })
})

describe('geminiContentToMessages: supported part kinds', () => {
  it('maps a text part', () => {
    const { messages } = geminiContentToMessages({
      contents: [{ role: 'user', parts: [{ text: 'hello world' }] }],
    })
    expect(messages).toEqual([
      { role: 'user', parts: [{ kind: 'text', text: 'hello world' }] },
    ])
  })

  it('maps an inlineData part', () => {
    const { messages } = geminiContentToMessages({
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }],
        },
      ],
    })
    expect(messages).toEqual([
      {
        role: 'user',
        parts: [{ kind: 'inline-media', mimeType: 'image/png', data: 'YWJj' }],
      },
    ])
  })

  it('maps a fileData part', () => {
    const { messages } = geminiContentToMessages({
      contents: [
        {
          role: 'user',
          parts: [
            {
              fileData: {
                mimeType: 'video/mp4',
                fileUri: 'https://files.example.com/v.mp4',
              },
            },
          ],
        },
      ],
    })
    expect(messages).toEqual([
      {
        role: 'user',
        parts: [
          {
            kind: 'file-uri',
            uri: 'https://files.example.com/v.mp4',
            mimeType: 'video/mp4',
          },
        ],
      },
    ])
  })

  it('maps mediaResolution.level LOW on inlineData', () => {
    const { messages } = geminiContentToMessages({
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: { mimeType: 'image/png', data: 'YWJj' },
              mediaResolution: { level: 'MEDIA_RESOLUTION_LOW' as never },
            },
          ],
        },
      ],
    })
    expect(messages[0]?.parts[0]).toEqual({
      kind: 'inline-media',
      mimeType: 'image/png',
      data: 'YWJj',
      mediaResolution: 'low',
    })
  })

  it('maps mediaResolution.level MEDIUM on fileData', () => {
    const { messages } = geminiContentToMessages({
      contents: [
        {
          role: 'user',
          parts: [
            {
              fileData: { mimeType: 'image/png', fileUri: 'https://f/x.png' },
              mediaResolution: { level: 'MEDIA_RESOLUTION_MEDIUM' as never },
            },
          ],
        },
      ],
    })
    expect(messages[0]?.parts[0]).toEqual({
      kind: 'file-uri',
      uri: 'https://f/x.png',
      mimeType: 'image/png',
      mediaResolution: 'medium',
    })
  })

  it('maps mediaResolution.level HIGH', () => {
    const { messages } = geminiContentToMessages({
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: { mimeType: 'image/png', data: 'YWJj' },
              mediaResolution: { level: 'MEDIA_RESOLUTION_HIGH' as never },
            },
          ],
        },
      ],
    })
    expect(messages[0]?.parts[0]).toEqual({
      kind: 'inline-media',
      mimeType: 'image/png',
      data: 'YWJj',
      mediaResolution: 'high',
    })
  })

  it('throws bad_request on an unknown mediaResolution.level enum value', () => {
    const contents = [
      {
        role: 'user',
        parts: [
          {
            inlineData: { mimeType: 'image/png', data: 'YWJj' },
            mediaResolution: { level: 'MEDIA_RESOLUTION_UNSPECIFIED' },
          },
        ],
      },
    ] as unknown as Content[]
    try {
      geminiContentToMessages({ contents })
      expect.unreachable()
    } catch (err) {
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).message).toContain('MEDIA_RESOLUTION_UNSPECIFIED')
    }
  })

  it('throws bad_request when mediaResolution.numTokens is set', () => {
    const contents = [
      {
        role: 'user',
        parts: [
          {
            inlineData: { mimeType: 'image/png', data: 'YWJj' },
            mediaResolution: { numTokens: 100 },
          },
        ],
      },
    ] as unknown as Content[]
    try {
      geminiContentToMessages({ contents })
      expect.unreachable()
    } catch (err) {
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).message).toContain('numTokens')
    }
  })
})

describe('geminiContentToMessages: function calling parts', () => {
  it('converts functionCall to tool-call', () => {
    const result = geminiContentToMessages({
      contents: [
        {
          role: 'model',
          parts: [{ functionCall: { name: 'get_temp', args: { city: 'SF' } } }],
        },
      ],
    })
    expect(result.messages[0]?.parts[0]).toEqual({
      kind: 'tool-call',
      toolCallId: 'call_get_temp_1',
      toolName: 'get_temp',
      args: { city: 'SF' },
    })
  })

  it('assigns unique suffixes to two id-less same-name functionCalls', () => {
    const result = geminiContentToMessages({
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'lookup', args: { q: '1' } } },
            { functionCall: { name: 'lookup', args: { q: '2' } } },
          ],
        },
      ],
    })
    expect(
      result.messages[0]?.parts.map((p) => (p as { toolCallId?: string }).toolCallId),
    ).toEqual(['call_lookup_1', 'call_lookup_2'])
  })

  it('does not collide fallback with a reserved provider id', () => {
    const result = geminiContentToMessages({
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'call_lookup_1', name: 'lookup', args: { q: '1' } } },
            { functionCall: { name: 'lookup', args: { q: '2' } } },
          ],
        },
      ],
    })
    expect(
      result.messages[0]?.parts.map((p) => (p as { toolCallId?: string }).toolCallId),
    ).toEqual(['call_lookup_1', 'call_lookup_2'])
  })

  it('reserves a later provider id before allocating an earlier fallback', () => {
    const result = geminiContentToMessages({
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { name: 'lookup', args: { q: '1' } } },
            { functionCall: { id: 'call_lookup_1', name: 'lookup', args: { q: '2' } } },
          ],
        },
      ],
    })
    expect(
      result.messages[0]?.parts.map((p) => (p as { toolCallId?: string }).toolCallId),
    ).toEqual(['call_lookup_2', 'call_lookup_1'])
  })

  it('prefers functionCall.id as toolCallId when present', () => {
    const result = geminiContentToMessages({
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'fc_1', name: 'get_temp', args: { city: 'SF' } } },
          ],
        },
      ],
    })
    expect(result.messages[0]?.parts[0]).toEqual({
      kind: 'tool-call',
      toolCallId: 'fc_1',
      toolName: 'get_temp',
      args: { city: 'SF' },
    })
  })

  it('rejects functionCall without a name', () => {
    expect(() =>
      geminiContentToMessages({
        contents: [{ role: 'model', parts: [{ functionCall: { args: {} } }] }],
      }),
    ).toThrow(/functionCall.name/)
  })

  it('rejects functionResponse without a name', () => {
    expect(() =>
      geminiContentToMessages({
        contents: [{ role: 'user', parts: [{ functionResponse: { response: {} } }] }],
      }),
    ).toThrow(/functionResponse.name/)
  })

  it('converts functionResponse to tool-result', () => {
    const result = geminiContentToMessages({
      contents: [
        {
          role: 'user',
          parts: [{ functionResponse: { name: 'get_temp', response: { temp: 59 } } }],
        },
      ],
    })
    expect(result.messages[0]?.parts[0]).toEqual({
      kind: 'tool-result',
      toolCallId: 'call_get_temp_1',
      toolName: 'get_temp',
      result: { temp: 59 },
    })
  })
})

describe('geminiContentToMessages: unsupported part kinds', () => {
  const unsupportedCases: Array<[string, Record<string, unknown>]> = [
    ['executableCode', { executableCode: { code: '1+1', language: 'PYTHON' } }],
    [
      'codeExecutionResult',
      { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '2' } },
    ],
    ['toolCall', { toolCall: {} }],
    ['toolResponse', { toolResponse: {} }],
    ['thought', { text: 'reasoning...', thought: true }],
    [
      'videoMetadata',
      {
        fileData: { mimeType: 'video/mp4', fileUri: 'https://f/v.mp4' },
        videoMetadata: { fps: 1 },
      },
    ],
    ['partMetadata', { text: 'x', partMetadata: { source: 'a' } }],
  ]

  it.each(unsupportedCases)('throws bad_request naming %s', (label, partShape) => {
    const contents = [{ role: 'user', parts: [partShape] }] as unknown as Content[]
    try {
      geminiContentToMessages({ contents })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).retryable).toBe(false)
      expect((err as LlmError).message).toContain(label)
    }
  })

  it('throws bad_request naming inlineData.displayName', () => {
    const contents = [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: 'YWJj', displayName: 'x.png' } },
        ],
      },
    ] as unknown as Content[]
    try {
      geminiContentToMessages({ contents })
      expect.unreachable()
    } catch (err) {
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).message).toContain('displayName')
    }
  })

  it('throws bad_request naming fileData.displayName', () => {
    const contents = [
      {
        role: 'user',
        parts: [
          {
            fileData: {
              mimeType: 'video/mp4',
              fileUri: 'https://f/v.mp4',
              displayName: 'v.mp4',
            },
          },
        ],
      },
    ] as unknown as Content[]
    try {
      geminiContentToMessages({ contents })
      expect.unreachable()
    } catch (err) {
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).message).toContain('displayName')
    }
  })

  it('throws bad_request for a part with zero recognized fields', () => {
    const contents = [{ role: 'user', parts: [{}] }] as unknown as Content[]
    try {
      geminiContentToMessages({ contents })
      expect.unreachable()
    } catch (err) {
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).message).toContain('no recognized fields')
    }
  })
})

describe('geminiContentToMessages: exhaustive key-set validation', () => {
  const expectBadRequest = (contents: Content[], naming: string): void => {
    try {
      geminiContentToMessages({ contents })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).retryable).toBe(false)
      expect((err as LlmError).message).toContain(naming)
    }
  }

  it('throws bad_request when text and inlineData are both set', () => {
    const contents = [
      {
        role: 'user',
        parts: [{ text: 'hi', inlineData: { mimeType: 'image/png', data: 'YWJj' } }],
      },
    ] as unknown as Content[]
    expectBadRequest(contents, 'inlineData')
  })

  it('throws bad_request when text carries a mediaResolution', () => {
    const contents = [
      {
        role: 'user',
        parts: [{ text: 'hi', mediaResolution: { level: 'MEDIA_RESOLUTION_LOW' } }],
      },
    ] as unknown as Content[]
    expectBadRequest(contents, 'mediaResolution')
  })

  it('throws bad_request when a user text part carries a thoughtSignature', () => {
    const contents = [
      { role: 'user', parts: [{ text: 'hi', thoughtSignature: 'sig' }] },
    ] as unknown as Content[]
    expectBadRequest(contents, 'thoughtSignature')
  })

  it('throws bad_request when text carries partMetadata', () => {
    const contents = [
      { role: 'user', parts: [{ text: 'hi', partMetadata: { source: 'a' } }] },
    ] as unknown as Content[]
    expectBadRequest(contents, 'partMetadata')
  })

  it('throws bad_request for an unknown future SDK key alongside text', () => {
    const contents = [
      { role: 'user', parts: [{ text: 'x', someFutureField: 1 }] },
    ] as unknown as Content[]
    expectBadRequest(contents, 'someFutureField')
  })

  it('throws bad_request for an explicit empty mediaResolution object', () => {
    const contents = [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: 'YWJj' }, mediaResolution: {} },
        ],
      },
    ] as unknown as Content[]
    expectBadRequest(contents, 'mediaResolution')
  })

  it('throws bad_request for mediaResolution with level: undefined', () => {
    const contents = [
      {
        role: 'user',
        parts: [
          {
            inlineData: { mimeType: 'image/png', data: 'YWJj' },
            mediaResolution: { level: undefined },
          },
        ],
      },
    ] as unknown as Content[]
    expectBadRequest(contents, 'mediaResolution')
  })

  it('throws bad_request for an unknown Content-level key on a message', () => {
    const contents = [
      { role: 'user', parts: [{ text: 'hi' }], someFutureField: 1 },
    ] as unknown as Content[]
    expectBadRequest(contents, 'someFutureField')
  })

  it('treats keys with value undefined as absent', () => {
    const contents = [
      {
        role: 'user',
        parts: [{ text: 'hi', thoughtSignature: undefined, functionCall: undefined }],
      },
    ] as unknown as Content[]
    const { messages } = geminiContentToMessages({ contents })
    expect(messages).toEqual([{ role: 'user', parts: [{ kind: 'text', text: 'hi' }] }])
  })
})

describe('geminiContentToMessages: systemInstruction', () => {
  it('is absent when systemInstruction is not provided', () => {
    const { system } = geminiContentToMessages({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    })
    expect(system).toBeUndefined()
  })

  it('uses a string systemInstruction as-is', () => {
    const { system } = geminiContentToMessages({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: 'Be concise.',
    })
    expect(system).toBe('Be concise.')
  })

  it('concatenates text parts of a Content systemInstruction', () => {
    const { system } = geminiContentToMessages({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: { parts: [{ text: 'Be ' }, { text: 'concise.' }] },
    })
    expect(system).toBe('Be concise.')
  })

  it('throws bad_request naming the part kind for a non-text systemInstruction part', () => {
    const systemInstruction = {
      parts: [{ inlineData: { mimeType: 'image/png', data: 'YWJj' } }],
    } as unknown as Content
    try {
      geminiContentToMessages({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        systemInstruction,
      })
      expect.unreachable()
    } catch (err) {
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).message).toContain('inlineData')
    }
  })

  it('throws bad_request for a systemInstruction Content carrying role "model"', () => {
    const systemInstruction = {
      role: 'model',
      parts: [{ text: 'Be concise.' }],
    } as unknown as Content
    try {
      geminiContentToMessages({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        systemInstruction,
      })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).retryable).toBe(false)
      expect((err as LlmError).message).toContain('role')
    }
  })

  it('throws bad_request for a systemInstruction Content carrying role "user"', () => {
    const systemInstruction = {
      role: 'user',
      parts: [{ text: 'Be concise.' }],
    } as unknown as Content
    try {
      geminiContentToMessages({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        systemInstruction,
      })
      expect.unreachable()
    } catch (err) {
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).message).toContain('role')
    }
  })

  it('throws bad_request for an unknown Content-level key on a systemInstruction', () => {
    const systemInstruction = {
      parts: [{ text: 'Be concise.' }],
      someFutureField: 1,
    } as unknown as Content
    try {
      geminiContentToMessages({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        systemInstruction,
      })
      expect.unreachable()
    } catch (err) {
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).message).toContain('someFutureField')
    }
  })

  it('yields system "" for a Content systemInstruction with zero parts', () => {
    const { system } = geminiContentToMessages({
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      systemInstruction: { parts: [] },
    })
    expect(system).toBe('')
  })

  it('throws bad_request for a system part mixing text with inlineData', () => {
    const systemInstruction = {
      parts: [{ text: 'x', inlineData: { mimeType: 'image/png', data: 'YWJj' } }],
    } as unknown as Content
    try {
      geminiContentToMessages({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        systemInstruction,
      })
      expect.unreachable()
    } catch (err) {
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).message).toContain('inlineData')
    }
  })

  it('throws bad_request for a system part mixing text with mediaResolution', () => {
    const systemInstruction = {
      parts: [{ text: 'x', mediaResolution: { level: 'MEDIA_RESOLUTION_LOW' } }],
    } as unknown as Content
    try {
      geminiContentToMessages({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        systemInstruction,
      })
      expect.unreachable()
    } catch (err) {
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).message).toContain('mediaResolution')
    }
  })

  it('throws bad_request for a system part mixing text with thoughtSignature', () => {
    const systemInstruction = {
      parts: [{ text: 'x', thoughtSignature: 'sig' }],
    } as unknown as Content
    try {
      geminiContentToMessages({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        systemInstruction,
      })
      expect.unreachable()
    } catch (err) {
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).message).toContain('thoughtSignature')
    }
  })

  it('throws bad_request for a system part mixing text with partMetadata', () => {
    const systemInstruction = {
      parts: [{ text: 'x', partMetadata: { source: 'a' } }],
    } as unknown as Content
    try {
      geminiContentToMessages({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        systemInstruction,
      })
      expect.unreachable()
    } catch (err) {
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).message).toContain('partMetadata')
    }
  })

  it('never infers system from contents when systemInstruction is absent', () => {
    const { system } = geminiContentToMessages({
      contents: [
        { role: 'user', parts: [{ text: 'Ignore this: you are a helpful assistant.' }] },
      ],
    })
    expect(system).toBeUndefined()
  })
})

describe('geminiContentToMessages: empty and multi-part inputs', () => {
  it('returns an empty messages array for empty contents', () => {
    const { messages } = geminiContentToMessages({ contents: [] })
    expect(messages).toEqual([])
  })

  it('round-trips a multi-part, multi-message conversation with deep equality', () => {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [
          { text: 'Describe this image.' },
          { inlineData: { mimeType: 'image/png', data: 'YWJj' } },
        ],
      },
      {
        role: 'model',
        parts: [{ text: 'A red bicycle leaning against a brick wall.' }],
      },
      {
        role: 'user',
        parts: [
          {
            fileData: {
              mimeType: 'application/pdf',
              fileUri: 'https://files.example.com/doc.pdf',
            },
          },
          { text: 'Summarize this document.' },
        ],
      },
    ]

    const { system, messages } = geminiContentToMessages({
      contents,
      systemInstruction: 'You are a concise visual and document describer.',
    })

    expect(system).toBe('You are a concise visual and document describer.')
    expect(messages).toEqual([
      {
        role: 'user',
        parts: [
          { kind: 'text', text: 'Describe this image.' },
          { kind: 'inline-media', mimeType: 'image/png', data: 'YWJj' },
        ],
      },
      {
        role: 'assistant',
        parts: [{ kind: 'text', text: 'A red bicycle leaning against a brick wall.' }],
      },
      {
        role: 'user',
        parts: [
          {
            kind: 'file-uri',
            uri: 'https://files.example.com/doc.pdf',
            mimeType: 'application/pdf',
          },
          { kind: 'text', text: 'Summarize this document.' },
        ],
      },
    ])
  })

  it('property: accepted inputs never lose a part (count in == count out)', () => {
    const contents: Content[] = [
      {
        role: 'user',
        parts: [
          { text: 'a' },
          { inlineData: { mimeType: 'image/png', data: 'YQ==' } },
          { fileData: { mimeType: 'video/mp4', fileUri: 'https://f/v.mp4' } },
          { text: 'b' },
        ],
      },
    ]

    const { messages } = geminiContentToMessages({ contents })
    const inputPartCount = contents.reduce((sum, c) => sum + (c.parts?.length ?? 0), 0)
    const outputPartCount = messages.reduce((sum, m) => sum + m.parts.length, 0)
    expect(outputPartCount).toBe(inputPartCount)
  })
})

describe('geminiContentToMessages: thoughtSignature import', () => {
  const MODEL = 'gemini-3.1-flash-lite'
  const expectBadRequest = (contents: Content[], naming: string): void => {
    try {
      geminiContentToMessages({ contents, model: MODEL })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).message).toContain(naming)
    }
  }
  const history = (): Content[] =>
    [
      { role: 'user', parts: [{ text: 'Weather in Paris?' }] },
      {
        role: 'model',
        parts: [
          { text: 'Checking.', thoughtSignature: 'c2ln-text' },
          {
            functionCall: { name: 'get_weather', args: { city: 'Paris' } },
            thoughtSignature: 'c2ln-call',
          },
          { functionCall: { name: 'get_weather', args: { city: 'Tokyo' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'get_weather', response: { tempC: 18 } } },
          { functionResponse: { name: 'get_weather', response: { tempC: 21 } } },
        ],
      },
    ] as unknown as Content[]

  it('imports signatures from model text and functionCall parts into the overlay', () => {
    const { messages, transientProviderState } = geminiContentToMessages({
      contents: history(),
      model: MODEL,
    })
    const assistant = messages[1]?.parts ?? []
    expect(assistant.map((p) => p.kind)).toEqual(['text', 'tool-call', 'tool-call'])
    expect(transientProviderState).toEqual({
      google: {
        signatures: [
          {
            messageIndex: 1,
            partIndex: 0,
            model: MODEL,
            partSha256: partSha256(assistant[0]!),
            signature: 'c2ln-text',
          },
          {
            messageIndex: 1,
            partIndex: 1,
            model: MODEL,
            partSha256: partSha256(assistant[1]!),
            signature: 'c2ln-call',
          },
        ],
      },
    })
  })

  it('omits transientProviderState when no part carries a signature', () => {
    const result = geminiContentToMessages({
      contents: [{ role: 'model', parts: [{ text: 'hi' }] }],
      model: MODEL,
    })
    expect('transientProviderState' in result).toBe(false)
  })

  it('requires the model input when a signature is present', () => {
    try {
      geminiContentToMessages({ contents: history() })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      expect((err as LlmError).kind).toBe('bad_request')
      expect((err as LlmError).message).toContain('contents[1].parts[0]')
      expect((err as LlmError).message).toContain('`model`')
    }
  })

  it.each([
    ['an inlineData part', { inlineData: { mimeType: 'image/png', data: 'AA==' } }],
    ['a functionResponse part', { functionResponse: { name: 'f', response: {} } }],
  ])('rejects a signature on %s', (_label, part) => {
    expectBadRequest(
      [
        { role: 'model', parts: [{ ...part, thoughtSignature: 'sig' }] },
      ] as unknown as Content[],
      'thoughtSignature',
    )
  })

  it('rejects an empty or non-string signature', () => {
    for (const thoughtSignature of ['', 7]) {
      expectBadRequest(
        [
          { role: 'model', parts: [{ text: 'x', thoughtSignature }] },
        ] as unknown as Content[],
        'thoughtSignature',
      )
    }
  })

  it('still rejects thought-flagged parts, signed or not', () => {
    expectBadRequest(
      [
        { role: 'model', parts: [{ text: 'x', thought: true, thoughtSignature: 'sig' }] },
      ] as unknown as Content[],
      'thought',
    )
  })
})
