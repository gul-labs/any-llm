import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  assertInputMimeTypesAdmitted,
  isMediaTypeAdmitted,
  assertModelMatchesDescriptor,
  createModelRegistry,
  LlmError,
  toConfigJsonSchema,
  toConfigKeys,
  zodToStandardSchema,
} from './index.js'
import type { Message, ModelDescriptor } from './index.js'
import { configKeysOfJsonSchema } from './model-config/index.js'

const removedConfigSchemaFactory = `makeGeminiConfig${'Schema'}`
const removedConfigValidatorFactory = `makeGeminiConfig${'Validator'}`

const EmptyConfigSchema = z
  .strictObject({})
  .meta({ title: 'EmptyConfig', description: 'Test schema.', examples: [{}] })

function makeDescriptor(model: string, provider: string): ModelDescriptor {
  return {
    model,
    provider,
    limits: { contextWindow: 1_000_000, maxOutputTokens: 65_536 },
    configSchema: EmptyConfigSchema,
    configKeys: toConfigKeys(EmptyConfigSchema),
    configJsonSchema: toConfigJsonSchema(EmptyConfigSchema),
    validateConfig: zodToStandardSchema(EmptyConfigSchema),
  }
}

describe('createModelRegistry', () => {
  const descriptors = [
    makeDescriptor('alpha', 'p1'),
    makeDescriptor('beta-v2', 'p2'),
    makeDescriptor('beta', 'p3'),
  ]

  it('resolves exact ids only, scoped to the given provider', () => {
    const registry = createModelRegistry(descriptors)

    expect(registry.resolve('p1', 'alpha')?.provider).toBe('p1')
    expect(registry.resolve('p2', 'beta-v2')?.provider).toBe('p2')
    expect(registry.resolve('p3', 'beta')?.provider).toBe('p3')
  })

  it('does not prefix-match: an unregistered sibling of a registered id is unknown', () => {
    const registry = createModelRegistry(descriptors)

    expect(registry.resolve('p2', 'beta-v2-001')).toBeUndefined()
    expect(registry.resolve('p3', 'beta-experimental')).toBeUndefined()
    expect(registry.resolve('p1', 'alpha-image')).toBeUndefined()
  })

  it('resolves a declared alias to its descriptor, and only within its provider', () => {
    const aliased = { ...makeDescriptor('gamma', 'p1'), aliases: ['gamma-001'] }
    const registry = createModelRegistry([aliased, makeDescriptor('other', 'p2')])

    expect(registry.resolve('p1', 'gamma')).toBe(aliased)
    expect(registry.resolve('p1', 'gamma-001')).toBe(aliased)
    expect(registry.resolve('p2', 'gamma-001')).toBeUndefined()
    expect(registry.resolve('p1', 'gamma-002')).toBeUndefined()
  })

  it('rejects an alias that collides with a canonical id or another alias, in either order', () => {
    const a = { ...makeDescriptor('m1', 'p'), aliases: ['m2'] }
    const b = makeDescriptor('m2', 'p')
    expect(() => createModelRegistry([a, b])).toThrow(/collides/)
    expect(() => createModelRegistry([b, a])).toThrow(/collides/)
    expect(() =>
      createModelRegistry([
        { ...makeDescriptor('x', 'p'), aliases: ['dup'] },
        { ...makeDescriptor('y', 'p'), aliases: ['dup'] },
      ]),
    ).toThrow(/collides/)
    expect(() =>
      createModelRegistry([{ ...makeDescriptor('x', 'p'), aliases: ['x'] }]),
    ).toThrow(/collides/)
    expect(() =>
      createModelRegistry([{ ...makeDescriptor('x', 'p'), aliases: [''] }]),
    ).toThrow(/alias/)
  })

  it('allows the same alias string under two providers', () => {
    const registry = createModelRegistry([
      { ...makeDescriptor('m', 'p'), aliases: ['same'] },
      { ...makeDescriptor('n', 'q'), aliases: ['same'] },
    ])
    expect(registry.resolve('p', 'same')?.model).toBe('m')
    expect(registry.resolve('q', 'same')?.model).toBe('n')
  })

  it('returns undefined for unknown models', () => {
    const registry = createModelRegistry(descriptors)

    expect(registry.resolve('p1', 'unknown')).toBeUndefined()
  })

  it('returns undefined when the model matches but under a different provider', () => {
    const registry = createModelRegistry(descriptors)

    // 'alpha' is only registered under 'p1' — resolving it under 'p2' must miss.
    expect(registry.resolve('p2', 'alpha')).toBeUndefined()
  })

  it('returns a defensive copy from listDescriptors', () => {
    const registry = createModelRegistry(descriptors)
    const listed = registry.listDescriptors?.()

    expect(listed).toEqual(descriptors)
    expect(listed).not.toBe(descriptors)
  })

  it('throws on duplicate exact (provider, model) pairs', () => {
    expect(() =>
      createModelRegistry([makeDescriptor('dup', 'a'), makeDescriptor('dup', 'a')]),
    ).toThrow(LlmError)
  })

  it('allows the same bare model string under two different providers', () => {
    const registry = createModelRegistry([
      makeDescriptor('shared-model', 'a'),
      makeDescriptor('shared-model', 'b'),
    ])

    const fromA = registry.resolve('a', 'shared-model')
    const fromB = registry.resolve('b', 'shared-model')

    expect(fromA).toBeDefined()
    expect(fromB).toBeDefined()
    expect(fromA).not.toBe(fromB)
    expect(fromA?.provider).toBe('a')
    expect(fromB?.provider).toBe('b')
  })

  it('same bare model under two providers can carry distinct config schemas', () => {
    const SchemaA = z
      .strictObject({ temperature: z.number().optional() })
      .meta({ title: 'ConfigA', description: 'Provider-a schema.', examples: [{}] })
    const SchemaB = z
      .strictObject({ maxTokens: z.number().optional() })
      .meta({ title: 'ConfigB', description: 'Provider-b schema.', examples: [{}] })

    const registry = createModelRegistry([
      {
        model: 'shared-model',
        provider: 'a',
        limits: { contextWindow: 1_000_000, maxOutputTokens: 65_536 },
        configSchema: SchemaA,
        configKeys: toConfigKeys(SchemaA),
        configJsonSchema: toConfigJsonSchema(SchemaA),
        validateConfig: zodToStandardSchema(SchemaA),
      },
      {
        model: 'shared-model',
        provider: 'b',
        limits: { contextWindow: 1_000_000, maxOutputTokens: 65_536 },
        configSchema: SchemaB,
        configKeys: toConfigKeys(SchemaB),
        configJsonSchema: toConfigJsonSchema(SchemaB),
        validateConfig: zodToStandardSchema(SchemaB),
      },
    ])

    const fromA = registry.resolve('a', 'shared-model')
    const fromB = registry.resolve('b', 'shared-model')
    expect(fromA?.configSchema).toBe(SchemaA)
    expect(fromB?.configSchema).toBe(SchemaB)
    expect(fromA?.configSchema).not.toBe(fromB?.configSchema)
    expect(fromA?.configJsonSchema).not.toEqual(fromB?.configJsonSchema)
  })

  it('throws when a custom descriptor is missing required schema artifacts', () => {
    expect(() =>
      createModelRegistry([
        {
          model: 'broken-model',
          provider: 'acme',
          configSchema: EmptyConfigSchema,
        } as unknown as ModelDescriptor,
      ]),
    ).toThrow(/missing required schema artifacts/i)
  })
})

