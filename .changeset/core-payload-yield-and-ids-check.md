---
'@gullabs/core': patch
---

Payload hashing yields to the event loop every 2 MiB of base64 (it was every 4 million characters), and `createClient` fails early where there is no `crypto.randomUUID`.

The dependency-free SHA-256 is about 18 times slower than `node:crypto`, so the old cadence left stretches of about 27 ms between yields on large inline media. A yield now comes at most every 2,097,152 units of work (about 10 ms). The hash and every stored `partSha256` are unchanged.

`createClient` throws `LlmError('bad_request')` (path `ids`) when `ClientConfig.ids` is not given and the runtime has no `globalThis.crypto.randomUUID` (a browser page served over plain http, some embedded runtimes). It used to fail with a `TypeError` on the first `generate()`.

What hosts must change: nothing on Node or Deno. On a runtime without `crypto.randomUUID`, pass `ids`.
