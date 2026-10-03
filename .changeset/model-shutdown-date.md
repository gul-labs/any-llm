---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/xai': minor
'@gullabs/quota': minor
'@gullabs/drizzle': minor
'@gullabs/testing': minor
'@gullabs/claude-cli': minor
'@gullabs/codex-cli': minor
'@gullabs/any-llm': minor
---

`ModelDescriptor.shutdownDate` and a warning near the end of a model's life (ADR-043).

A descriptor may declare `shutdownDate: 'YYYY-MM-DD'` (UTC), the provider's announced end of service. The first successful call per client and model within 90 days of it, on the day or after it, carries a typed warning `{ type: 'shutdown', shutdownDate, message }` naming the model, the date and the days left (or gone by); later calls on that client do not repeat it. `Warning` is now `{ type: 'other', message } | { type: 'shutdown', message, shutdownDate }`. The call is never refused for it. `createModelRegistry` rejects a value that is not a real calendar date. `SHUTDOWN_WARNING_DAYS` (90) is exported. `gemini-3.1-flash-lite` declares `2027-05-07` (Google's deprecations page, read 2026-10-03; replacement `gemini-3.5-flash-lite`), so its calls warn from 2027-02-06.

Both Gemma 4 descriptors keep `capabilities.grounding: true`: a live capture on 2026-10-03 returned `groundingMetadata` on all 5 Search calls that completed (the sixth hit `MAX_TOKENS` with an empty answer and says nothing either way) and is pinned as a fixture labelled a derived summary.

What hosts must change: nothing is required, except that code that narrows `Warning` on `type === 'other'` must handle `'shutdown'` too. A host that treats any `warnings` entry as a failure should expect this advisory once per client for `gemini-3.1-flash-lite`, and should move that model to `gemini-3.5-flash-lite` before 2027-05-07. A host that builds its own descriptors can set `shutdownDate` too.
