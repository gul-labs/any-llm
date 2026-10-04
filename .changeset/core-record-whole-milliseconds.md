---
'@gullabs/core': minor
---

`latencyMs` and `queueDelayMs` on the ledger record are whole milliseconds.

A `Clock` may return fractional milliseconds (`performance.now()`), and the ledger columns are integers: a fractional value made Postgres reject the row (`invalid input syntax for type integer: "12.5"`) and the sink dropped every row of that client. `buildRecord` now rounds both fields with `Math.round`. `Clock`'s documentation says it may return fractions. What hosts must change: nothing; a client with a fractional clock starts writing rows.
