---
'@gullabs/core': minor
'@gullabs/drizzle': minor
'@gullabs/testing': minor
---

Payload storage (ADR-038) hardened after the audit: bounded and linear-time building, a snapshot at dispatch, a stricter upgrade guard, safe shared transactions, batched purge.

Core:

- The request is snapshotted at dispatch and `include` is called then (once per attempt). The payload is built after the outcome inside the `sinkTimeoutMs` wait: a build that is still running when the wait ends (timeout, abort, deadline) is stopped at its next step, dropped with `llm.call.payload.dropped`, and the ledger row is still written. Large payloads yield to the event loop.
- Every string is stripped of U+0000, cut to `maxChars + 256` characters (the token at the cut edge is dropped), then redacted, then your `redact` runs, then the caps run last. A secret split by U+0000 or cut by the window is redacted whole. Tool-call arguments and tool-result values also have the value of a secret-named key replaced with `[REDACTED]`.
- `file-uri` parts store scheme, host and path only (no userinfo, query string or fragment). Inline media is hashed in 1 MiB chunks with `node:crypto`; a part over 20 MiB is stored as `{ bytes, sha256: null, skipped: 'too_large' }` and data that is not valid base64 as `{ bytes: null, sha256: null, skipped: 'invalid_base64' }`, dropping only that part. `StoredPart`'s `inline-media` shape changes accordingly (`sha256` and `bytes` can be `null`, `skipped` is new).
- A payload too big only because of a large numeric array in a tool argument drops that value, not the whole payload. A `__proto__` key is kept as data.
- **Breaking, at `createClient`:** `payloads.maxChars` must be an integer of at least 1,000; an `async` `redact` or `include` is `bad_request` (and a Promise returned at run time drops the payload or skips the call with a warning); the config is copied, so changing it afterwards has no effect. A sink must declare `acceptsPayloads: true` to be handed payloads: with `payloads` set and a sink that does not, `createClient` logs one `llm.config.payloads.sink_ignores_payloads` warning and builds nothing. If you wrote a custom `UsageSink` that reads `record`'s second argument, add `acceptsPayloads: true`.
- `llm.call.payload.dropped` now carries `stage`, `errorName` and a fixed `error` sentence, never the error's text (a redactor's error can contain the payload).
- New exports: `MIN_PAYLOAD_MAX_CHARS`, `DEFAULT_PAYLOAD_MAX_CHARS`, `PAYLOAD_MAX_INLINE_MEDIA_BYTES`.

Drizzle:

- **A record without a payload is one `INSERT` on `db`, with no transaction** (it works on `neon-http` again). A record with a payload runs in one transaction with the payload insert behind a uniquely named savepoint. A `db` with no `transaction()` and no `transaction` helper is `bad_request` at `drizzleUsageSink(...)`; there is no fallback. The sink declares `acceptsPayloads: true`.
- A `transaction` helper that hands every call the same ambient transaction no longer loses payloads: the sink serializes its writes per handle. If that host transaction rolls back, the ledger rows roll back with it. Set `idle_in_transaction_session_timeout` and `statement_timeout` for the sink's role.
- `purgeLlmCallPayloads(db, { olderThan, batchSize? })` deletes in batches (default 5,000) and returns a count without selecting the ids. `batchSize` outside 1 to 1,000,000 is `bad_request`.
- `assertLlmCallsSchema(db)` and `assertLlmCallPayloadsSchema(db)` no longer take a `table` argument. A sparse `callIds` array is `bad_request`.
- `sql/upgrades/0003-llm-call-payloads.sql` now stops unless an existing `llm_call_payloads` has exactly our columns, types, nullability and default, primary key and foreign key (a same-named table of another shape is renamed first). It is one `BEGIN` / `COMMIT` transaction with `SET LOCAL lock_timeout`; drop those two lines if your migration runner wraps each file in a transaction.

Testing: `RecordingSink` declares `acceptsPayloads`.

Docs: `llm_calls` is not text-free. It always carries the model's tool-call arguments and reasoning text (now redacted), the error message, citations and your `metadata`, and `payloads` / `include` / `storePayload` and the purge and delete helpers govern the payload table only. The README, SECURITY.md, ledger guide and ADR-038 carry the table of what each holds; hosts that need no text in the ledger wrap their sink and drop those columns.
