---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/xai': minor
---

Citations say whether the answer cites them and where (`Citation.cited`, `Citation.textRange`), xAI drops numeric titles, and Google exposes `searchEntryPoint`.

`Citation` gains `cited?: boolean` (the answer text itself cites the source) and `textRange?: { start; end }` (the first span of `LlmResult.text` tied to the source, UTF-16 offsets, `text.slice(start, end)`). Gemini fills them from `groundingSupports` (a chunk a support points at is cited; Google's UTF-8 byte offsets are converted; no `groundingSupports` leaves both absent). xAI fills them from `url_citation` annotations: a non-empty range is an inline citation and covers xAI's inline `[[N]](url)` marker, a zero-width annotation is a source attached without an inline citation (`cited: false`).

`@gullabs/xai` no longer reports a numeric-only title (xAI's marker number, `"1"`) as `Citation.title`, so `title` is absent unless xAI sends a real one.

`@gullabs/google` surfaces `groundingMetadata.searchEntryPoint`, the Search Suggestions widget Google requires a grounded answer to display, at `providerMetadata.google.searchEntryPoint`. The raw `groundingMetadata` stays where it was.

What hosts must change: do not read `citation.title === '1'` as a title; a UI that needs the cited sources filters on `cited === true`.
