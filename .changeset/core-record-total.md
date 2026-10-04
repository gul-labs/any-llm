---
'@gullabs/core': minor
---

A billed attempt always gets its ledger row, whatever the host put in `metadata`; a billed failure keeps its usage-clamp warnings.

`buildRecord` handed `metadata` (and the provider options in the generation config) to a recursive walk with no cycle or depth guard. A circular, very deep or throwing `metadata` made the call reject with `unknown` after the provider had billed it, wrote no row, and skipped `onError` and `llm.call.error`. The record's JSON lanes (`metadata`, the generation config, tool-call arguments, citations, provider metadata, `rawUsage`) are now projected through a bounded copy: a circular reference, nesting past 64 levels, more than 100,000 values, a getter or `toJSON` that throws, a `bigint`, a function or a symbol each become a short marker (`[circular]`, `[too deep]`, `[truncated]`, `[unreadable]`, `[unserializable]`) with one warning on the row. The call is not refused. Ordinary data is stored as the same object with no warning.

A failed attempt that reported usage (a billed 200 with no output, say) now carries the usage-clamp warnings on its row, as a success does; before, the row held clamped counts with no trace of the change.

What hosts must change: nothing. A row whose `warnings` name `ledger record's metadata` tells you the metadata was cut; keep `metadata` small, acyclic JSON.
