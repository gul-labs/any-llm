/**
 * normalizeGroundingCitations — shape Gemini's raw groundingMetadata
 * (`groundingChunks`, `groundingSupports`, `webSearchQueries`) into a clean,
 * deduplicated citation list and a search-query count.
 *
 * These are pure shaping helpers, NOT request validation. They NEVER throw:
 * any missing/malformed input yields an empty or absent result.
 *
 * @module
 */

import type { Citation, JsonValue } from '@gullabs/core'

/**
 * Derive a human-readable source name for a hostname, stripping a leading
 * `www.` label (e.g. `www.example.com` → `example.com`).
 */
function hostnameFrom(url: URL): string {
  return url.hostname.startsWith('www.') ? url.hostname.slice(4) : url.hostname
}

/**
 * Shape a single grounding chunk into a `Citation`, or `undefined` if the
 * chunk is malformed (missing/invalid `web.uri`, or a `web.uri` that isn't
 * a well-formed http(s) URL with a hostname).
 *
 * Real SDK shape (`@google/genai` `GroundingChunk.web`): `{ uri, title, domain }`,
 * which in practice is always an http(s) URL. This helper only ever produces
 * http(s) citations — any other scheme (`javascript:`, `mailto:`, `data:`,
 * `file:`, etc.) is treated as a malformed chunk and skipped, since callers
 * may render `Citation.url` as a clickable link.
 *
 * `title`, when present, is the human-readable page title and is preferred
 * over the hostname as `sourceName`; the hostname (parsed from `uri`) is the
 * robust fallback when `title` is absent.
 */
function toCitation(chunk: unknown): Citation | undefined {
  if (chunk === null || typeof chunk !== 'object') return undefined

  const web = (chunk as Record<string, unknown>)['web']
  if (web === null || typeof web !== 'object') return undefined

  const uri = (web as Record<string, unknown>)['uri']
  if (typeof uri !== 'string' || uri.length === 0) return undefined

  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return undefined
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (parsed.hostname === '') return undefined

  const title = (web as Record<string, unknown>)['title']
  const hasTitle = typeof title === 'string' && title.length > 0
  const sourceName = hasTitle ? title : hostnameFrom(parsed)

  return {
    url: uri,
    ...(hasTitle ? { title } : {}),
    sourceName,
  }
}

/** The answer text one `Segment.partIndex` refers to, and where it sits in `LlmResult.text`. */
export interface AnswerTextPart {
  text: string
  /** UTF-16 offset of this part's text within the joined answer text. */
  offset: number
}

/**
 * The number of UTF-16 code units of `text` that precede UTF-8 byte offset
 * `byte`, or `undefined` when `byte` is out of range or splits a character.
 */
function utf16IndexAtByte(text: string, byte: number): number | undefined {
  if (!Number.isInteger(byte) || byte < 0) return undefined
  let bytes = 0
  let units = 0
  if (byte === 0) return 0
  for (const char of text) {
    const code = char.codePointAt(0) as number
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    units += char.length
    if (bytes === byte) return units
    if (bytes > byte) return undefined
  }
  return undefined
}

/**
 * Convert a Gemini grounding `Segment` into a range of the joined answer text.
 *
 * Gemini measures `startIndex` and `endIndex` in UTF-8 bytes from the start of
 * the part named by `partIndex` (Google's `Segment` reference); an omitted
 * field is zero (proto3 JSON drops zeros). The result is in UTF-16 code units
 * of the joined text, as `Citation.textRange` promises. A segment that names a
 * part that is not answer text, or whose offsets do not land on character
 * boundaries, has no range.
 */
function segmentRange(
  segment: unknown,
  answerParts: ReadonlyArray<AnswerTextPart | undefined>,
): { start: number; end: number } | undefined {
  if (segment === null || typeof segment !== 'object') return undefined
  const raw = segment as Record<string, unknown>
  const partIndex = raw['partIndex'] ?? 0
  const startByte = raw['startIndex'] ?? 0
  const endByte = raw['endIndex']
  if (
    typeof partIndex !== 'number' ||
    typeof startByte !== 'number' ||
    typeof endByte !== 'number'
  ) {
    return undefined
  }
  const part = answerParts[partIndex]
  if (part === undefined) return undefined
  const start = utf16IndexAtByte(part.text, startByte)
  const end = utf16IndexAtByte(part.text, endByte)
  if (start === undefined || end === undefined || end <= start) return undefined
  return { start: part.offset + start, end: part.offset + end }
}