describe('@gullabs/core package surface', () => {
  it('exports the new Zod helpers and no longer exports the Gemini schema factories', async () => {
    const surface = await import('./index.js')

    expect(typeof surface.toConfigJsonSchema).toBe('function')
    expect(typeof surface.zodToStandardSchema).toBe('function')
    expect(removedConfigSchemaFactory in surface).toBe(false)
    expect(removedConfigValidatorFactory in surface).toBe(false)
  })
})

describe('assertModelMatchesDescriptor', () => {
  const descriptor = { ...makeDescriptor('canon', 'p'), aliases: ['canon-001'] }

  it('accepts the canonical id and a declared alias', () => {
    expect(() =>
      assertModelMatchesDescriptor({ provider: 'p', model: 'canon' }, descriptor, 'p'),
    ).not.toThrow()
    expect(() =>
      assertModelMatchesDescriptor(
        { provider: 'p', model: 'canon-001' },
        descriptor,
        'p',
      ),
    ).not.toThrow()
  })

  it('rejects a string that is neither canonical nor an alias', () => {
    expect(() =>
      assertModelMatchesDescriptor(
        { provider: 'p', model: 'canon-002' },
        descriptor,
        'p',
      ),
    ).toThrow(LlmError)
  })

  it('rejects a missing descriptor', () => {
    expect(() =>
      assertModelMatchesDescriptor({ provider: 'p', model: 'canon' }, undefined, 'p'),
    ).toThrow(/No matching p model descriptor/)
  })

  it('rejects a descriptor whose provider differs from the adapter or the request, even when an alias matches', () => {
    const other = { ...makeDescriptor('canon', 'q'), aliases: ['canon-001'] }
    expect(() =>
      assertModelMatchesDescriptor({ provider: 'p', model: 'canon-001' }, other, 'p'),
    ).toThrow(LlmError)
    expect(() =>
      assertModelMatchesDescriptor({ provider: 'q', model: 'canon-001' }, other, 'p'),
    ).toThrow(LlmError)
    expect(() =>
      assertModelMatchesDescriptor(
        { provider: 'p', model: 'canon-001' },
        descriptor,
        'q',
      ),
    ).toThrow(LlmError)
  })
})

