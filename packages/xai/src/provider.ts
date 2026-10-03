/**
 * `xaiProvider` — {@link ProviderPlugin} factory for @gullabs/xai.
 *
 * Bundles the xAI Grok adapter, the `grok-4.5` / `grok-4.6` / `grok-4.7`
 * model descriptors, and the xai pricing source into a single plugin for
 * {@link composeProviders}.
 *
 * @module
 */

import type { ProviderPlugin } from '@gullabs/core'

import { xaiAdapter } from './adapter.js'
import type { XaiAdapterOptions } from './adapter.js'
import { xaiModelDescriptors } from './models.js'
import { xaiPricingSource } from './pricing.js'

/**
 * Create a {@link ProviderPlugin} for the xAI Grok provider.
 *
 * @param opts - Forwarded to {@link xaiAdapter}.
 * @returns A plugin bundling the xAI adapter, the `grok-4.5` / `grok-4.6` /
 *   `grok-4.7` model descriptors, and the built-in xai pricing source.
 *
 * @example
 * ```ts
 * import { createClient, composeProviders } from '@gullabs/core'
 * import { xaiProvider } from '@gullabs/xai'
 *
 * const client = createClient({
 *   ...composeProviders([xaiProvider()]),
 * })
 * ```
 */
export function xaiProvider(opts?: XaiAdapterOptions): ProviderPlugin {
  return {
    adapter: xaiAdapter(opts),
    modelDescriptors: xaiModelDescriptors,
    pricingSource: xaiPricingSource(),
  }
}
