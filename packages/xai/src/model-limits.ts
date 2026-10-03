/**
 * Token limits and admitted input media types for the registered xAI models,
 * read from xAI's own documentation (re-read 2026-10-03).
 *
 * One table feeds both the descriptors (`limits`, `inputMimeTypes`) and the
 * per-model config schemas (`maxOutputTokens` is capped only when a number is
 * documented), so a descriptor and its schema cannot drift.
 *
 * Sources, all read 2026-10-03:
 *
 * - `https://docs.x.ai/developers/models/<model-id>` (grok-4.5, grok-4.6,
 *   grok-4.7): "Context window: 500,000 tokens", "Modalities: text, image →
 *   text". No page states a maximum output size, so `maxOutputTokens` is
 *   `null` (see {@link ModelLimits.maxOutputTokens}): no figure is invented and
 *   the schema applies no cap. xAI has been seen to accept far larger values
 *   (live 2026-10-02: 150,000, and 100,000,000 earlier); the docs name 128,000
 *   only as the default when the field is unset.
 * - `https://docs.x.ai/developers/model-capabilities/images/understanding`:
 *   "Supported image file types: jpg/jpeg or png"; WebP is not listed. Maximum
 *   image size 20 MiB. The page names file extensions, not media types. The IANA
 *   types for them are `image/jpeg` and `image/png`; `image/jpg` is not a
 *   registered media type and the page does not list it as a media type, so it
 *   is rejected rather than treated as an alias.
 *
 * @module
 */

import type { ModelLimits } from '@gullabs/core'

export type XaiModelId = 'grok-4.5' | 'grok-4.6' | 'grok-4.7'

/** One frozen object per model: no descriptor can change another's limits. */
const grok4Limits = (): ModelLimits =>
  Object.freeze({ contextWindow: 500_000, maxOutputTokens: null })

export const XAI_MODEL_LIMITS: Readonly<Record<XaiModelId, ModelLimits>> = {
  'grok-4.5': grok4Limits(),
  'grok-4.6': grok4Limits(),
  'grok-4.7': grok4Limits(),
}

/** Media types xAI accepts for image input. WebP and `image/jpg` are not among them. */
export const XAI_INPUT_MIME_TYPES: readonly string[] = Object.freeze([
  'image/jpeg',
  'image/png',
])