describe('descriptor limits', () => {
  const withLimits = (limits: unknown): ModelDescriptor =>
    ({ ...makeDescriptor('m', 'p'), limits }) as unknown as ModelDescriptor

  it('requires limits on every descriptor', () => {
    expect(() => createModelRegistry([withLimits(undefined)])).toThrow(
      /missing required limits/,
    )
  })

  it('requires positive integer limits', () => {
    for (const bad of [
      0,
      -1,
      1.5,
      Number.NaN,
      '100',
      Number.MAX_SAFE_INTEGER + 1,
      undefined,
    ]) {
      expect(() =>
        createModelRegistry([withLimits({ contextWindow: bad, maxOutputTokens: 1 })]),
      ).toThrow(/limits\.contextWindow/)
      expect(() =>
        createModelRegistry([withLimits({ contextWindow: 10, maxOutputTokens: bad })]),
      ).toThrow(/limits\.maxOutputTokens/)
    }
  })

  it('accepts a null maxOutputTokens (no documented output limit) and exposes it', () => {
    const d = withLimits({ contextWindow: 100, maxOutputTokens: null })
    expect(createModelRegistry([d]).resolve('p', 'm')?.limits).toEqual({
      contextWindow: 100,
      maxOutputTokens: null,
    })
  })

  it('freezes the limits so a table shared by several descriptors cannot be edited through one', () => {
    const shared = { contextWindow: 100, maxOutputTokens: 50 }
    const a = { ...makeDescriptor('a', 'p'), limits: shared }
    const b = { ...makeDescriptor('b', 'p'), limits: shared }
    const registry = createModelRegistry([a, b])
    expect(() => {
      ;(
        registry.resolve('p', 'a')?.limits as { maxOutputTokens: number }
      ).maxOutputTokens = 5
    }).toThrow(TypeError)
    expect(registry.resolve('p', 'b')?.limits.maxOutputTokens).toBe(50)
  })

  it('rejects a maxOutputTokens above the context window', () => {
    expect(() =>
      createModelRegistry([withLimits({ contextWindow: 100, maxOutputTokens: 101 })]),
    ).toThrow(/above limits\.contextWindow/)
  })

  it('accepts equal limits and exposes them on the resolved descriptor', () => {
    const d = withLimits({ contextWindow: 100, maxOutputTokens: 100 })
    expect(createModelRegistry([d]).resolve('p', 'm')?.limits).toEqual({
      contextWindow: 100,
      maxOutputTokens: 100,
    })
  })
})

