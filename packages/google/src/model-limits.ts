/**
 * Token limits and admitted input media types for the registered Google
 * models, read from Google's own documentation (re-read 2026-10-03).
 *
 * One table feeds both the descriptors (`limits`, `inputMimeTypes`) and the
 * per-model config schemas (`maxOutputTokens` is capped only when a number is
 * documented), so a descriptor and its schema cannot drift.
 *
 * Sources, all read 2026-10-03:
 *
 * - Gemini: `https://ai.google.dev/gemini-api/docs/models/<model-id>`, one page
 *   per model. Every registered Gemini model lists "Input token limit
 *   1,048,576" and "Output token limit 65,536". The output limit includes
 *   thinking tokens.
 * - Gemma 4: the model card, `https://ai.google.dev/gemma/docs/core/model_card_4`,
 *   states a "256K tokens" context window (read as 262,144). Neither it nor
 *   `https://ai.google.dev/gemma/docs/core/gemma_on_gemini_api` documents an
 *   output limit, so `maxOutputTokens` is `null` (see
 *   {@link ModelLimits.maxOutputTokens}): no figure is invented and the schema
 *   applies no cap.
 * - Gemini input media: Google publishes lists for images
 *   (`https://ai.google.dev/gemini-api/docs/image-understanding`: PNG, JPEG,
 *   WebP, HEIC, HEIF), audio (`.../audio`), and video
 *   (`.../video-understanding`), but no closed list for documents:
 *   `.../document-processing` says only that PDF is understood natively and
 *   "you can pass other MIME types for document understanding, like TXT,
 *   Markdown, HTML, XML, etc.", extracted as plain text. `.../files` lists no
 *   types either. The descriptor therefore admits the documented families by
 *   prefix (`text/*`, `image/*`, `audio/*`, `video/*`) plus `application/pdf`,
 *   and leaves a type inside a family that Google does not accept to Google's
 *   own error. `application/json`, `application/xml` and other `application/*`
 *   types are not in any documented family and stay rejected.
 * - Gemma 4 input media: the model card lists "Supported Modalities: Text,
 *   Image" for the 31B and 26B A4B models and says "All models support image
 *   inputs and can process videos as frames", with video "a maximum of 60
 *   seconds" at one frame per second; audio input is E2B/E4B/12B only. No Gemma
 *   page names image or video media types, so `image/*` and `video/*` are
 *   admitted and nothing else. That the Gemini API's Gemma endpoint takes a
 *   video part (rather than frames sent as images) has not been probed.
 *
 * @module
 */

import type { ModelLimits } from '@gullabs/core'

type GoogleModelId =
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

/** One frozen object per model: no descriptor can change another's limits. */
const geminiLimits = (): ModelLimits =>
  Object.freeze({ contextWindow: 1_048_576, maxOutputTokens: 65_536 })
const gemma4Limits = (): ModelLimits =>
  Object.freeze({ contextWindow: 262_144, maxOutputTokens: null })

export const GOOGLE_MODEL_LIMITS: Readonly<Record<GoogleModelId, ModelLimits>> = {
  'gemini-2.5-pro': geminiLimits(),
  'gemini-2.5-flash': geminiLimits(),
  'gemini-2.5-flash-lite': geminiLimits(),
  'gemini-3.1-flash-lite': geminiLimits(),
  'gemini-3.1-pro-preview': geminiLimits(),
  'gemini-3.8-flash': geminiLimits(),
  'gemini-3.7-flash': geminiLimits(),
  'gemini-3.6-flash': geminiLimits(),
  'gemini-3.5-flash-lite': geminiLimits(),
  'gemma-4-31b-it': gemma4Limits(),
  'gemma-4-26b-a4b-it': gemma4Limits(),
}

/**
 * Media types every Gemini model in the registry accepts as input parts: the
 * documented families (text, image, audio, video) and PDF. See the module
 * comment for why the families are not closed lists. One rule serves
 * `generate` and `GoogleFileStore.upload`.
 */
export const GEMINI_INPUT_MIME_TYPES: readonly string[] = Object.freeze([
  'application/pdf',
  'text/*',
  'image/*',
  'audio/*',
  'video/*',
])

/** Media types the Gemma 4 models accept: image and video (frames), no audio. */
export const GEMMA_INPUT_MIME_TYPES: readonly string[] = Object.freeze([
  'image/*',
  'video/*',
])
