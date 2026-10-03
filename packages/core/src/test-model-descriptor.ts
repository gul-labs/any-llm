import { z } from 'zod'

import { toConfigJsonSchema, zodToStandardSchema } from './model-config/index.js'
import type { ModelDescriptor } from './registry.js'

/** Fixture limits for engine tests that do not care about token limits. */
const TEST_LIMITS = { contextWindow: 1_000_000, maxOutputTokens: 65_536 }

const EmptyConfigSchema = z
  .strictObject({})
  .meta({ title: 'EmptyConfig', description: 'Test schema.', examples: [{}] })

const EmptyConfigJsonSchema = toConfigJsonSchema(EmptyConfigSchema)
const EmptyConfigValidator = zodToStandardSchema(EmptyConfigSchema)

export function makeTestDescriptor(
  overrides: Partial<ModelDescriptor> & Pick<ModelDescriptor, 'model' | 'provider'>,
): ModelDescriptor {
  const { model, provider, ...rest } = overrides

  return {
    limits: TEST_LIMITS,
    ...rest,
    model,
    provider,
    configSchema: EmptyConfigSchema,
    configJsonSchema: EmptyConfigJsonSchema,
    validateConfig: EmptyConfigValidator,
  }
}

/**
 * A permissive `z.looseObject({})` config schema — accepts arbitrary keys.
 *
 * For engine-level integration tests (retry, structured output, call-site,
 * middleware, rate-limiting, …) that exercise `GenConfig` fields
 * (`temperature`, `providerOptions`, …) without wanting to replicate a real
 * provider's strict per-field schema. Use {@link makeTestDescriptor} instead
 * when a test specifically needs strict-schema rejection behavior.
 */
const PermissiveConfigSchema = z.looseObject({}).meta({
  title: 'PermissiveConfig',
  description: 'Permissive test schema.',
  examples: [{}],
})

const PermissiveConfigJsonSchema = toConfigJsonSchema(PermissiveConfigSchema)
const PermissiveConfigValidator = zodToStandardSchema(PermissiveConfigSchema)

export function makePermissiveTestDescriptor(
  overrides: Partial<ModelDescriptor> & Pick<ModelDescriptor, 'model' | 'provider'>,
): ModelDescriptor {
  const { model, provider, ...rest } = overrides

  return {
    limits: TEST_LIMITS,
    ...rest,
    model,
    provider,
    configSchema: PermissiveConfigSchema,
    configJsonSchema: PermissiveConfigJsonSchema,
    validateConfig: PermissiveConfigValidator,
  }
}
