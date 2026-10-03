---
'@gullabs/core': minor
---

A ledger record never carries text Postgres cannot store, and the cost drift tolerance counts the lanes that can carry rounding.

`buildRecord` removes U+0000 and replaces each unpaired surrogate with U+FFFD in every string and object key of the record (reasoning text, error message, warnings, provider metadata, citations, tool calls, raw usage, metadata, generation config, ids), and adds a warning when it changed anything. Postgres `text` rejects U+0000 and `jsonb` rejects it and unpaired surrogates, so a provider string with one used to fail the insert and, the sink being fail-open, drop the billed row. The live result and the thrown error keep the original text. The cost `drift` warning tolerance is now 1 µUSD per lane that can carry rounding: a lane with a non-zero amount or with tokens for it, including a lane that rounded to zero, where it used to count only lanes with a non-zero rounded amount and could warn on a call of a few tokens.

What hosts must change: nothing.
