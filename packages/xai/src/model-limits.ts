/**
 * Token limits and admitted input media types for the registered xAI models,
 * read from xAI's own documentation on 2026-10-03.
 *
 * One table feeds both the descriptors (`limits`, `inputMimeTypes`) and the
 * per-model config schemas (`maxOutputTokens` is capped at
 * `limits.maxOutputTokens`), so a descriptor and its schema cannot drift.
 *
 * Sources, all read 2026-10-03:
 *
 * - `https://docs.x.ai/developers/models/<model-id>` (grok-4.5, grok-4.6,
 *   grok-4.7): "Context window: 500,000 tokens", "Modalities: text, image →
 *   text". No page states a maximum output size, so `maxOutputTokens` equals
 *   the context window (see {@link ModelLimits.maxOutputTokens}). Live on
 *   2026-10-02 xAI accepted `max_output_tokens: 150000`, above the 128,000 the
 *   docs give as the default when the field is unset.
 * - `https://docs.x.ai/developers/model-capabilities/images/understanding`:
 *   "Supported image file types: jpg/jpeg or png"; WebP is not listed. Maximum
 *   image size 20 MiB.
 *
 * @module
 */

import type { ModelLimits } from '@gullabs/core'

export type XaiModelId = 'grok-4.5' | 'grok-4.6' | 'grok-4.7'

const GROK_4_LIMITS: ModelLimits = { contextWindow: 500_000, maxOutputTokens: 500_000 }

export const XAI_MODEL_LIMITS: Readonly<Record<XaiModelId, ModelLimits>> = {
  'grok-4.5': GROK_4_LIMITS,
  'grok-4.6': GROK_4_LIMITS,
  'grok-4.7': GROK_4_LIMITS,
}

/** Media types xAI accepts for image input. WebP is not among them. */
export const XAI_INPUT_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png']
