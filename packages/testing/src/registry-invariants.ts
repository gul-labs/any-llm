/**
 * Shared model-onboarding invariant assertions for provider packages.
 *
 * Extracted from the invariant checks that used to live in
 * `packages/core/src/registry.test.ts` and now live in each provider
 * package's own registry/model tests (e.g. `packages/google/src/models.test.ts`).
 * Every provider package's model tests should call
 * {@link assertRegistryInvariants} instead of hand-rolling the same checks,
 * so "what does it mean to onboard a model correctly" is defined once.
 *
 * Framework-agnostic: assertions throw plain `AssertionError`s (via
 * `node:assert/strict`) rather than depending on a specific test runner, so
 * this helper works unmodified under vitest (or any other runner) from
 * inside an `it(...)` block.
 *
 * @module
 */

import assert from 'node:assert/strict'

import { toConfigJsonSchema, toConfigKeys } from '@gullabs/core'
import type { ModelDescriptor, PricingSource } from '@gullabs/core'

export interface AssertRegistryInvariantsOptions {
  /** Every descriptor the provider package registers, in registration order. */
  descriptors: ModelDescriptor[]
  /**
   * The pinned, explicit list of model ids that must be registered — in
   * order. Guards against silently adding/removing/reordering models.
   */
  expectedModelIds: readonly string[]
  /**
   * Pricing source to check each descriptor against. When omitted, the
   * pricing invariant is skipped entirely (e.g. dev-only CLI providers that
   * carry no pricing concept at all).
   */
  pricingSource?: PricingSource
  /**
   * Model ids that are deliberately unpriced (a conscious decision, not an
   * oversight). Only consulted when {@link pricingSource} is provided.
   */
  explicitlyUnpriced?: ReadonlySet<string>
  /**
   * Model ids with a positive adapter contract fixture. When omitted, the
   * fixture-membership check is skipped (CLI providers have no adapter
   * fixture convention).
   */
  adapterFixtureModelIds?: readonly string[]
  /**
   * Model ids with a negative adapter contract fixture. When omitted, the
   * fixture-membership check is skipped.
   */
  negativeContractFixtureModelIds?: readonly string[]
}

/**
 * Assert the standard set of model-onboarding invariants for a provider
 * package's registry:
 *
 * - Every descriptor carries all three schema artifacts
 *   (`configSchema`/`configJsonSchema`/`validateConfig`).
 * - `configJsonSchema` is not stale relative to `configSchema`
 *   (`configJsonSchema === toConfigJsonSchema(configSchema)`).
 * - `configKeys` equals `toConfigKeys(configSchema)`.
 * - `limits` are positive integers with `maxOutputTokens <= contextWindow`, and a
 *   config schema that has a `maxOutputTokens` field accepts exactly up to
 *   `limits.maxOutputTokens` and rejects one more.
 * - The registered model-id list matches {@link
 *   AssertRegistryInvariantsOptions.expectedModelIds} exactly, in order.
 * - When a {@link AssertRegistryInvariantsOptions.pricingSource} is given,
 *   every model is either priced or explicitly marked unpriced.
 * - When fixture-list options are given, every model appears in them.
 *
 * Throws a `node:assert` `AssertionError` on the first violated invariant.
 */
export function assertRegistryInvariants(opts: AssertRegistryInvariantsOptions): void {
  const {
    descriptors,
    expectedModelIds,
    pricingSource,
    explicitlyUnpriced,
    adapterFixtureModelIds,
    negativeContractFixtureModelIds,
  } = opts

  assert.deepStrictEqual(
    descriptors.map((descriptor) => descriptor.model),
    [...expectedModelIds],
    'registered model-id list does not match the pinned expected-model-id list',
  )

  const adapterFixtureSet =
    adapterFixtureModelIds !== undefined ? new Set(adapterFixtureModelIds) : undefined
  const negativeFixtureSet =
    negativeContractFixtureModelIds !== undefined
      ? new Set(negativeContractFixtureModelIds)
      : undefined

  for (const descriptor of descriptors) {
    const { model } = descriptor

    assert.notStrictEqual(
      descriptor.configSchema,
      undefined,
      `${model}: missing required schema artifact "configSchema"`,
    )
    assert.notStrictEqual(
      descriptor.configJsonSchema,
      undefined,
      `${model}: missing required schema artifact "configJsonSchema"`,
    )
    assert.notStrictEqual(
      descriptor.validateConfig,
      undefined,
      `${model}: missing required schema artifact "validateConfig"`,
    )

    assert.deepStrictEqual(
      descriptor.configJsonSchema,
      toConfigJsonSchema(descriptor.configSchema),
      `${model}: configJsonSchema is stale relative to configSchema`,
    )

    const limits = descriptor.limits as ModelDescriptor['limits'] | undefined
    assert.ok(limits !== undefined, `${model}: missing required limits`)
    for (const key of ['contextWindow', 'maxOutputTokens'] as const) {
      assert.ok(
        Number.isSafeInteger(limits[key]) && limits[key] > 0,
        `${model}: limits.${key} must be a positive integer`,
      )
    }
    assert.ok(
      limits.maxOutputTokens <= limits.contextWindow,
      `${model}: limits.maxOutputTokens is above limits.contextWindow`,
    )
    // A schema without a `maxOutputTokens` field (the CLI providers) has no cap
    // to check; `configKeys` says whether it has one.
    if (descriptor.configKeys.includes('maxOutputTokens')) {
      assert.ok(
        descriptor.configSchema.safeParse({ maxOutputTokens: limits.maxOutputTokens })
          .success,
        `${model}: config schema must accept maxOutputTokens up to limits.maxOutputTokens`,
      )
      assert.ok(
        !descriptor.configSchema.safeParse({
          maxOutputTokens: limits.maxOutputTokens + 1,
        }).success,
        `${model}: config schema must cap maxOutputTokens at limits.maxOutputTokens`,
      )
    }

    assert.deepStrictEqual(
      [...descriptor.configKeys],
      [...toConfigKeys(descriptor.configSchema)],
      `${model}: configKeys is stale relative to configSchema`,
    )

    if (adapterFixtureSet !== undefined) {
      assert.ok(
        adapterFixtureSet.has(model),
        `${model}: missing a positive adapter contract fixture`,
      )
    }

    if (negativeFixtureSet !== undefined) {
      assert.ok(
        negativeFixtureSet.has(model),
        `${model}: missing a negative adapter contract fixture`,
      )
    }

    if (pricingSource !== undefined) {
      const pricingKey = descriptor.pricingFamily ?? model
      const hasPricing = pricingSource.hasModel(pricingKey)
      const hasExplicitUnpricedDecision = explicitlyUnpriced?.has(model) ?? false

      assert.ok(
        hasPricing || hasExplicitUnpricedDecision,
        `${model}: neither priced nor explicitly marked unpriced`,
      )
    }
  }
}
