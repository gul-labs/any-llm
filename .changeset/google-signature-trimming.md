---
'@gullabs/google': minor
---

Gemini 3 signature overlay: trimming and rewinding the history, optional text entries, and tool-call ids.

Each overlay entry now carries `kind` (`'text'` or `'tool-call'`): `{ messageIndex, partIndex, kind, model, partSha256, signature }`. A stale **function-call** entry (edited, reordered or removed call, out-of-range index, another model) is still `bad_request` before dispatch. A stale **text** entry (edited, trimmed, moved or removed text, or issued for another model) is now dropped with a warning and not carried into the next state: Google treats text signatures as optional, so a host that `.trim()`s the final answer keeps working. `dropMessagesFromSignatureState(state, indices)` is new and exported: after you remove messages from your history it drops their entries and shifts the later `messageIndex`es down (the README shows a front-trim, a rewind and a compaction). The rule is whole turns only, and never keep a message that holds a function call without its entry.

A response that cannot be hashed (a lone surrogate in a function call's arguments or in text) no longer fails a call that was billed: the result is returned without a signature entry for that part and with a warning, and the next turn's `bad_request` names the part. Gemini returns a `functionCall.id` and the adapter replays it. An id the library synthesizes when Gemini sends none is now `anyllm_call_<name>_<n>` (it was `call_<name>_<n>`), is unique among the ids already in the history, and is never sent to Gemini (a response pairs with its call by name and order).

What hosts must change:

- Overlay state stored by an earlier unreleased build lacks `kind` and is rejected; restart those conversations.
- After removing messages from a history, pass their positions to `dropMessagesFromSignatureState` instead of editing the state by hand.
- Code that matched synthesized ids of the form `call_<name>_<n>` must use `anyllm_call_<name>_<n>`.
