---
'@gullabs/core': minor
'@gullabs/google': minor
---

Gemini 3.x function calling works across turns: thought signatures travel as an overlay on the host's history (ADR-029 addendum).

Gemini 3.x returns a `thoughtSignature` on the first function call of each model turn and answers HTTP 400 when a replayed function call has lost it. The adapter used to discard the signature, so every Gemini 3.x request that replayed a tool call failed.

- **The overlay.** `result.transientProviderState` is `{ google: { signatures: [{ messageIndex, partIndex, kind, model, partSha256, signature }] } }`, an overlay that says which part of the host's own messages gets which signature; the library keeps no copy of the history. `kind` is `'text'` or `'tool-call'`. `partSha256` is the SHA-256 of the part's RFC 8785 canonical JSON, so an edited text or tool argument is detected while key order is not (history stored in Postgres `jsonb` still verifies). `@gullabs/core` exports `canonicalJson(value)`, a dependency-free RFC 8785 serializer for `JsonValue`.
- **Replay rules, all `bad_request` before dispatch.** Every function-call entry must hit an assistant message whose part at `partIndex` hashes to `partSha256`, issued for the same `model` string the request names; an edited, reordered or removed function call, an out-of-range index, a duplicate entry, another provider's state or a malformed overlay is rejected, and an assistant message that replays tool calls needs an entry for its first tool-call part (which also rejects history produced by another provider). A stale **text** entry (edited, trimmed, moved or removed text, or issued for another model) is dropped with a warning and not carried into the next state, because Google treats text signatures as optional, so a host that `.trim()`s the final answer keeps working. Google's dummy signature is not offered.
- **Trimming.** `dropMessagesFromSignatureState(state, indices)` (new, exported) drops the entries of messages you removed and shifts the later `messageIndex`es down; the `@gullabs/google` README shows a front-trim, a rewind and a compaction. The rule is whole turns only, and never keep a message that holds a function call without its entry. A response that cannot be hashed (a lone surrogate in a function call's arguments or in text) no longer fails a billed call: the result is returned without an entry for that part and with a warning, and the next turn's `bad_request` names the part.
- **Wire shape.** `functionResponse.response` is always an object: an error result is `{ error }`, a non-object result is wrapped as `{ output }`, an object is sent as is. Gemini returns a `functionCall.id` and the adapter keeps it as the tool call's id. An id the library synthesizes when Gemini sends none is `anyllm_call_<name>_<n>` (it was `call_<name>_<n>` and was replayed to Gemini), is unique among the ids already in the history, and is never sent to Gemini (a response pairs with its call by name and order).
- **Import.** `geminiContentToMessages({ contents, model })` imports signatures from model text and `functionCall` parts into a returned `transientProviderState` instead of rejecting them; a signature on any other part, or without `model`, is `bad_request`.
- Gemini 2.5 and Gemma need no signatures. `countTokens` sends none, so it reports `accuracy: 'estimated'` for a Gemini 3 history that holds function calls.

What hosts must change:

- On Gemini 3.x, send each turn with `result.message` appended unedited to the history and `result.transientProviderState` passed back as `transientProviderState`, on the same `model` string. Store the state with the history it belongs to; after removing messages pass their positions to `dropMessagesFromSignatureState` instead of editing the state by hand. The `@gullabs/google` README shows the loop.
- Hand-authored or other-provider function-call history cannot be replayed into Gemini 3.x (there is no signature to attach); keep such conversations on the provider that produced them.
- Code that matched synthesized ids of the form `call_<name>_<n>` uses `anyllm_call_<name>_<n>`.
