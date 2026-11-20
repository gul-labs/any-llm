/**
 * Token limits and admitted image media types for the registered OpenAI models,
 * read from OpenAI's documentation on 2026-11-20. Documented, not live-verified:
 * no OpenAI call of any kind was made for this package.
 *
 * One table feeds both the descriptors (`limits`, `inputMimeTypes`) and the
 * per-model config schemas (`maxOutputTokens` is capped at the documented
 * figure), so a descriptor and its schema cannot drift.
 *
 * Sources, all read 2026-11-20:
 *
 * - `https://developers.openai.com/api/docs/models/<model-id>` (gpt-6.2-astra,
 *   gpt-6.2-sol, gpt-6.1-terra, gpt-6-luna): context window 1,050,000 tokens,
 *   max output 128,000 tokens, input text and image, output text.
 * - `https://developers.openai.com/api/docs/guides/images-vision` ("Image input
 *   requirements"): "PNG (`.png`), JPEG (`.jpeg` or `.jpg`), WEBP (`.webp`), and
 *   non-animated GIF (`.gif`)"; "Up to 512 MB total payload per request"; "Up to
 *   1,500 images per request". The page names file types, not media types; the
 *   IANA types for them are `image/png`, `image/jpeg`, `image/webp` and
 *   `image/gif`. `image/jpg` is not a registered media type and is rejected
 *   rather than treated as an alias. Whether a GIF is animated is not checked
 *   here (the bytes are not decoded); an animated GIF is the provider's to refuse.
 *
 * @module
 */

import type { ModelLimits } from '@gullabs/core'

/** The model ids this package registers, in registry order. */
export type OpenAiModelId =
  'gpt-6.2-astra' | 'gpt-6.2-sol' | 'gpt-6.1-terra' | 'gpt-6-luna'

/** One frozen object per model: no descriptor can change another's limits. */
const gpt6Limits = (): ModelLimits =>
  Object.freeze({ contextWindow: 1_050_000, maxOutputTokens: 128_000 })

export const OPENAI_MODEL_LIMITS: Readonly<Record<OpenAiModelId, ModelLimits>> = {
  'gpt-6.2-astra': gpt6Limits(),
  'gpt-6.2-sol': gpt6Limits(),
  'gpt-6.1-terra': gpt6Limits(),
  'gpt-6-luna': gpt6Limits(),
}

/** Media types OpenAI documents for image input. */
export const OPENAI_INPUT_MIME_TYPES: readonly string[] = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
])

/** "Up to 1,500 images per request" (images guide, read 2026-11-20). */
export const OPENAI_MAX_IMAGES_PER_REQUEST = 1_500

/**
 * "Up to 512 MB total payload per request" (images guide, read 2026-11-20). MB is
 * read as MiB, the looser reading; the adapter compares it with the base64 text
 * of the request's inline images, which is what the payload carries.
 */
export const OPENAI_MAX_INLINE_IMAGE_PAYLOAD_BYTES = 512 * 1024 * 1024
