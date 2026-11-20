/**
 * Per-model request rules the adapter applies before dispatch, keyed by the
 * resolved descriptor's canonical model id. Core descriptors carry no field for
 * them (ADR-023: core holds no provider knowledge), so they live here, next to
 * the descriptors, and a host descriptor for another id gets none of them.
 *
 * Sources, all read 2026-11-20 (documented, not live-verified):
 *
 * - Final model turn: https://aistudio.google.com/docs/whats-new-gemini-3.6.md
 *   ("Starting with Gemini 3.6 Flash and Gemini 3.5 Flash-Lite, the following
 *   API changes apply to these models and all future Gemini model releases";
 *   "If the last non-empty turn in the request is a `model` turn, the API
 *   returns a `400` error").
 * - Final user text: https://aistudio.google.com/docs/whats-new-gemini-3.8.md
 *   ("ensure the final user turn contains non-empty text", in the 3.8 Flash
 *   migration checklist; no other model is named). A final turn made entirely of
 *   function responses is exempt: the live capture of 2026-10-03
 *   (`__fixtures__/thought-signatures-2026-10-03.json`) shows 3.8 Flash
 *   accepting a replay whose last turn holds only function responses.
 * - Gemini 4: the per-model pages under https://aistudio.google.com/docs/models
 *   and https://aistudio.google.com/docs/whats-new-gemini-4-carbon.md (default
 *   thinking level medium on Carbon and Argon, high on Neon and Hydrogen; "Set
 *   HTTP client timeouts to at least 20 minutes per call"), and
 *   https://aistudio.google.com/docs/thinking.md ("The `thinkingLevel` parameter,
 *   required for Gemini 4"). Search with Flex is not admitted: no page shows the
 *   combination and the Gemini 4 Flex price tab has no grounding row
 *   (https://aistudio.google.com/docs/pricing.md).
 *
 * @module
 */

/** A Gemini `ThinkingLevel` value the adapter sends. */
export type GeminiThinkingLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH'

/**
 * Default transport and client-side deadline (ms) for a Gemini 4 call with no
 * `timeoutMs` at the standard tier or with no tier (the standard dispatch after a
 * flex capacity error included): Google asks for "at least 20 minutes per call".
 * A flex call keeps `FLEX_DEFAULT_TIMEOUT_MS`.
 */
export const GEMINI_4_DEFAULT_TIMEOUT_MS = 1_200_000

/** The rules one model's requests follow. Every field absent means "no rule". */
export interface GoogleRequestRules {
  /**
   * The level sent when the host sets no effort (no `reasoning`, or
   * `reasoning: { includeThoughts }` alone). The model documents it as its
   * default, and the thinking guide calls `thinkingLevel` required, so sending
   * it is valid under both readings.
   */
  readonly defaultThinkingLevel?: GeminiThinkingLevel
  /** A request whose last non-empty turn is a model turn is rejected. */
  readonly rejectsFinalModelTurn?: true
  /**
   * The final turn, when it is a user turn, must hold text that is not all
   * whitespace, unless every part of it is a function response (tool result).
   */
  readonly requiresFinalUserText?: true
  /** Google Search is not admitted together with the flex tier. */
  readonly rejectsSearchWithFlex?: true
  /** The default deadline at the standard tier or with no tier, when `timeoutMs` is unset. */
  readonly standardDefaultTimeoutMs?: number
}

const GEMINI_4 = (defaultThinkingLevel: GeminiThinkingLevel): GoogleRequestRules =>
  Object.freeze({
    defaultThinkingLevel,
    rejectsFinalModelTurn: true,
    rejectsSearchWithFlex: true,
    standardDefaultTimeoutMs: GEMINI_4_DEFAULT_TIMEOUT_MS,
  })

const NO_FINAL_MODEL_TURN: GoogleRequestRules = Object.freeze({
  rejectsFinalModelTurn: true,
})

const RULES: Readonly<Record<string, GoogleRequestRules>> = Object.freeze({
  'gemini-3.5-flash-lite': NO_FINAL_MODEL_TURN,
  'gemini-3.6-flash': NO_FINAL_MODEL_TURN,
  'gemini-3.8-flash': Object.freeze({
    rejectsFinalModelTurn: true,
    requiresFinalUserText: true,
  }),
  'gemini-4-carbon': GEMINI_4('MEDIUM'),
  'gemini-4-argon': GEMINI_4('MEDIUM'),
  'gemini-4-neon': GEMINI_4('HIGH'),
  'gemini-4-hydrogen': GEMINI_4('HIGH'),
})

const NONE: GoogleRequestRules = Object.freeze({})

/** The rules for a canonical model id; an unlisted id has none. */
export function googleRequestRules(canonicalModel: string): GoogleRequestRules {
  return (
    (Object.hasOwn(RULES, canonicalModel) ? RULES[canonicalModel] : undefined) ?? NONE
  )
}
