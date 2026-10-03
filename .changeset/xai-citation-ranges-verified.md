---
'@gullabs/xai': minor
'@gullabs/core': minor
---

xAI citation ranges are checked against the answer, and `cited` is never `false` on xAI.

A `url_citation` annotation with a zero-width (`0`/`0`) range used to become `cited: false`. That was wrong: a captured X Search answer has inline citation markup in its text while all three of its annotations are `0`/`0`, and structured answers have only `0`/`0` annotations. `cited` is now absent for such a source (xAI reported no marker range, which says nothing about whether the answer cites it); only a non-empty range gives `cited: true`.

A non-empty range is now verified: the slice of `result.text` at the range (indexed from the start of the `output_text` part that carries the annotation, in UTF-16 code units) must be exactly `[[N]](<the source's url>)`. When it is not (xAI counts code points around emoji, or indexes a multi-part message differently; neither is in a capture), the range is dropped, the source stays `cited: true`, and the result carries a warning, instead of a range that points at the wrong span. The numeric marker title is dropped only when it equals that marker's label, so a real numeric title such as `"2024"` is kept.

What hosts must change: treat a missing `cited` on an xAI source as unknown, not uncited; filter on `cited === true` only to find sources with an inline marker.
