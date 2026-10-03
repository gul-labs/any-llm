---
'@gullabs/core': minor
'@gullabs/testing': minor
---

`runStructured` takes the same call options as `generate` (ADR-009 amendment).

`RunStructuredOptions` gains `externalId` (persisted on every attempt row), `attachments?: Part[]` (appended to the rendered user message, after its text), `history?: Message[]` (prepended, validated like `generate` messages) and `transientProviderState` (admitted only by models that declare `capabilities.providerState`). A rendered user message that is empty, with no attachments, is now `bad_request` before dispatch (it used to send an empty text part); attachments alone are a valid message and no empty text part is sent. The library still never validates `output`: hosts validate and retry. `@gullabs/testing` needs no code change; it moves with the fixed version group.

What hosts must change:

- A call site with no `userTemplate` (or one that renders to the empty string) must now pass `attachments`, or the call fails with `bad_request`. Give such a call site a template, or pass the content as an attachment.
- Hosts that fell back to `generate()` to set `externalId`, attach a file, send history or continue a tool loop can use `runStructured` again.
