---
'@gullabs/core': minor
'@gullabs/google': minor
---

Gemini 3.x function calling works across turns: thought signatures travel as an overlay on the host's history (ADR-029 addendum).

Gemini 3.x returns a `thoughtSignature` on the first function call of each model turn and answers HTTP 400 when a replayed function call has lost it. The adapter used to discard the signature, so every Gemini 3.x request that replayed a tool call failed. Now `result.transientProviderState` is `{ google: { signatures: [{ messageIndex, partIndex, model, partSha256, signature }] } }`, an overlay that says which part of the host's own messages gets which signature; the library keeps no copy of the history. `partSha256` is the SHA-256 of the part's RFC 8785 canonical JSON, so an edited text or tool argument is detected while key order is not (history stored in Postgres `jsonb` still verifies). `@gullabs/core` exports `canonicalJson(value)`, a dependency-free RFC 8785 serializer for `JsonValue`.

Replay rules, all `bad_request` before dispatch: every entry must hit an assistant message whose part at `partIndex` hashes to `partSha256`, issued for the same `model` string the request names; an edited, reordered, removed or truncated history, an out-of-range index, a duplicate entry, another provider's state or a malformed overlay is rejected; an assistant message that replays tool calls needs an entry for its first tool-call part (which also rejects history produced by another provider). Google's dummy signature is not offered.

`functionResponse.response` is now always an object: an error result is `{ error }`, a non-object result is wrapped as `{ output }`, an object is sent as is. `geminiContentToMessages({ contents, model })` imports signatures from model text and `functionCall` parts into a returned `transientProviderState` instead of rejecting them; a signature on any other part, or without `model`, is `bad_request`. Gemini 2.5 and Gemma need no signatures.

What hosts must change:

- On Gemini 3.x, send each turn with `result.message` appended unedited to the history and `result.transientProviderState` passed back as `transientProviderState`, on the same `model` string. Store the state with the history it belongs to. The `@gullabs/google` README shows the loop.
- Hand-authored or other-provider function-call history cannot be replayed into Gemini 3.x (there is no signature to attach); keep such conversations on the provider that produced them.
- `countTokens` sends no signatures.
