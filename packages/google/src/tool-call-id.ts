/**
 * Unique Gemini toolCallId allocation.
 *
 * Gemini does not always return a `functionCall.id` (the live capture shows the
 * Developer API doing so, `call_<number>`, but a response may omit it). When it
 * does not, the library synthesizes `anyllm_call_<name>_<n>`. A synthesized id
 * is library bookkeeping: it is never sent to Gemini (pairing of a response to
 * its call is by name and order, which is what Gemini documents), so it cannot
 * confuse the API, and it is allocated so it is unique among every id already
 * in the request's history. Provider-supplied ids are reserved first so a
 * fallback never collides with them, even when the provider id appears after an
 * id-less sibling.
 */

const SYNTHESIZED_PREFIX = 'anyllm_call_'

/** Whether `id` was synthesized by the library (and so must not be sent to Gemini). */
export function isSynthesizedToolCallId(id: string): boolean {
  return id.startsWith(SYNTHESIZED_PREFIX)
}

/** Collects non-empty provider-supplied ids so fallbacks skip them. */
export function reserveProviderToolCallIds(
  ids: Iterable<string | undefined>,
): Set<string> {
  const reserved = new Set<string>()
  for (const id of ids) {
    if (typeof id === 'string' && id.length > 0) reserved.add(id)
  }
  return reserved
}

/**
 * Next `anyllm_call_${toolName}_${n}` that is not in `reserved`.
 *
 * `counterKey` lets functionCall vs functionResponse keep independent
 * sequences so two id-less pairs of the same name still line up.
 */
function nextFallbackToolCallId(
  toolName: string,
  counters: Map<string, number>,
  reserved: Set<string>,
  counterKey: string = toolName,
): string {
  let n = counters.get(counterKey) ?? 0
  let id: string
  do {
    n += 1
    id = `${SYNTHESIZED_PREFIX}${toolName}_${n}`
  } while (reserved.has(id))
  counters.set(counterKey, n)
  return id
}

export function resolveToolCallId(
  providerId: string | undefined,
  toolName: string,
  counters: Map<string, number>,
  reserved: Set<string>,
  counterKey?: string,
): string {
  if (typeof providerId === 'string' && providerId.length > 0) {
    return providerId
  }
  return nextFallbackToolCallId(toolName, counters, reserved, counterKey ?? toolName)
}
