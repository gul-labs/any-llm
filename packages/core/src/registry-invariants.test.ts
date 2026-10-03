import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { toConfigJsonSchema, zodToStandardSchema } from './index.js'
import type { ModelDescriptor } from './index.js'

import { assertRegistryInvariants } from '@gullabs/testing'

const CappedSchema = z.strictObject({
  maxOutputTokens: z.number().int().positive().max(1000).optional(),
})
const UncappedSchema = z.strictObject({
  maxOutputTokens: z.number().int().positive().optional(),
})
const NoKeySchema = z.strictObject({})

function descriptor(
  schema: z.ZodType,
  limits: ModelDescriptor['limits'],
): ModelDescriptor {
  return {
    model: 'm',
    provider: 'p',
    limits,
    configSchema: schema,
    configJsonSchema: toConfigJsonSchema(schema),
    validateConfig: zodToStandardSchema(schema),
  }
}

function check(d: ModelDescriptor): void {
  assertRegistryInvariants({ descriptors: [d], expectedModelIds: ['m'] })
}

describe('assertRegistryInvariants limits', () => {
  it('accepts limits whose cap the schema enforces exactly', () => {
    expect(() =>
      check(descriptor(CappedSchema, { contextWindow: 5000, maxOutputTokens: 1000 })),
    ).not.toThrow()
  })

  it('accepts a schema with no maxOutputTokens field (CLI providers)', () => {
    expect(() =>
      check(descriptor(NoKeySchema, { contextWindow: 5000, maxOutputTokens: 1000 })),
    ).not.toThrow()
  })

  it('rejects a schema that does not cap maxOutputTokens at the limit', () => {
    expect(() =>
      check(descriptor(UncappedSchema, { contextWindow: 5000, maxOutputTokens: 1000 })),
    ).toThrow(/cap maxOutputTokens/)
  })

  it('rejects a schema that caps below the limit', () => {
    expect(() =>
      check(descriptor(CappedSchema, { contextWindow: 5000, maxOutputTokens: 2000 })),
    ).toThrow(/accept maxOutputTokens up to/)
  })

  it('rejects missing, non-integer and inconsistent limits', () => {
    expect(() =>
      check(descriptor(NoKeySchema, undefined as unknown as ModelDescriptor['limits'])),
    ).toThrow(/missing required limits/)
    expect(() =>
      check(descriptor(NoKeySchema, { contextWindow: 5000, maxOutputTokens: 0 })),
    ).toThrow(/positive integer/)
    expect(() =>
      check(descriptor(NoKeySchema, { contextWindow: 5000.5, maxOutputTokens: 1 })),
    ).toThrow(/positive integer/)
    expect(() =>
      check(descriptor(NoKeySchema, { contextWindow: 100, maxOutputTokens: 200 })),
    ).toThrow(/above limits.contextWindow/)
  })
})
