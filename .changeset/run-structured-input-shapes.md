---
'@gullabs/core': minor
---

Malformed parts and messages are `bad_request`, and `runStructured` stops claiming tool loops (ADR-009 amendment).

`runStructured` now checks that every `attachments` element is a part object of a known `kind` and every `history` element a `{ role, parts }` message, and `generate` checks `messages` the same way, before anything reads them: a `null`, an `{}` or an unknown `kind` used to surface as a raw `TypeError` classified `unknown`, or to reach the adapter. The error names the path (`history[1].parts[0].kind`). A rendered user message that is whitespace only counts as empty (refused with no attachments, omitted next to attachments). A call site declares no tools, so `tool-call` and `tool-result` parts in `attachments` or `history` are `bad_request`; a tool loop belongs to `generate`. The `history` and `transientProviderState` docs now say what they support: `history` continues a text or media conversation and is sent as given (a history ending in a user message gives two consecutive user turns, never merged), and `transientProviderState` lets a follow-up call reuse the provider's state from an earlier result.

What hosts must change:

- Do not pass tool-call or tool-result parts to `runStructured`; use `generate` for a tool loop.
- Fix any code that relied on a malformed part or message reaching the provider.
