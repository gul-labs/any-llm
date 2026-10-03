/**
 * Token limits and admitted input media types for the registered Google
 * models, read from Google's own documentation on 2026-10-03.
 *
 * One table feeds both the descriptors (`limits`, `inputMimeTypes`) and the
 * per-model config schemas (`maxOutputTokens` is capped at
 * `limits.maxOutputTokens`), so a descriptor and its schema cannot drift.
 *
 * Sources, all read 2026-10-03:
 *
 * - Gemini: `https://ai.google.dev/gemini-api/docs/models/<model-id>`, one page
 *   per model. Every registered Gemini model lists "Input token limit
 *   1,048,576" and "Output token limit 65,536". The output limit includes
 *   thinking tokens.
 * - Gemma 4: the model card, `https://ai.google.dev/gemma/docs/core/model_card_4`,
 *   states a "256K tokens" context window (read as 262,144) and text and image
 *   input. Neither it nor `https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api`
 *   documents an output limit, so `maxOutputTokens` equals the context window
 *   (see {@link ModelLimits.maxOutputTokens}).
 * - Input media types: `https://ai.google.dev/gemini-api/docs/image-understanding`
 *   (`image/png`, `image/jpeg`, `image/webp`, `image/heic`, `image/heif`),
 *   `.../audio`, `.../video-understanding`, and `.../document-processing`
 *   (PDF is understood natively; TXT, Markdown, HTML and XML are extracted as
 *   plain text). The Gemma pages name no image media types; the two the Gemma
 *   vision examples use (`image/png`, `image/jpeg`) are admitted and nothing
 *   else.
 *
 * @module
 */

import type { ModelLimits } from '@gullabs/core'

export type GoogleModelId =
  | 'gemini-2.5-pro'
  | 'gemini-2.5-flash'
  | 'gemini-2.5-flash-lite'
  | 'gemini-3.1-flash-lite'
  | 'gemini-3.1-pro-preview'
  | 'gemini-3.8-flash'
  | 'gemini-3.7-flash'
  | 'gemini-3.6-flash'
  | 'gemini-3.5-flash-lite'
  | 'gemma-4-31b-it'
  | 'gemma-4-26b-a4b-it'

const GEMINI_LIMITS: ModelLimits = { contextWindow: 1_048_576, maxOutputTokens: 65_536 }
const GEMMA_4_LIMITS: ModelLimits = { contextWindow: 262_144, maxOutputTokens: 262_144 }

export const GOOGLE_MODEL_LIMITS: Readonly<Record<GoogleModelId, ModelLimits>> = {
  'gemini-2.5-pro': GEMINI_LIMITS,
  'gemini-2.5-flash': GEMINI_LIMITS,
  'gemini-2.5-flash-lite': GEMINI_LIMITS,
  'gemini-3.1-flash-lite': GEMINI_LIMITS,
  'gemini-3.1-pro-preview': GEMINI_LIMITS,
  'gemini-3.8-flash': GEMINI_LIMITS,
  'gemini-3.7-flash': GEMINI_LIMITS,
  'gemini-3.6-flash': GEMINI_LIMITS,
  'gemini-3.5-flash-lite': GEMINI_LIMITS,
  'gemma-4-31b-it': GEMMA_4_LIMITS,
  'gemma-4-26b-a4b-it': GEMMA_4_LIMITS,
}

/** Media types every Gemini model in the registry accepts as input parts. */
export const GEMINI_INPUT_MIME_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'image/heif',
  'audio/wav',
  'audio/mp3',
  'audio/aiff',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/mpeg',
  'audio/m4a',
  'audio/l16',
  'audio/opus',
  'audio/alaw',
  'audio/mulaw',
  'audio/webm',
  'video/mp4',
  'video/mpeg',
  'video/mov',
  'video/avi',
  'video/x-flv',
  'video/mpg',
  'video/webm',
  'video/wmv',
  'video/3gpp',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/html',
  'text/xml',
]

/** Media types the Gemma 4 models accept (text and image input only). */
export const GEMMA_INPUT_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg']
