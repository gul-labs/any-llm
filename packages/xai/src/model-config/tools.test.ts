/**
 * Zod + derived JSON Schema parity for xAI Live Search tools.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { toConfigJsonSchema } from '@gullabs/core'
import { Grok45ConfigSchema } from './grok-4-5.js'
import { Grok46ConfigSchema } from './grok-4-6.js'
import { Grok47ConfigSchema } from './grok-4-7.js'

function jsonSchemaAccepts(schema: unknown, value: unknown): boolean {
  return validateJsonSchema(schema, value).ok
}

function validateJsonSchema(schema: unknown, value: unknown): { ok: boolean } {
  if (!isRecord(schema)) return { ok: false }
  if (schema['anyOf'] !== undefined || schema['oneOf'] !== undefined) {
    const alts = (schema['anyOf'] ?? schema['oneOf']) as unknown[]
    return { ok: alts.some((alt) => validateJsonSchema(alt, value).ok) }
  }
  if (schema['const'] !== undefined) {
    return { ok: value === schema['const'] }
  }
  if (Array.isArray(schema['enum'])) {
    return { ok: schema['enum'].includes(value) }
  }
  if (schema['type'] === 'array') {
    if (!Array.isArray(value)) return { ok: false }
    const prefix = schema['prefixItems']
    if (Array.isArray(prefix)) {
      if (schema['items'] === false && value.length !== prefix.length) {
        return { ok: false }
      }
      if (value.length !== prefix.length && schema['minItems'] === prefix.length) {
        return { ok: false }
      }
      if (value.length !== prefix.length) {
        const max = schema['maxItems']
        const min = schema['minItems']
        if (typeof max === 'number' && value.length > max) return { ok: false }
        if (typeof min === 'number' && value.length < min) return { ok: false }
        if (value.length !== prefix.length) return { ok: false }
      }
      return {
        ok: prefix.every((itemSchema, i) => validateJsonSchema(itemSchema, value[i]).ok),
      }
    }
    const items = schema['items']
    if (items !== undefined && items !== false) {
      const max = schema['maxItems']
      if (typeof max === 'number' && value.length > max) return { ok: false }
      return { ok: value.every((item) => validateJsonSchema(items, item).ok) }
    }
    return { ok: true }
  }
  if (schema['type'] === 'object' || schema['properties'] !== undefined) {
    if (!isRecord(value)) return { ok: false }
    const props = isRecord(schema['properties']) ? schema['properties'] : {}
    const additional = schema['additionalProperties']
    if (additional === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) return { ok: false }
      }
    }
    const required = Array.isArray(schema['required']) ? schema['required'] : []
    for (const key of required) {
      if (typeof key === 'string' && !(key in value)) return { ok: false }
    }
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in value && !validateJsonSchema(propSchema, value[key]).ok) {
        return { ok: false }
      }
    }
    return { ok: true }
  }
  if (schema['type'] === 'string') {
    if (typeof value !== 'string') return { ok: false }
    if (schema['format'] === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return { ok: false }
    }
    const minLength = schema['minLength']
    if (typeof minLength === 'number' && value.length < minLength) return { ok: false }
    return { ok: true }
  }
  if (schema['type'] === 'boolean') return { ok: typeof value === 'boolean' }
  if (schema['type'] === 'number' || schema['type'] === 'integer') {
    return { ok: typeof value === 'number' }
  }
  return { ok: true }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const INVALID_TOOLS: Array<{ name: string; config: unknown }> = [
  {
    name: 'both allowed and excluded domains',
    config: {
      providerOptions: {
        xai: {
          tools: [
            {
              type: 'web_search',
              allowedDomains: ['a.com'],
              excludedDomains: ['b.com'],
            },
          ],
        },
      },
    },
  },
  {
    name: '>5 domains',
    config: {
      providerOptions: {
        xai: {
          tools: [
            {
              type: 'web_search',
              allowedDomains: ['a.com', 'b.com', 'c.com', 'd.com', 'e.com', 'f.com'],
            },
          ],
        },
      },
    },
  },
  {
    name: 'duplicate web_search types',
    config: {
      providerOptions: {
        xai: {
          tools: [{ type: 'web_search' }, { type: 'web_search' }],
        },
      },
    },
  },
  {
    name: 'unknown tool key',
    config: {
      providerOptions: {
        xai: {
          tools: [{ type: 'web_search', bogus: true }],
        },
      },
    },
  },
  {
    name: 'unknown providerOptions.xai key',
    config: {
      providerOptions: { xai: { notARealKey: true } },
    },
  },
  {
    name: 'both allowed and excluded X handles',
    config: {
      providerOptions: {
        xai: {
          tools: [
            {
              type: 'x_search',
              allowedXHandles: ['a'],
              excludedXHandles: ['b'],
            },
          ],
        },
      },
    },
  },
  {
    name: '>20 X handles',
    config: {
      providerOptions: {
        xai: {
          tools: [
            {
              type: 'x_search',
              allowedXHandles: Array.from({ length: 21 }, (_, i) => `h${i}`),
            },
          ],
        },
      },
    },
  },
  {
    name: 'invalid x_search date',
    config: {
      providerOptions: {
        xai: {
          tools: [{ type: 'x_search', fromDate: 'not-a-date' }],
        },
      },
    },
  },
]

describe.each([
  ['grok-4.5', Grok45ConfigSchema],
  ['grok-4.6', Grok46ConfigSchema],
  ['grok-4.7', Grok47ConfigSchema],
] as const)('%s tools schema / JSON Schema parity', (_model, schema) => {
  it('accepts [web], [x], and [web, x]', () => {
    expect(
      schema.safeParse({
        providerOptions: { xai: { tools: [{ type: 'web_search' }] } },
      }).success,
    ).toBe(true)
    expect(
      schema.safeParse({
        providerOptions: { xai: { tools: [{ type: 'x_search' }] } },
      }).success,
    ).toBe(true)
    expect(
      schema.safeParse({
        providerOptions: {
          xai: { tools: [{ type: 'web_search' }, { type: 'x_search' }] },
        },
      }).success,
    ).toBe(true)
  })

  it.each(INVALID_TOOLS)('Zod and JSON Schema both reject $name', ({ config }) => {
    const zodOk = schema.safeParse(config).success
    const json = toConfigJsonSchema(schema)
    const jsonOk = jsonSchemaAccepts(json, config)
    expect(zodOk).toBe(false)
    expect(jsonOk).toBe(false)
  })
})
