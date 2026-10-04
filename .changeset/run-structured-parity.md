---
'@gullabs/core': minor
'@gullabs/testing': minor
---

`runStructured` takes the same call options as `generate`, and malformed parts and messages are `bad_request`.

- `RunStructuredOptions` gains `externalId` (persisted on every attempt row), `attachments?: Part[]` (appended to the rendered user message, after its text), `history?: Message[]` (prepended, validated like `generate` messages, sent as given: a history ending in a user message gives two consecutive user turns) and `transientProviderState` (admitted only by models that declare `capabilities.providerState`). A rendered user message that is empty, or whitespace only, with no attachments is `bad_request` before dispatch (it used to send an empty text part); attachments alone are a valid message.
- `runStructured` checks that every `attachments` element is a part object of a known `kind` and every `history` element a `{ role, parts }` message, and `generate` checks `messages` the same way, before anything reads them. A `null`, an `{}` or an unknown `kind` is `bad_request` naming the path (`history[1].parts[0].kind`) instead of a raw `TypeError` classified `unknown`. A call site declares no tools, so `tool-call` and `tool-result` parts in `attachments` or `history` are `bad_request`; a tool loop belongs to `generate`.
- The library still never validates `output`: hosts validate and retry.
- `canonicalJson` serialises `-0` as `0` (as RFC 8785 and `JSON.stringify` do, so a value hashes the same before and after a JSON round trip), accepts plain objects from another realm, and rejects input nested deeper than 1000 levels or with a symbol key with `bad_request` instead of a `RangeError` or a silently ignored key.

What hosts must change:

- A call site with no `userTemplate` (or one that renders to the empty string) passes `attachments`, or the call fails with `bad_request`; give such a call site a template, or pass the content as an attachment.
- Do not pass tool-call or tool-result parts to `runStructured`; use `generate` for a tool loop. Fix any code that relied on a malformed part or message reaching the provider.
- Hosts that fell back to `generate()` to set `externalId`, attach a file or send text or media history can use `runStructured` again.
