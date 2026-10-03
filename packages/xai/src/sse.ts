/**
 * A minimal server-sent-events frame reader over a response body (ADR-040).
 *
 * The client reads the body itself instead of through the `openai` SDK's stream
 * iterator for three reasons the SDK iterator cannot serve: every chunk of raw
 * bytes (a `: heartbeat` comment included) is activity for the optional idle
 * timer, a frame that carries no event JSON (a bare `event: keepalive`) must be
 * skipped, not thrown as a `SyntaxError`, and the reducer, not the SDK, decides
 * what an `error` frame means.
 *
 * Follows the WHATWG EventSource framing: lines end in LF, CRLF or CR, a blank
 * line dispatches a frame, `:` starts a comment, `data` lines join with LF, and a
 * frame still open when the body ends is dropped.
 *
 * @module
 */

/** One dispatched frame. `data` is `''` for a frame with no `data` line. */
export interface SseFrame {
  event: string | undefined
  data: string
}

export interface SseReadOptions {
  /** Called once for every chunk of bytes read, before it is parsed. */
  onChunk?: () => void
  /**
   * Rejects when the request is aborted. Raced against every read so a body that
   * does not itself react to the abort cannot hold the call open.
   */
  aborted?: Promise<never>
}

/**
 * Reads `body` to its end, yielding each dispatched frame. Cancels the body when
 * the consumer stops early or the read fails.
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  options: SseReadOptions = {},
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  let event: string | undefined
  let data: string[] = []
  let first = true
  /** Applies one non-blank line to the open frame. */
  const field = (line: string): void => {
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const name = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (name === 'event') event = value
    else if (name === 'data') data.push(value)
  }
  try {
    for (;;) {
      const read = reader.read()
      const result = await (options.aborted === undefined
        ? read
        : Promise.race([read, options.aborted]))
      if (!result.done) options.onChunk?.()
      buffer += result.done
        ? decoder.decode()
        : decoder.decode(result.value, { stream: true })
      if (first && buffer.length > 0) {
        buffer = buffer.replace(/^\uFEFF/, '')
        first = false
      }
      // A CR that ends the buffer may be the first half of a CRLF: hold it back.
      const hold = !result.done && buffer.endsWith('\r') ? '\r' : ''
      const lines = buffer.slice(0, buffer.length - hold.length).split(/\r\n|\n|\r/)
      buffer = (lines.pop() ?? '') + hold
      for (const line of lines) {
        if (line !== '') {
          field(line)
        } else {
          if (event !== undefined || data.length > 0) {
            yield { event, data: data.join('\n') }
          }
          event = undefined
          data = []
        }
      }
      // A frame still open when the body ends was cut off and is dropped, as the
      // EventSource specification says: it never reached its blank line.
      if (result.done) return
    }
  } finally {
    // Release the connection whether the consumer finished, stopped or failed.
    reader.cancel().catch(() => undefined)
  }
}
