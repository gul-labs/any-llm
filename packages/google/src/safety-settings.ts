/**
 * The `safetySettings` categories and thresholds Gemini documents.
 *
 * Sources, read 2026-10-03:
 *
 * - Categories: ai.google.dev/api/generate-content (`HarmCategory`: hate speech,
 *   sexually explicit, dangerous content, harassment, civic integrity,
 *   jailbreak) and ai.google.dev/gemini-api/docs/safety-settings (page dated
 *   2026-09-17, the adjustable filters). The SDK's `HARM_CATEGORY_IMAGE_*`
 *   values are marked "not supported in Gemini API" and are not admitted.
 * - Thresholds: ai.google.dev/gemini-api/docs/safety-settings (page dated
 *   2026-09-17), cross-checked against the SDK's `HarmBlockThreshold` enum.
 *
 * The adapter and every model's config schema read these lists, so a typo is
 * rejected before dispatch instead of costing a round trip.
 *
 * @module
 */

export const GOOGLE_SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY',
  'HARM_CATEGORY_JAILBREAK',
] as const

export const GOOGLE_SAFETY_THRESHOLDS = [
  'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
  'BLOCK_LOW_AND_ABOVE',
  'BLOCK_MEDIUM_AND_ABOVE',
  'BLOCK_ONLY_HIGH',
  'BLOCK_NONE',
  'OFF',
] as const

export type GoogleSafetyCategory = (typeof GOOGLE_SAFETY_CATEGORIES)[number]
export type GoogleSafetyThreshold = (typeof GOOGLE_SAFETY_THRESHOLDS)[number]
