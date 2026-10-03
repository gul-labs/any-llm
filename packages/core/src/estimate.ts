/**
 * A cheap input-token estimate for pre-dispatch pacing.
 *
 * @module
 */

import type { Message, ToolDefinition } from './types.js'

/** Characters per token the estimate assumes. Deliberately the common rough figure. */
const CHARS_PER_TOKEN = 4

/**
 * Characters in `value` as JSON, or 0 when it has none to count (`undefined`)
 * or cannot be serialized (a cycle, a BigInt): the estimate must never fail a
 * call that the adapter itself may accept or refuse with its own error.
 */
function jsonLength(value: unknown): number {
  try {
    // `JSON.stringify(undefined)` is `undefined` although it is typed `string`.
    const text = JSON.stringify(value) as string | undefined
    return text === undefined ? 0 : text.length
  } catch {
    return 0
  }
}

/** The request fields {@link estimateInputTokens} reads. */
export interface EstimableRequest {
  system?: string
  messages: readonly Message[]
  tools?: readonly ToolDefinition[]
}

/**
 * Estimates a request's input tokens as the length, in characters, of the text
 * it carries divided by 4, rounded up: the system instruction, text parts, tool
 * call arguments, tool results and tool declarations (name, description, input
 * schema as JSON).
 *
 * **It is an estimate, not a count.** Inline media, file URIs and file
 * references carry no text and are not counted, so a request that carries them
 * is under-estimated, and a value that is not serializable counts as 0. Use it to pace (`RateLimiter.acquire`'s
 * `hint.estimatedInputTokens`), where the real usage reconciles the figure
 * after the call; never to bill or to refuse a call. For a provider's own count
 * use `client.countTokens`.
 */
export function estimateInputTokens(req: EstimableRequest): number {
  let chars = req.system?.length ?? 0
  for (const message of req.messages) {
    for (const part of message.parts) {
      switch (part.kind) {
        case 'text':
          chars += part.text.length
          break
        case 'tool-call':
          chars += part.toolName.length + jsonLength(part.args)
          break
        case 'tool-result':
          chars += part.toolName.length + jsonLength(part.result)
          break
        case 'inline-media':
        case 'file-uri':
        case 'file-ref':
          break
        default: {
          const exhaustive: never = part
          return exhaustive
        }
      }
    }
  }
  for (const tool of req.tools ?? []) {
    chars += tool.name.length + tool.description.length + jsonLength(tool.inputJsonSchema)
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}
