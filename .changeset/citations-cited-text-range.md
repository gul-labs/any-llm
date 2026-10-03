---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/xai': minor
---

Citations say whether the answer cites them and where (`Citation.cited`, `Citation.textRange`), xAI drops numeric titles, and Google exposes `searchEntryPoint`.

`Citation` gains `cited?: boolean` (the answer text itself cites the source) and `textRange?: { start; end }` (the first span of `LlmResult.text` tied to the source, UTF-16 offsets, `text.slice(start, end)`). Gemini fills them from `groundingSupports` (a chunk a support points at is cited; Google's UTF-8 byte offsets are converted; no `groundingSupports` leaves both absent). xAI fills them from `url_citation` annotations: a non-empty range is an inline citation and covers xAI's inline `[[N]](url)` marker; a zero-width annotation leaves `cited` absent (no marker range reported, which is not "not cited").

`@gullabs/xai` no longer reports the numeric label of the source's own inline marker (`"1"`) as `Citation.title`; a real numeric title is kept.

`@gullabs/google` surfaces `groundingMetadata.searchEntryPoint`, the Search Suggestions widget Google requires a grounded answer to display, at `providerMetadata.google.searchEntryPoint`. The raw `groundingMetadata` stays where it was.

What hosts must change: do not read `citation.title === '1'` as a title; a UI that needs the sources with an inline marker filters on `cited === true`; on xAI a missing `cited` means unknown, not uncited.
