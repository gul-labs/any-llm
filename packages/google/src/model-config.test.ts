import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { toConfigJsonSchema, zodToStandardSchema } from '@gullabs/core'
import type { JsonValue } from '@gullabs/core'
import { geminiModelDescriptors, gemmaModelDescriptors } from './models.js'

function findDescriptor(id: string) {
  return [...geminiModelDescriptors, ...gemmaModelDescriptors].find(
    (descriptor) => descriptor.model === id,
  )!
}

function collectObjectSchemas(value: unknown, acc: Record<string, unknown>[] = []) {
  if (value === null || typeof value !== 'object') return acc

  if (Array.isArray(value)) {
    for (const item of value) collectObjectSchemas(item, acc)
    return acc
  }

  const record = value as Record<string, unknown>
  if (record['type'] === 'object') {
    acc.push(record)
  }

  for (const child of Object.values(record)) {
    collectObjectSchemas(child, acc)
  }

  return acc
}

describe('model-config helpers', () => {
  it('preserves Zod metadata in derived JSON Schema', () => {
    const schema = findDescriptor('gemini-2.5-pro').configJsonSchema as Record<
      string,
      unknown
    >
    const branches = schema['anyOf'] as Record<string, unknown>[]
    const firstBranch = branches[0]!
    const temperature = (firstBranch['properties'] as Record<string, unknown>)[
      'temperature'
    ] as Record<string, unknown>

    expect(schema['title']).toBe('Gemini25ProConfig')
    expect(schema['description']).toMatch(/gemini-2.5-pro/i)
    expect(temperature['title']).toBe('Temperature')
    expect(temperature['description']).toMatch(/sampling temperature/i)
    expect(temperature['examples']).toEqual([0.7])
  })

  it('throws when JSON Schema generation encounters an unrepresentable Zod construct', () => {
    expect(() => toConfigJsonSchema(z.map(z.string(), z.string()))).toThrow()
  })

  it('adapts Zod safeParse to StandardSchema v1', () => {
    const schema = z
      .strictObject({
        serviceTier: z.literal('flex'),
      })
      .meta({ title: 'FlexOnly', description: 'Flex-only test schema.' })

    const validator = zodToStandardSchema(schema)
    const success = validator['~standard'].validate({ serviceTier: 'flex' })
    const failure = validator['~standard'].validate({ serviceTier: 'standard' })

    expect('value' in success && success.value).toEqual({ serviceTier: 'flex' })
    expect('issues' in failure).toBe(true)
  })
})

describe('strict built-in config schemas', () => {
  it('reject unknown keys at the top level', () => {
    const result = findDescriptor('gemini-2.5-flash').configSchema.safeParse({
      unexpected: true,
    })

    expect(result.success).toBe(false)
  })

  it('reject unknown nested providerOptions keys', () => {
    const result = findDescriptor('gemini-2.5-flash').configSchema.safeParse({
      providerOptions: {
        google: {
          unsupported: true,
        },
      },
    })

    expect(result.success).toBe(false)
  })

  it('accepts providerOptions.google.flexFallback only in the flex branch', () => {
    expect(
      findDescriptor('gemini-2.5-flash').configSchema.safeParse({
        flexFallback: false,
      }).success,
    ).toBe(false)

    expect(
      findDescriptor('gemini-2.5-flash').configSchema.safeParse({
        serviceTier: 'standard',
        providerOptions: { google: { flexFallback: false } },
      }).success,
    ).toBe(false)

    expect(
      findDescriptor('gemini-2.5-flash').configSchema.safeParse({
        serviceTier: 'flex',
        providerOptions: { google: { flexFallback: false } },
      }).success,
    ).toBe(true)
  })

  it('rejects unsupported sampling fields on fixed-sampling models', () => {
    const result = findDescriptor('gemini-3.1-flash-lite').configSchema.safeParse({
      temperature: 0.5,
    })

    expect(result.success).toBe(false)
  })

  it('admits thinking-off only for models whose evidence allows it', () => {
    expect(
      findDescriptor('gemini-2.5-pro').configSchema.safeParse({
        reasoning: { effort: 'none' },
      }).success,
    ).toBe(false)

    expect(
      findDescriptor('gemini-3.1-flash-lite').configSchema.safeParse({
        reasoning: { effort: 'none' },
      }).success,
    ).toBe(true)

    expect(
      findDescriptor('gemini-3.1-pro-preview').configSchema.safeParse({
        reasoning: { effort: 'none' },
      }).success,
    ).toBe(false)

    expect(
      findDescriptor('gemini-3.8-flash').configSchema.safeParse({
        reasoning: { effort: 'none' },
      }).success,
    ).toBe(false)
    expect(
      findDescriptor('gemini-3.7-flash').configSchema.safeParse({
        reasoning: { effort: 'none' },
      }).success,
    ).toBe(false)
    expect(
      findDescriptor('gemini-3.6-flash').configSchema.safeParse({
        reasoning: { effort: 'none' },
      }).success,
    ).toBe(true)
    expect(
      findDescriptor('gemini-3.5-flash-lite').configSchema.safeParse({
        reasoning: { effort: 'none' },
      }).success,
    ).toBe(true)
  })

  it('enforces model-specific budget rules', () => {
    expect(
      findDescriptor('gemini-2.5-pro').configSchema.safeParse({
        reasoning: { budgetTokens: 0 },
      }).success,
    ).toBe(false)

    expect(
      findDescriptor('gemini-2.5-flash-lite').configSchema.safeParse({
        reasoning: { budgetTokens: 0 },
      }).success,
    ).toBe(true)

    expect(
      findDescriptor('gemini-2.5-flash-lite').configSchema.safeParse({
        reasoning: { budgetTokens: 1 },
      }).success,
    ).toBe(false)
  })

  it('keeps additionalProperties false at every object boundary in derived JSON Schema', () => {
    for (const descriptor of [...geminiModelDescriptors, ...gemmaModelDescriptors]) {
      const objectSchemas = collectObjectSchemas(descriptor.configJsonSchema as JsonValue)

      expect(objectSchemas.length, descriptor.model).toBeGreaterThan(0)
      for (const objectSchema of objectSchemas) {
        expect(objectSchema['additionalProperties'], descriptor.model).toBe(false)
      }
    }
  })
})