describe('assertInputMimeTypesAdmitted', () => {
  const descriptor = (inputMimeTypes?: readonly string[]): ModelDescriptor => ({
    ...makeDescriptor('m', 'p'),
    capabilities: inputMimeTypes === undefined ? {} : { inputMimeTypes },
  })
  const messages = (...parts: Message['parts']): Message[] => [{ role: 'user', parts }]
  const inline = (mimeType: string): Message['parts'][number] => ({
    kind: 'inline-media',
    mimeType,
    data: 'AAAA',
  })
  const uri = (mimeType: string): Message['parts'][number] => ({
    kind: 'file-uri',
    mimeType,
    uri: 'https://example.test/f',
  })

  it('passes admitted types on inline and file-uri parts and ignores non-media parts', () => {
    expect(() =>
      assertInputMimeTypesAdmitted(
        messages({ kind: 'text', text: 'hi' }, inline('image/png'), uri('image/jpeg'), {
          kind: 'file-ref',
          fileId: 'f1',
        }),
        descriptor(['image/png', 'image/jpeg']),
        'p',
      ),
    ).not.toThrow()
  })

  it('rejects an unadmitted inline type with the path and the admitted list', () => {
    try {
      assertInputMimeTypesAdmitted(
        messages({ kind: 'text', text: 'hi' }, inline('image/webp')),
        descriptor(['image/png']),
        'p',
      )
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError)
      const e = err as LlmError
      expect(e.kind).toBe('bad_request')
      expect(e.retryable).toBe(false)
      expect(e.message).toContain('messages[0].parts[1]')
      expect(e.message).toContain('image/webp')
      expect(e.message).toContain('image/png')
      expect(e.issues?.[0]?.path).toBe('messages[0].parts[1]')
    }
  })

  it('rejects an unadmitted file-uri type', () => {
    expect(() =>
      assertInputMimeTypesAdmitted(
        messages(uri('video/mp4')),
        descriptor(['image/png']),
        'p',
      ),
    ).toThrow(/video\/mp4/)
  })

  it('matches case-insensitively and ignores parameters, without rewriting anything', () => {
    for (const type of [
      'IMAGE/PNG',
      'image/png; charset=binary',
      ' Image/Png ;q=1',
      'image/jpeg;x=y',
    ]) {
      const msgs = messages(inline(type))
      expect(() =>
        assertInputMimeTypesAdmitted(msgs, descriptor(['image/png', 'image/jpeg']), 'p'),
      ).not.toThrow()
      const part = msgs[0]?.parts[0]
      expect(part?.kind === 'inline-media' && part.mimeType).toBe(type)
    }
  })

  it('does not map aliases: image/jpg is not image/jpeg', () => {
    expect(() =>
      assertInputMimeTypesAdmitted(
        messages(inline('image/jpg')),
        descriptor(['image/png', 'image/jpeg']),
        'p',
      ),
    ).toThrow(/does not accept media type "image\/jpg"/)
  })

  it('an entry family/* admits every subtype of that family and nothing else', () => {
    const d = descriptor(['image/*', 'application/pdf'])
    for (const type of [
      'image/png',
      'image/x-anything',
      'IMAGE/GIF; a=b',
      'application/pdf',
    ]) {
      expect(() =>
        assertInputMimeTypesAdmitted(messages(inline(type)), d, 'p'),
      ).not.toThrow()
    }
    for (const type of [
      'video/mp4',
      'application/json',
      'image',
      'image/',
      'image/*',
      '*/*',
    ]) {
      expect(() => assertInputMimeTypesAdmitted(messages(inline(type)), d, 'p')).toThrow(
        LlmError,
      )
    }
  })

  it('refuses an empty or missing media type with a message of its own', () => {
    for (const type of ['', '   ', '; charset=utf-8', undefined, null] as unknown[]) {
      try {
        assertInputMimeTypesAdmitted(
          messages(inline(type as string)),
          descriptor(['image/*']),
          'p',
        )
        expect.unreachable()
      } catch (err) {
        const e = err as LlmError
        expect(e.kind).toBe('bad_request')
        expect(e.message).toContain('a media type is required')
        expect(e.message).toContain('messages[0].parts[0]')
        expect(e.issues?.[0]?.path).toBe('messages[0].parts[0]')
      }
    }
  })

  it('isMediaTypeAdmitted is the same rule for callers outside a message', () => {
    expect(isMediaTypeAdmitted('Image/PNG; a=b', ['image/png'])).toBe(true)
    expect(isMediaTypeAdmitted('video/mp4', ['image/*'])).toBe(false)
    expect(isMediaTypeAdmitted('', ['image/*'])).toBe(false)
    expect(isMediaTypeAdmitted('image/png', [])).toBe(false)
  })

  it('the registry validates and freezes inputMimeTypes entries', () => {
    const withTypes = (inputMimeTypes: unknown): ModelDescriptor => ({
      ...makeDescriptor('m', 'p'),
      capabilities: { inputMimeTypes: inputMimeTypes as string[] },
    })
    for (const bad of [
      ['IMAGE/PNG'],
      ['image/png; q=1'],
      ['image'],
      ['*/*'],
      [''],
      ['image/png', 'image/png'],
      [42],
      'image/png',
    ]) {
      expect(() => createModelRegistry([withTypes(bad)]), JSON.stringify(bad)).toThrow(
        /inputMimeTypes/,
      )
    }
    const list = ['image/png', 'video/*']
    const resolved = createModelRegistry([withTypes(list)]).resolve('p', 'm')
    expect(Object.isFrozen(resolved?.capabilities?.inputMimeTypes)).toBe(true)
  })

  it('treats an absent or empty list as no media input', () => {
    expect(() =>
      assertInputMimeTypesAdmitted(messages(inline('image/png')), descriptor(), 'p'),
    ).toThrow(/admits no media input/)
    expect(() =>
      assertInputMimeTypesAdmitted(messages(inline('image/png')), descriptor([]), 'p'),
    ).toThrow(/admits no media input/)
    expect(() =>
      assertInputMimeTypesAdmitted(
        messages({ kind: 'text', text: 'hi' }),
        descriptor(),
        'p',
      ),
    ).not.toThrow()
  })
})

