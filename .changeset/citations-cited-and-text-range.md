---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/xai': minor
---

Citations say whether the answer cites them and where (`Citation.cited`, `Citation.textRange`), and Google exposes `searchEntryPoint`.

- **`Citation`** gains `cited?: boolean` (the answer text itself cites the source) and `textRange?: { start; end }` (the first span of `LlmResult.text` tied to the source, UTF-16 offsets, `text.slice(start, end)`).
- **Gemini** fills them from `groundingSupports`: a chunk a support points at is cited, Google's UTF-8 byte offsets are converted (`partIndex` does not count thought parts, and the answer part is indexed among the non-thought parts), and no `groundingSupports` leaves both absent. Each range is checked against `groundingSupports[].segment.text`: when the slice of `result.text` is not exactly that text the range is dropped, the source stays `cited: true`, and the result carries a warning.
- **xAI** fills them from `url_citation` annotations: a non-empty range is verified (the slice of `result.text` must be exactly `[[N]](<the source's url>)`, indexed from the start of the `output_text` part that carries the annotation, in UTF-16 code units) and gives `cited: true`; a wrong range is dropped with a warning and the source stays `cited: true`. A zero-width annotation leaves `cited` absent, because xAI reported no marker range, which says nothing about whether the answer cites it: on xAI `cited` is never `false`. The numeric label of the source's own inline marker (`"1"`) is no longer reported as `Citation.title`; a real numeric title such as `"2024"` is kept.
- **`providerMetadata.google.searchEntryPoint`** is the one place the Search Suggestions widget Google requires a grounded answer to display is stored; the raw `providerMetadata.groundingMetadata` no longer contains `searchEntryPoint` (it was a second copy of kilobytes of HTML on every persisted grounded row). Render `renderedContent` as untrusted HTML in a sandboxed iframe.

What hosts must change: do not read `citation.title === '1'` as a title; a UI that needs the sources with an inline marker filters on `cited === true`; treat a missing `cited` on xAI as unknown, not uncited; treat a missing `textRange` on a `cited: true` citation as "no verified range"; read the widget from `providerMetadata.google.searchEntryPoint`, not from `providerMetadata.groundingMetadata.searchEntryPoint` (the raw copy is gone).
