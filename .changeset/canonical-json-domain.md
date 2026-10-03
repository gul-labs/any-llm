---
'@gullabs/core': minor
---

`canonicalJson` serialises `-0` as `0` and rejects very deep input with `bad_request`.

RFC 8785 (and `JSON.stringify`) write `-0` as `0`, so a value now hashes the same before and after a JSON round trip, and a provider answer that contains `-0` no longer fails a billed call. Input nested deeper than 1000 levels is `bad_request` instead of a `RangeError`. Plain objects from another realm (a `vm` context, a test runner's sandbox) are accepted as plain objects. An object with a symbol key is `bad_request` instead of having the key silently ignored.

What hosts must change: nothing, unless code relied on `canonicalJson(-0)` throwing.
