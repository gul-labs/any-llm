---
'@gullabs/google': minor
---

Gemini citation `textRange` is verified against the response, and `searchEntryPoint` is stored once.

A live grounded call (Japanese answer with emoji, two thought parts before the answer) showed two things the first implementation had wrong or unchecked: Gemini's `partIndex` does not count thought parts (the answer sat at `candidate.content.parts` index 2 and its segments omitted `partIndex`, so the old mapping found no answer part and set no range), and offsets are UTF-8 bytes into the answer part. The adapter now indexes the non-thought parts and checks each range against `groundingSupports[].segment.text`: when the slice of `result.text` at the converted range is not exactly that text, the range is dropped, the source stays `cited: true`, and the result carries a warning. A segment without `text` is accepted on its offsets alone.

`providerMetadata.google.searchEntryPoint` is now the only place the Search Suggestions widget is stored: the raw `providerMetadata.groundingMetadata` no longer contains `searchEntryPoint` (it was a second copy of kilobytes of HTML on every persisted grounded row). The README now says to render `renderedContent` as untrusted HTML in a sandboxed iframe.

What hosts must change: read the widget from `providerMetadata.google.searchEntryPoint`, not from `providerMetadata.groundingMetadata.searchEntryPoint`; render it sandboxed; treat a missing `textRange` on a `cited: true` citation as "no verified range".