/**
 * Which chunk indices `groundingSupports` points at, and the first range each
 * one supports. `undefined` when the metadata has no `groundingSupports`
 * array, because the provider then says nothing about what the text cites.
 */
function readSupports(
  groundingMetadata: Record<string, unknown>,
  answerParts: ReadonlyArray<AnswerTextPart | undefined>,
): Map<number, { start: number; end: number } | undefined> | undefined {
  const supports = groundingMetadata['groundingSupports']
  if (!Array.isArray(supports)) return undefined
  const byChunk = new Map<number, { start: number; end: number } | undefined>()
  for (const support of supports) {
    if (support === null || typeof support !== 'object') continue
    const record = support as Record<string, unknown>
    const indices = record['groundingChunkIndices']
    if (!Array.isArray(indices)) continue
    const range = segmentRange(record['segment'], answerParts)
    for (const index of indices) {
      if (typeof index !== 'number') continue
      // The first usable range wins; any support keeps the chunk cited.
      if (!byChunk.has(index) || (byChunk.get(index) === undefined && range)) {
        byChunk.set(index, range)
      }
    }
  }
  return byChunk
}

/**
 * Shape Gemini's raw `groundingMetadata.groundingChunks` into a clean,
 * deduplicated citation list (deduplicated by URL, first-seen order).
 *
 * `groundingSupports`, when present, sets `cited` (a support points at the
 * chunk) and `textRange` (the first segment that does). Chunks that share a URL
 * merge: cited if any is, first range wins. `answerParts` maps a segment's
 * `partIndex` to the answer text it indexes; without it no `textRange` is set.
 *
 * Accepts `unknown` since `groundingMetadata` arrives as raw JSON on
 * `providerMetadata` (see `docs/grounded-structured.md`). Never throws —
 * any missing/malformed top-level shape returns `[]`; a malformed individual
 * chunk is skipped rather than failing the whole array.
 */
export function normalizeGroundingCitations(
  groundingMetadata: unknown,
  answerParts: ReadonlyArray<AnswerTextPart | undefined> = [],
): Citation[] {
  if (groundingMetadata === null || typeof groundingMetadata !== 'object') return []

  const metadata = groundingMetadata as Record<string, unknown>
  const chunks = metadata['groundingChunks']
  if (!Array.isArray(chunks)) return []

  const supports = readSupports(metadata, answerParts)
  const byUrl = new Map<string, Citation>()

  chunks.forEach((chunk, chunkIndex) => {
    const citation = toCitation(chunk)
    if (citation === undefined) return
    const existing = byUrl.get(citation.url)
    const target = existing ?? citation
    if (existing === undefined) byUrl.set(citation.url, citation)
    if (supports === undefined) return
    if (supports.has(chunkIndex)) {
      target.cited = true
      const range = supports.get(chunkIndex)
      if (range !== undefined && target.textRange === undefined) target.textRange = range
    } else if (target.cited === undefined) {
      target.cited = false
    }
  })

  return [...byUrl.values()]
}

/**
 * The number of search queries Gemini reports in `webSearchQueries`, counted as
 * occurrences (a repeated query counts each time). `undefined` when the
 * metadata is absent or has no `webSearchQueries` array: the count is unknown,
 * which is different from a reported zero.
 */
export function countWebSearchQueries(groundingMetadata: unknown): number | undefined {
  if (groundingMetadata === null || typeof groundingMetadata !== 'object') {
    return undefined
  }
  const queries = (groundingMetadata as Record<string, unknown>)['webSearchQueries']
  return Array.isArray(queries) ? queries.length : undefined
}

/**
 * `groundingMetadata.searchEntryPoint`, the Search Suggestions widget Google
 * requires a grounded answer to display, when it is a non-empty object.
 */
export function readSearchEntryPoint(
  groundingMetadata: unknown,
): { [key: string]: JsonValue } | undefined {
  if (groundingMetadata === null || typeof groundingMetadata !== 'object') {
    return undefined
  }
  const entry = (groundingMetadata as Record<string, unknown>)['searchEntryPoint']
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    return undefined
  }
  return Object.keys(entry).length > 0
    ? (entry as { [key: string]: JsonValue })
    : undefined
}
