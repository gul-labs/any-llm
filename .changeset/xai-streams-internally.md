---
'@gullabs/xai': minor
'@gullabs/core': minor
---

xAI calls stream internally (ADR-040), and `LlmErrorReason` loses `'search_budget_exceeded'`.

`run()` on `@gullabs/xai` now sends `stream: true`, reads the server-sent events to the final one and returns the same result as before. Public `stream()` is unchanged (still on the ROADMAP). Live probes (17 to 28 minute reasoning runs on grok-4.5, 4.6 and 4.7, Node's default `fetch`) completed with a longest gap of 15 s between events, so Node's 300 s timer no longer kills a long reasoning call.

- The final response object can omit output items the stream carried (a live capture of two search runs lacked the `reasoning` item). The adapter rebuilds the item list from the events and reconciles it with the final object, so the `'state'` continuation, `message`, citations and annotations are built from the complete list. The final object wins where both carry a field; each correction is a `warnings` entry, and a disagreement never fails the call (see `xai-stream-failures.md`).
- A stream that ends before its final event, with no output event yet, is a retryable `server` error with no usage, so the engine counts the attempt as unpriced (`callCost.unpricedAttempts`), not free. After output began it is not retried and carries an estimated usage (`xai-stream-failures.md`). Mid-stream `error` and `response.failed` events classify through the same `error.code` table as a failed non-streamed response.
- The request deadline (`timeoutMs + 5000`, or one hour) is the SDK `timeout` for the header wait and the client's own timer for the rest of the stream, so it still bounds the whole call (the SDK `timeout` alone bounds a stream only until the response headers arrive). A stream past it is `kind: 'timeout'`, `retryable: false`, `reason: 'transport_timeout'`. A caller `signal` aborts a stream in flight.
- `XaiResponseMeta` gains `streamNotes?: string[]`; `XaiRequestOptions.onResponse` is now called once the response is complete. `XaiClientLike` is unchanged: a fake still resolves to one response object.
- `LlmErrorReason` no longer contains `'search_budget_exceeded'`. It was reserved for an in-flight search abort that this release does not build (whether xAI stops billing an aborted stream could not be tested), and nothing ever emitted it. `usage.details.search_budget_exceeded` and the `searchBudget` warning (observed after the call) are unchanged.

What hosts must change:

- A host with reasoning-only xAI calls can drop its undici `transport`. A host with tool-using calls expected to run past 300 s without ANY streamed event should keep it: that case was not tested (the longest streamed tool run was 99 s). The `transport` option stays for proxies, mTLS and custom `fetch`.
- Remove any `switch` branch or type reference to `'search_budget_exceeded'` on `LlmError.reason`.
- A host that supplies its own `XaiClientLike` to `xaiAdapter` is unaffected. A host that called `buildXaiClient(...).responses.create` directly now gets a streamed read and the reconciled object.
