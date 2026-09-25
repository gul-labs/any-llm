/**
 * Generic `PricingSource` test fixture builder for @gullabs/core.
 *
 * Core carries no pricing tables of its own — engine-level integration tests
 * still need a real (if synthetic) `PricingSource` to exercise the cost
 * pipeline end-to-end. This helper builds one from a caller-supplied rates
 * table via `computeCost`, mirroring the exact-then-longest-prefix lookup
 * strategy a provider package (e.g. `@gullabs/google`) would implement.
 *
 * Sibling to `test-model-descriptor.ts` — both are non-`.test.ts` helpers
 * kept in `src/` because they're imported across multiple test files.
 *
 * @module
 */

import { computeCost } from './cost.js'
import type { ModelRates } from './pricing.js'
import type { PricingSource } from './ports.js'
import type { Cost, Usage } from './types.js'

/**
 * Build a test {@link PricingSource}.
 *
 * `rates` may be a flat standard table, or a per-tier table. A flat table
 * prices `undefined` and `'standard'` at those rates and leaves every other
 * defined tier unpriced. A per-tier table (`{ standard, flex, batch }`)
 * resolves the named tier; `undefined` uses `standard`.
 */
export function makeTestPricingSource(
  rates:
    | Readonly<Record<string, ModelRates>>
    | Readonly<Record<string, Readonly<Record<string, ModelRates>>>>,
  version: string,
): PricingSource {
  function lookup(model: string, tier: string | undefined): ModelRates | undefined {
    if (isTieredTable(rates)) {
      const entry = lookupKey(rates, model)
      if (entry === undefined) return undefined
      const key = tier ?? 'standard'
      return entry[key]
    }
    if (tier !== undefined && tier !== 'standard') return undefined
    return lookupKey(rates, model)
  }

  return {
    version,
    price(model: string, usage: Usage, tier?: string): Cost {
      return computeCost(model, usage, tier, lookup, version)
    },
    hasModel(model: string): boolean {
      return lookup(model, undefined) !== undefined
    },
    listModels(): readonly string[] {
      return Object.keys(rates)
    },
  }
}

function lookupKey<T>(table: Readonly<Record<string, T>>, model: string): T | undefined {
  const exact = table[model]
  if (exact !== undefined) return exact

  let bestKey = ''
  let best: T | undefined
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && key.length > bestKey.length) {
      bestKey = key
      best = table[key]
    }
  }
  return best
}

function isTieredTable(
  rates:
    | Readonly<Record<string, ModelRates>>
    | Readonly<Record<string, Readonly<Record<string, ModelRates>>>>,
): rates is Readonly<Record<string, Readonly<Record<string, ModelRates>>>> {
  const values = Object.values(rates) as ReadonlyArray<
    ModelRates | Readonly<Record<string, ModelRates>>
  >
  const first = values[0]
  if (first === undefined) return false
  return !('inputPerM' in first)
}
