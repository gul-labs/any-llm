/**
 * `openaiProvider` — {@link ProviderPlugin} factory for `@gullabs/openai`.
 *
 * Bundles the OpenAI adapter, the `gpt-6.2-astra` / `gpt-6.2-sol` /
 * `gpt-6.1-terra` / `gpt-6-luna` descriptors and the openai pricing source into
 * one plugin for {@link composeProviders}.
 *
 * @module
 */

import type { ProviderPlugin } from '@gullabs/core'

import { openaiAdapter } from './adapter.js'
import type { OpenAiAdapterOptions } from './adapter.js'
import { openaiModelDescriptors } from './models.js'
import { openaiPricingSource } from './pricing.js'

/**
 * Create a {@link ProviderPlugin} for OpenAI.
 *
 * @param opts - Forwarded to {@link openaiAdapter}.
 *
 * @example
 * ```ts
 * import { createClient, composeProviders } from '@gullabs/core'
 * import { openaiProvider } from '@gullabs/openai'
 *
 * const client = createClient({ ...composeProviders([openaiProvider()]) })
 * ```
 */
export function openaiProvider(opts?: OpenAiAdapterOptions): ProviderPlugin {
  return {
    adapter: openaiAdapter(opts),
    modelDescriptors: openaiModelDescriptors,
    pricingSource: openaiPricingSource(),
  }
}
