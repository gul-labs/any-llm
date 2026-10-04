---
'@gullabs/drizzle': minor
---

The sink is proven on node-postgres, postgres-js and PGlite, and a payload failure no longer costs the ledger row on postgres-js.

- **Fixed (postgres-js):** a failed payload insert rolled back the whole transaction, so the billed ledger row was lost and `record()` rejected. The payload is now written in Drizzle's nested `transaction()` instead of a hand-written `SAVEPOINT`: a failure (a payload Postgres rejects, a missing `llm_call_payloads` table) undoes only the nested transaction, is logged as `llm.call.payload.failed`, and the ledger row commits, on all three drivers.
- **Fixed (postgres-js):** `purgeLlmCallPayloads` threw on every call because a raw `Date` was bound into a SQL template. The cutoff is now bound as an ISO string cast `::timestamptz`.
- **A transaction handle is a supported `db`.** `drizzleUsageSink({ db: tx })` (and a `transaction` helper that hands every call one ambient transaction) runs every write one at a time, each in a nested transaction. Concurrent records all succeed and a failing write never aborts your transaction. You own that transaction: when it rolls back, the sink's rows roll back with it. Before, concurrent payload records on a transaction handle all failed and left it aborted.
- **The ledger-failure log no longer carries the row.** A failed ledger insert rejects with `llm_calls insert failed for attempt <id>: <driver message> (SQLSTATE <code>)`, and for a missing column or table a pointer to `assertLlmCallsSchema` and `sql/upgrades/`. The statement and its bound parameters (reasoning text, tool arguments, `metadata`) are never in it, and the error has no `cause`. If you matched on the old `Failed query:` text, match on the SQLSTATE or the driver message instead.
- **`assertLlmCallsSchema(db)` also reads nullability.** It rejects a NOT NULL column without a default that the sink does not write, or that the schema allows to be NULL, and names the column and the one-line fix. A table made by `@gullabs/drizzle` 0.1.1 to 0.4.0 has `raw_usage NOT NULL`, which rejects every error row: run `ALTER TABLE llm_calls ALTER COLUMN "raw_usage" DROP NOT NULL`. There is no upgrade script for those shapes. `assertLlmCallsSchema` and `assertLlmCallPayloadsSchema` take a `PostgresDb`; the `SelectableDb` type is removed.
- The package tarball ships `LICENSE` and `NOTICE`. `postgres` is a dev dependency (tests only).

What hosts must change: nothing for a correct setup; if you pass a transaction handle as `db`, know that its commit and rollback are yours. `neon-http` is documented as not tested (it cannot write payloads).