describe('registry introspection (findByModel, listDescriptors, configKeys)', () => {
  const aliased: ModelDescriptor = {
    ...makeDescriptor('gamma', 'p1'),
    aliases: ['gamma-001'],
  }
  const sameIdOtherProvider = makeDescriptor('gamma', 'p2')
  const other = makeDescriptor('delta', 'p1')
  const registry = createModelRegistry([aliased, other, sameIdOtherProvider])

  it('findByModel finds a canonical id without a provider', () => {
    expect(registry.findByModel('delta')).toEqual([other])
  })

  it('findByModel finds a declared alias and returns the aliased descriptor', () => {
    expect(registry.findByModel('gamma-001')).toEqual([aliased])
    expect(registry.findByModel('gamma-001')[0]).toBe(aliased)
  })

  it('findByModel returns every provider that registers the id, in registration order', () => {
    const found = registry.findByModel('gamma')
    expect(found).toHaveLength(2)
    expect(found[0]).toBe(aliased)
    expect(found[1]).toBe(sameIdOtherProvider)
    expect(found.map((d) => d.provider)).toEqual(['p1', 'p2'])
  })

  it('findByModel returns an empty list for an unknown id, a prefix or a sibling', () => {
    expect(registry.findByModel('nope')).toEqual([])
    expect(registry.findByModel('gam')).toEqual([])
    expect(registry.findByModel('gamma-002')).toEqual([])
    expect(registry.findByModel('')).toEqual([])
  })

  it('findByModel returns a defensive copy', () => {
    const first = registry.findByModel('gamma') as ModelDescriptor[]
    first.length = 0
    expect(registry.findByModel('gamma')).toHaveLength(2)
  })

  it('listDescriptors lists every descriptor in registration order, as a copy', () => {
    expect(registry.listDescriptors()).toEqual([aliased, other, sameIdOtherProvider])
    ;(registry.listDescriptors() as ModelDescriptor[]).length = 0
    expect(registry.listDescriptors()).toHaveLength(3)
  })

  it('listDescriptors, findByModel and resolve all answer from the construction-time snapshot', () => {
    const source = [makeDescriptor('one', 'p1')]
    const snap = createModelRegistry(source)
    source.push(makeDescriptor('late', 'p1'))
    source.shift()
    expect(snap.listDescriptors().map((d) => d.model)).toEqual(['one'])
    expect(snap.findByModel('late')).toEqual([])
    expect(snap.resolve('p1', 'late')).toBeUndefined()
    expect(snap.findByModel('one')).toHaveLength(1)
    expect(snap.resolve('p1', 'one')).toBeDefined()
  })

  it('an empty registry finds and lists nothing', () => {
    const empty = createModelRegistry([])
    expect(empty.findByModel('x')).toEqual([])
    expect(empty.listDescriptors()).toEqual([])
  })
})

