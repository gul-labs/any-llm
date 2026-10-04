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
   * Rejects when the request is aborted. Every read waits on it too, so a body
   * that does not itself react to the abort cannot hold the call open.
   */
  aborted?: Promise<never>
}

/**
 * Reads `body` to its end, yielding each dispatched frame. Cancels the body when
 * the consumer stops early or the read fails.
 *
 * Linear in the bytes read: only each new chunk is scanned for line ends, and the
 * pieces of a line still open are joined once when it ends, so one event of many
 * megabytes in small chunks costs no more than the same bytes in few.
 */
export async function* readSseFrames(
  body: ReadableStream<Uint8Array>,
  options: SseReadOptions = {},
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  /** The pieces of the line still open (no line end seen yet). */
  let pieces: string[] = []
  /** The last chunk ended with CR: a LF opening the next chunk is the same line end. */
  let skipLf = false
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
  // One reaction on `aborted` for the whole read, not one per chunk.
  const abort: { happened: boolean; error: Error } = {
    happened: false,
    error: new Error('aborted'),
  }
  let wake: ((error: unknown) => void) | undefined
  options.aborted?.catch((error: unknown) => {
    abort.happened = true
    abort.error = error instanceof Error ? error : new Error(String(error))
    wake?.(error)
  })
  const nextChunk = (): Promise<
    Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>
  > => {
    if (abort.happened) return Promise.reject(abort.error)
    return new Promise((resolve, reject) => {
      wake = reject
      reader.read().then(resolve, reject)
    })
  }
  try {
    for (;;) {
      const result = await nextChunk()
      if (!result.done) options.onChunk?.()
      let text = result.done
        ? decoder.decode()
        : decoder.decode(result.value, { stream: true })
      if (first && text.length > 0) {
        text = text.replace(/^\uFEFF/, '')
        first = false
      }
      let start = 0
      if (skipLf && text.length > 0) {
        skipLf = false
        if (text.charCodeAt(0) === 0x0a) start = 1
      }
      const lineEnd = /[\r\n]/g
      lineEnd.lastIndex = start
      for (let end = lineEnd.exec(text); end !== null; end = lineEnd.exec(text)) {
        pieces.push(text.slice(start, end.index))
        const line = pieces.length === 1 ? (pieces[0] as string) : pieces.join('')
        pieces = []
        start = end.index + 1
        if (text.charCodeAt(end.index) === 0x0d) {
          if (start < text.length) {
            if (text.charCodeAt(start) === 0x0a) start += 1
          } else if (!result.done) {
            skipLf = true
          }
        }
        lineEnd.lastIndex = start
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
      if (start < text.length) pieces.push(text.slice(start))
      // A frame still open when the body ends was cut off and is dropped, as the
      // EventSource specification says: it never reached its blank line.
      if (result.done) return
    }
  } finally {
    wake = undefined
    // Release the connection whether the consumer finished, stopped or failed.
    reader.cancel().catch(() => undefined)
  }
}