describe('configKeys', () => {
  const Branches = z.union([
    z.strictObject({
      temperature: z.number().optional(),
      serviceTier: z.literal('flex'),
      reasoning: z.strictObject({ effort: z.enum(['low']) }).optional(),
    }),
    z.strictObject({
      temperature: z.number().optional(),
      serviceTier: z.literal('standard').optional(),
      maxOutputTokens: z.number().optional(),
    }),
  ])

  it('is the sorted union of the top-level keys of every branch, once each', () => {
    expect(toConfigKeys(Branches)).toEqual([
      'maxOutputTokens',
      'reasoning',
      'serviceTier',
      'temperature',
    ])
  })

  it('names only top-level keys, not nested ones', () => {
    expect(
      toConfigKeys(z.strictObject({ reasoning: z.strictObject({ effort: z.string() }) })),
    ).toEqual(['reasoning'])
  })

  it('an empty schema has no keys', () => {
    expect(toConfigKeys(EmptyConfigSchema)).toEqual([])
  })

  it('a recursive schema still lists its top-level keys (a $ref below them is not followed)', () => {
    const Recursive: z.ZodType = z.strictObject({
      get child() {
        return Recursive.optional()
      },
    })
    expect(toConfigKeys(Recursive)).toEqual(['child'])
  })

  it('a local $ref into $defs is followed, so a schema with .meta({ id }) lists its keys', () => {
    const Base = z
      .strictObject({ b: z.number().optional(), a: z.string() })
      .meta({ id: 'Base' })
    expect(toConfigKeys(Base)).toEqual(['a', 'b'])
    expect(toConfigKeys(z.union([Base, z.strictObject({ c: z.string() })]))).toEqual([
      'a',
      'b',
      'c',
    ])
    expect(
      configKeysOfJsonSchema({
        $ref: '#/$defs/config',
        $defs: { config: { properties: { x: {} } } },
      }),
    ).toEqual(['x'])
  })

  it('a $ref that loops terminates, and one that does not resolve or leaves $defs is refused', () => {
    expect(
      configKeysOfJsonSchema({
        $ref: '#/$defs/a',
        $defs: {
          a: {
            properties: { x: {} },
            anyOf: [{ $ref: '#/$defs/a' }, { $ref: '#/$defs/b' }],
          },
          b: { properties: { y: {} } },
        },
      }),
    ).toEqual(['x', 'y'])
    expect(() => configKeysOfJsonSchema({ $ref: '#/$defs/missing', $defs: {} })).toThrow(
      /does not resolve/,
    )
    expect(() =>
      configKeysOfJsonSchema({ anyOf: [{ properties: { a: {} } }, { $ref: '#/x' }] }),
    ).toThrow(/\$ref/)
    expect(() => configKeysOfJsonSchema({ $ref: 'https://x.test/s.json' })).toThrow(
      /\$ref/,
    )
  })

  it('a schema JSON Schema cannot represent fails with an LlmError, not a plain Error', () => {
    const Transformed = z.strictObject({ a: z.string().transform((v) => v) })
    for (const fn of [
      () => toConfigJsonSchema(Transformed),
      () => toConfigKeys(Transformed),
    ]) {
      try {
        fn()
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(LlmError)
        expect((err as LlmError).kind).toBe('bad_request')
        expect((err as LlmError).cause).toBeInstanceOf(Error)
      }
    }
  })

  it('a descriptor whose schema carries .meta({ id }) registers', () => {
    const Base = z.strictObject({ a: z.number().optional() }).meta({ id: 'Base' })
    const d: ModelDescriptor = {
      ...makeDescriptor('m', 'p'),
      configSchema: Base,
      configJsonSchema: toConfigJsonSchema(Base),
      configKeys: toConfigKeys(Base),
      validateConfig: zodToStandardSchema(Base),
    }
    expect(createModelRegistry([d]).resolve('p', 'm')?.configKeys).toEqual(['a'])
  })

  it('matches the keys the descriptor schema accepts, per descriptor', () => {
    const Schema = z.strictObject({ a: z.number().optional(), b: z.string().optional() })
    const d: ModelDescriptor = {
      ...makeDescriptor('m', 'p'),
      configSchema: Schema,
      configJsonSchema: toConfigJsonSchema(Schema),
      configKeys: toConfigKeys(Schema),
      validateConfig: zodToStandardSchema(Schema),
    }
    const resolved = createModelRegistry([d]).resolve('p', 'm')
    expect(resolved?.configKeys).toEqual(['a', 'b'])
    for (const key of resolved?.configKeys ?? []) {
      expect(Object.keys((resolved?.configSchema as typeof Schema).shape)).toContain(key)
    }
  })

  it('registry construction rejects missing and stale configKeys', () => {
    const base = makeDescriptor('m', 'p')
    expect(() =>
      createModelRegistry([
        { ...base, configKeys: undefined } as unknown as ModelDescriptor,
      ]),
    ).toThrow(/missing required configKeys/)
    expect(() => createModelRegistry([{ ...base, configKeys: ['extra'] }])).toThrow(
      /stale configKeys \[extra\]/,
    )
    const Two = z.strictObject({ a: z.number().optional(), b: z.number().optional() })
    expect(() =>
      createModelRegistry([
        {
          ...base,
          configSchema: Two,
          configJsonSchema: toConfigJsonSchema(Two),
          configKeys: ['a'],
        },
      ]),
    ).toThrow(/stale configKeys/)
  })

  it('checks keys and JSON Schema against the real configSchema, not the declared artifact', () => {
    const A = z.strictObject({ a: z.number().optional() })
    const B = z.strictObject({ b: z.number().optional() })
    const base = makeDescriptor('m', 'p')
    // configSchema names `a`; the declared JSON Schema and keys were derived from `b`.
    expect(() =>
      createModelRegistry([
        {
          ...base,
          configSchema: A,
          configJsonSchema: toConfigJsonSchema(B),
          configKeys: toConfigKeys(B),
        },
      ]),
    ).toThrow(/stale configJsonSchema/)
    // JSON Schema correct, keys derived from the other schema.
    expect(() =>
      createModelRegistry([
        {
          ...base,
          configSchema: A,
          configJsonSchema: toConfigJsonSchema(A),
          configKeys: toConfigKeys(B),
        },
      ]),
    ).toThrow(/stale configKeys \[b\]/)
  })
})
