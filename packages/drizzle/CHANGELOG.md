# @gullabs/drizzle

## 0.16.0

### Minor Changes

- fb79350: The ledger: one row per attempt, cost confidence and error reason persisted (record version 2), a record that is always writable, shipped SQL, and a sink proven on node-postgres, postgres-js and PGlite (ADR-031, ADR-039, ADR-045).

  **Rows.**

  - Every attempt gets its own row and `attemptId` is always minted by the engine (refusal rows included); `LlmRequest.idempotencyKey` is deleted. It used to become `attemptId` on attempt 1, and the sink drops a row whose `attempt_id` exists, so a host retry that reused the key made a second billed call whose row was silently dropped. The library never deduplicates provider calls; the sink's `onConflictDoNothing` on `attempt_id` only absorbs an at-least-once sink re-delivering the same record. Give every host-level retry of one logical operation the same `externalId` instead (persisted on every attempt row, indexed, deliberately not unique).
  - `LlmCallRecord.recordSchemaVersion` is `2`. New fields: `costConfidence` (`'exact' | 'estimated'`), `costDetails` (`{ input, cached, output, tools }`, only when priced), `costUnpricedReason` (when `costMicroUsd` is `null`, or `no_usage_reported` on a dispatched attempt that failed without reporting usage and may have billed: such a row has no cost at all, a failure known to cost nothing has neither cost nor reason, so `WHERE cost_unpriced_reason = 'no_usage_reported'` finds the attempts that may have billed) and `errorReason` (`LlmError.reason`, written on provider-attempt and refusal rows), stored in `cost_confidence`, `cost_details`, `cost_unpriced_reason` and `error_reason` (no CHECK on `error_reason`, so a reason added later needs no SQL). A failed attempt's row carries `serviceTier` (the tier it asked for) beside `servedServiceTier`.
  - `buildRecord` caps `reasoningText` and `errorMessage` at 16 KiB of UTF-8 (marker `…[truncated]`, plus a warning; the live result and error keep the full text), rounds `latencyMs` and `queueDelayMs` to whole milliseconds (a `performance.now()` clock used to make Postgres reject the row), and removes U+0000 and replaces unpaired surrogates in every string and key of the record with a warning (Postgres `text` and `jsonb` reject them, and a rejected insert drops a billed row).
  - A billed attempt always gets its row whatever the host put in `metadata`: the JSON lanes (`metadata`, generation config, tool-call arguments, citations, provider metadata, `rawUsage`) go through a bounded copy, and a circular reference, nesting past 64 levels, more than 100,000 values, a throwing getter or `toJSON`, a `bigint`, a function or a symbol becomes a short marker (`[circular]`, `[too deep]`, `[truncated]`, `[unreadable]`, `[unserializable]`) with one warning. Ordinary data is stored as the same object. A `__proto__` key stays data.
  - `redactSecrets` runs in linear time (an `X-Goog-` run used to stall the event loop for seconds) and covers S3/AWS presigned `X-Amz-*` parameters, Azure SAS `sig=`, `X-Goog-*`, `Bearer` tokens in any case, the credential after any `Authorization:` scheme, `password=` / `secret=` / `refresh_token=` / `id_token=` / `client_secret=` pairs, and the key prefixes `sk-`, `ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` / `github_pat_`, `xai-`, `AIza`, `ya29.`, `AKIA`. `buildRecord` now also redacts `reasoning_text` and the `tool_calls` ids, names (cut at 16 KiB, with a warning) and every string in the arguments (and replaces the value of an argument key named like `password`, `secret`, `token`, `api_key`, `authorization`, `credential` or `private_key`, as a substring, with `[REDACTED]`), after stripping U+0000 so a secret split by a NUL is redacted whole. `metadata`, `citations` and provider-reported JSON are still not scanned. `llm_calls` is not text-free: it carries the model's tool-call arguments and reasoning text (redacted), the error message, citations and your `metadata`; a host that must keep that text out wraps its sink and drops those columns.

  **`@gullabs/drizzle`.**

  - **Ships SQL for the first time.** `sql/install.sql` creates a fresh table. `sql/upgrades/` holds, in order: `0001-add-error-reason.sql` (from the 0.7.2 shape), `0002-ledger-v2.sql` (cost columns, CHECKs on `status` and `error_kind` added `NOT VALID`, indexes on `created_at` and `(call_site_id, created_at)`, partial indexes `llm_calls_error_reason_idx` and `llm_calls_auth_key_id_idx`, and `cost_micro_usd` widened to `BIGINT`), `0003-validate-checks.sql` (optional) and `0004-llm-call-payloads.sql` (only with payload storage). Each statement is idempotent. The `BIGINT` change rewrites the table under an exclusive lock: run it in a quiet period on a large table or comment that last statement out (the sink works either way). `0002` sets `lock_timeout = '3s'` and builds its indexes without `CONCURRENTLY` (a SHARE lock; build them concurrently first on a very large table). Rows written by `@gullabs/core` 0.2.0 (`status` / `error_kind` = `parse_error`) block `0003`: the file documents the query and a suggested `UPDATE`. While the CHECKs are `NOT VALID` any `UPDATE` of a legacy row fails with `violates check constraint "llm_calls_error_kind_check"`, your own tenant-deletion `UPDATE` included: run the cleanup in `0003` first. `schema.ts` is for typed queries and `drizzle-kit push`; the SQL files are authoritative and `drizzle-kit generate` cannot produce `NOT VALID` CHECKs or a `lock_timeout`. Drizzle reads `cost_micro_usd` as a JS number; a SQL `SUM()` over it is `numeric`, which the Postgres drivers return as a string (`::float8` or `Number()` it). `token_details` holds xAI's `cost_in_usd_ticks` (1e-10 USD).
  - **`assertLlmCallsSchema(db)`** (new) selects every column the schema names with `LIMIT 0` and also reads `pg_attribute`: it rejects a table that missed an upgrade, and a NOT NULL column without a default that the sink does not write, or a NOT NULL column (default or not) that the schema allows to be NULL, naming the column and the fix. A table made by `@gullabs/drizzle` 0.1.1 to 0.4.0 has `raw_usage NOT NULL`, which rejects every error row: run `ALTER TABLE llm_calls ALTER COLUMN "raw_usage" DROP NOT NULL`. It needs no running client: call it from a deploy or CI step, a readiness endpoint or at boot. The sink stays fail-open and has no compatibility path for old shapes; every dropped row is logged as `llm.call.sink.failed`.
  - **Every driver.** A transaction handle is a supported `db` (`drizzleUsageSink({ db: tx })`, or a `transaction` helper that hands every call one ambient transaction): writes run one at a time, each in a nested transaction, so concurrent records all succeed and a failing write never aborts your transaction; you own that transaction, and when it rolls back the sink's rows roll back with it. A failed ledger insert rejects with `llm_calls insert failed for attempt <id>: <driver message> (SQLSTATE <code>)` and, for a missing column or table, a pointer to `assertLlmCallsSchema` and `sql/upgrades/`; the statement and its bound parameters never appear and the error has no `cause`. A driver without `transaction()` (neon-http) needs your own `transaction` helper or is `bad_request` at construction. Set `idle_in_transaction_session_timeout` and `statement_timeout` for the sink's role.
  - The `drizzle-orm` peer range is `>=0.36 <1`. The `InsertableDb` type is removed (see the payload-storage changeset for the new `drizzleUsageSink({ db })` signature).

  What hosts must change:

  - **Before deploying, apply the SQL** for the shape you have: `0001` then `0002` (then `0003` once legacy rows are clean) on a 0.7.2 table, or `install.sql` on a new one. Without it every insert fails on the missing columns and, because sinks are fail-open, the rows are dropped. Run `assertLlmCallsSchema(db)` where it fits and alert on `llm.call.sink.failed`. The packages release in lockstep, so a core bump for an unrelated fix is a drizzle bump too.
  - Remove `idempotencyKey` from requests (a type error now) and use `externalId`. History joined on the old key-derived `attemptId`s (`key`, `key:2`, ...) joins on `externalId` going forward; existing rows are not rewritten. To see everything a retried operation cost, query by `external_id`.
  - If you maintain your own table or sink, add the optional `error_reason`, `cost_confidence`, `cost_details` and `cost_unpriced_reason` columns and persist the new record fields. Rows written before this version have NULL for them.
  - Code that read a full `reasoningText` or `errorMessage` from a record expects the 16 KiB cap; `llm_calls.tool_calls` and `reasoning_text` may now contain `[REDACTED]` where they held credentials. If you matched the old `Failed query:` text of a sink error, match the SQLSTATE or driver message.

- fb79350: Lockstep versions with `@gullabs/core` as an exact peer, runtime support that is written down and tested, correct `exports`, and `LICENSE` plus `NOTICE` in every tarball.

  - **One version for every package.** The nine `@gullabs/*` packages are one changesets `fixed` group and always release at the same version; a package with no code change still gets the bump. `@gullabs/google`, `@gullabs/xai`, `@gullabs/quota`, `@gullabs/drizzle`, `@gullabs/testing`, `@gullabs/claude-cli`, `@gullabs/codex-cli` and `@gullabs/any-llm` declare `@gullabs/core` as a `peerDependency` pinned to the exact release version instead of a regular dependency, so a second copy of core cannot sit in `node_modules` without a peer-dependency conflict and `instanceof LlmError` always sees one engine. Mixed versions, patch releases included, are a peer-dependency error under pnpm's strict peers and `ERESOLVE` under npm 7+; they are not supported or tested.
  - **No Node built-in in `core`, `google`, `xai`, `quota`, `drizzle` and `any-llm`.** Ids come from `globalThis.crypto.randomUUID()`, hashes from the new dependency-free `sha256Hex(input)` that `@gullabs/core` exports next to `canonicalJson`, and `Buffer` and `process` are gone. The built ESM entries load with every `node:` import blocked and fake-backed calls run with `Buffer` and `process` removed (`pnpm test:runtime`, in CI); ESLint rejects `node:*`, `Buffer` and `process` in their source. Deno 2.4.1 passes by hand; Bun, Cloudflare Workers, Vercel Edge and browsers are not tested. `claude-cli`, `codex-cli` and `testing` stay Node only. `createClient` throws `bad_request` (path `ids`) when `ClientConfig.ids` is not given and the runtime has no `globalThis.crypto.randomUUID`, instead of failing with a `TypeError` on the first call.
  - **`exports` has nested conditions**: `import` gives `index.d.ts` and `index.js`, `require` gives `index.d.cts` and `index.cjs`, and every package also exports `./package.json`. A TypeScript consumer under `node16` / `nodenext` that `require`s a package now gets CommonJS types (it got ESM types), and `require.resolve('@gullabs/core/package.json')` no longer throws. The ESM and CommonJS builds are separate copies: a process that loads one package through both holds two `LlmError` classes, so use one module format.
  - **One Node floor, `>=22.12.0`**, in every `engines`, the README and the SPEC. CI runs the tests on 22.12.0 and 24.
  - **Every tarball ships `LICENSE` and `NOTICE`** (Apache-2.0 4(d)); `@gullabs/drizzle` also ships its `sql/` directory.

  What hosts must change:

  - Install `@gullabs/core` next to any package that is not the facade, at the same version (`pnpm add @gullabs/core @gullabs/xai openai`); npm 7+ and pnpm install a missing peer unless npm's `legacy-peer-deps` is on or pnpm's `auto-install-peers` is off. Upgrade every `@gullabs/*` package together.
  - Remove any use of `VERSION` from `@gullabs/core` or `@gullabs/any-llm` (it read `0.0.0`); read your own `package.json`. `@gullabs/any-llm` still exports `ANY_LLM_VERSION`.
  - On a runtime without `crypto.randomUUID` (a browser page served over plain http, some embedded runtimes), pass `ids`.
  - A host compiled with `moduleResolution: node16` that `require`s a package may see new, correct type errors where it relied on the ESM declarations.

- fb79350: Opt-in prompt and response storage (ADR-038), and a breaking change to `drizzleUsageSink`'s signature.

  By default nothing changes and the full prompt and response text is not stored. `ClientConfig.payloads?: { redact?, maxChars?, include? }` turns storage on for a client. Every attempt that entered the provider adapter, success or failure, then hands the sink a payload next to its record (an attempt the adapter itself rejects before any network call, such as a refused media type, is still an attempt and has one for the request it never sent; an attempt refused before the adapter has none): `UsageSink.record(record, { payload, logger })`. A sink must declare `acceptsPayloads: true` to be handed one; with `payloads` set and a sink that does not, `createClient` logs one `llm.config.payloads.sink_ignores_payloads` warning and builds nothing. `payloads` without a `sink` is `bad_request`.

  - **What is stored.** The request as sent (system, messages as `{ role, parts }`, text verbatim, tool-call arguments and tool-result values as JSON, tools by name and schema hash) and the raw model text or the attempt's error message. An inline media part is its media type, decoded size and SHA-256, never the bytes; a part over 20 MiB is `{ bytes, sha256: null, skipped: 'too_large' }` and data that is not valid base64 `{ bytes: null, sha256: null, skipped: 'invalid_base64' }`, which drops only that part. A `file-uri` keeps scheme, host and path only (no userinfo, query string or fragment). `generate(request, { storePayload: false })` and `runStructured(callSite, vars, { storePayload: false })` opt a call out.
  - **Build order, per string.** Strip U+0000, cut to `maxChars + 256` (the token at the cut edge is dropped), run core's `redactSecrets` patterns (linear time) and, for tool arguments and results, replace the value of a secret-named key with `[REDACTED]`, then your synchronous `redact`, then the caps last: `maxChars` per string (an integer of at least 1,000, default 200,000, cut with `[truncated]`) and `4 x maxChars` for the whole payload (the strings that save the most serialized space, then a large numeric array, become a marker first). A secret split by U+0000 or cut by the window is redacted whole. Core's patterns cover credentials only; supply your own `redact` for personal data.
  - **When.** The request is snapshotted at dispatch and `include` is called then (once per attempt). The payload is built after the outcome inside the `sinkTimeoutMs` wait: a build still running when the wait ends (timeout, abort, deadline) is stopped at its next step and dropped with `llm.call.payload.dropped` (`stage`, a fixed `category` such as `redactor_threw` or `include_threw`, the `thrownType` of the thrown value and a fixed `error` sentence; never an error's `name`, `message` or `stack`, since a redactor controls them and they can contain the payload, or throw when read), and the ledger row is still written. A payload that cannot be built never fails the call. Hashing yields to the event loop every 2 MiB of base64.
  - **Config.** The options are copied at `createClient`; an `async` `redact` or `include` is `bad_request` (a Promise returned at run time drops the payload, or skips the call for `include`, with a warning).
  - **`@gullabs/drizzle`** adds the `llm_call_payloads` table (`attempt_id` primary key and foreign key to `llm_calls` with `ON DELETE CASCADE`, `request` and `response` JSONB, `created_at` indexed), `purgeLlmCallPayloads(db, { olderThan, batchSize? })` (batches of 5,000 by default, `batchSize` from 1 to 1,000,000, returns a count), `deleteLlmCallPayloads(db, { callIds })` (by call id only: `externalId` can repeat across tenants) and `assertLlmCallPayloadsSchema(db)`. `drizzleUsageSink` takes an options object, `drizzleUsageSink({ db, transaction? })`: a record without a payload is one `INSERT` with no transaction, a record with a payload is written in a transaction (the ledger row, then the payload row in a nested transaction), a payload failure rolls back only that nested transaction, is logged as `llm.call.payload.failed` and the ledger row commits, and a ledger failure writes neither. A host `transaction` helper that hands every call the same ambient transaction no longer loses payloads: the sink serializes its writes per handle. A `db` with no `transaction()` and no helper is `bad_request` at construction.
  - **`@gullabs/testing`**: `RecordingSink` declares `acceptsPayloads` and keeps the payloads it receives on `payloads` (a `Map` by `attemptId`).

  What hosts must change:

  - **`drizzleUsageSink(db, table?)` is gone: write `drizzleUsageSink({ db })`.** The custom `table` argument and the `InsertableDb` type are removed; `db` must be a Drizzle Postgres database with `transaction` (node-postgres, postgres-js, PGlite, ...). If your database standard routes every transaction through your own helper, pass `drizzleUsageSink({ db, transaction })`.
  - **Only if you turn on `payloads`:** apply `sql/upgrades/0004-llm-call-payloads.sql` first (or install from `sql/install.sql`) and run `assertLlmCallPayloadsSchema(db)` at deploy or boot. The upgrade is one transaction with a transaction-local `lock_timeout` (drop those two lines if your migration runner wraps each file in a transaction). It stops unless an existing `llm_call_payloads` has exactly our columns, types, nullability and default, primary key and foreign key: rename a same-named table of another shape first.
  - **Stored payloads can contain customer data, and retention is yours.** The library never deletes them: schedule `purgeLlmCallPayloads` and use `deleteLlmCallPayloads` for tenant or subject deletion. `payloads`, `include`, `storePayload` and the purge and delete helpers govern the payload table only, never the text columns of `llm_calls`.
  - A custom `UsageSink` that wants payloads reads `record`'s optional second argument and declares `acceptsPayloads: true`.

## 0.7.2

### Patch Changes

- Updated dependencies [64942d1]
  - @gullabs/core@0.15.0

## 0.7.1

### Patch Changes

- Updated dependencies [cb4980f]
  - @gullabs/core@0.14.1

## 0.7.0

### Minor Changes

- 79bac18: Raise the supported runtime and narrow provider peer ranges.

  - **Breaking:** `engines.node` is now `>=22.12.0` on every published package. Node 20
    reached end of life in April 2026 and is no longer supported.
  - **Breaking:** `@gullabs/google` requires `@google/genai` `^2` (was `^1 || ^2`), and
    `@gullabs/any-llm` now depends on `@google/genai` `^2.19.0`.
  - **Breaking:** `@gullabs/xai` requires `openai` `^7` (was `^6 || ^7`).

  Development moves to Node 24 (`.nvmrc` pins 24.20.0) and pnpm 11.24.0; pnpm settings
  now live in `pnpm-workspace.yaml` rather than `package.json` and `.npmrc`.

### Patch Changes

- 79bac18: Point `repository.url`, `homepage`, and `bugs` at the canonical GitHub org path
  `gul-labs/any-llm`. The org was renamed from `GulLabs`; the old path still
  redirects in a browser, but npm provenance matches `repository.url` literally
  against the attestation's `sourceRepositoryURI`, so a redirect does not satisfy
  it and the next provenance publish would have failed the same way the earlier
  lowercase-casing incident did.

  The npm scope `@gullabs` is a separate namespace and is unchanged.

- Updated dependencies [79bac18]
- Updated dependencies [79bac18]
  - @gullabs/core@0.14.0

## 0.6.1

### Patch Changes

- 6a5a662: Fix Codex WS-C follow-ups: file-ref attachment pricing is estimated until the counter is live-pinned; Google toolCallId uses provider `functionCall.id` (or a unique per-name suffix) and replays it; requested tool names/count persist alongside generationConfig.
- Updated dependencies [6a5a662]
  - @gullabs/core@0.13.1

## 0.6.0

### Minor Changes

- 0521973: Breaking (pre-1.0): required `TokenCount.accuracy`, required `Cost.details.tools`, first-class `citations` on generate results and call records, and xAI Live Search tools.

  - `TokenCount.accuracy` is `'exact' | 'lower-bound'` (Google exact; xAI tokenize-text lower-bound). Non-text parts on xAI `countTokens` are `bad_request`.
  - `Cost.details` is `{ input, cached, output, tools }` with invariant `microUsd = input + cached + output + tools`. Google/CLI token pricing sets `tools: 0`.
  - `LlmResult` / `AdapterResult` / `LlmCallRecord` / drizzle persist `citations?: { url, title?, sourceName? }`. Empty arrays are omitted. Public `normalizeGroundingCitations` is deleted.
  - grok-4.5 admits `reasoning.effort` `low|medium|high` (live 2026-08-24). `providerOptions.xai.tools` admits `web_search` / `x_search`. xAI prices `web_search_calls` / `x_search_calls` / `document_search_calls` from live usage details.

- 0521973: Breaking (pre-1.0): function-calling seam (ADR-029). `FinishReason` includes `tool_calls`; `tool-call` / `tool-result` parts; `LlmRequest.tools` / `toolChoice`; `toolCalls` on results and records.

  No agent loop. `runStructured` + tools is `bad_request`. Google and grok-4.5/4.6 implement and gate on `functionCalling`. CLI adapters reject `tools` and the new part kinds. Google `countTokens` stays `exact` with tools; xAI `countTokens` rejects tools. xAI store:false replay is live-verified.

### Patch Changes

- Updated dependencies [0521973]
- Updated dependencies [0521973]
  - @gullabs/core@0.13.0

## 0.5.3

### Patch Changes

- Updated dependencies [90a47a1]
  - @gullabs/core@0.12.1

## 0.5.2

### Patch Changes

- Updated dependencies [2ab1ea6]
  - @gullabs/core@0.12.0

## 0.5.1

### Patch Changes

- Updated dependencies [d46fd27]
  - @gullabs/core@0.11.0

## 0.5.0

### Minor Changes

- aa858bf: Fix `llm_calls.raw_usage jsonb NOT NULL` silently dropping every error and pre-attempt-refusal row from the ledger. The core engine's `EMPTY_USAGE` sentinel sets `Usage.raw = null` on every record path where no provider usage payload ever existed — a per-attempt error (`api_error` / `timeout` / `aborted` / `content_filter`) and the ADR-025 `attemptNumber: 0` synthetic pre-attempt refusal record both hit this. `buildRecord` copies `usage.raw` verbatim into `LlmCallRecord.rawUsage`, so every such record carried `rawUsage: null` into the sink. Because `raw_usage` was `NOT NULL`, the INSERT was rejected at the DB boundary — and because `UsageSink.record` is fail-open by design (ADR-002), that rejection was logged and swallowed, so the row never appeared in the ledger at all. Any consumer relying on the ledger for error/refusal visibility was silently missing that data.

  `raw_usage` is now nullable (ADR-027). `null` means "no provider usage payload existed for this row" — it is not backfilled with a `{}` sentinel, since that would fabricate a payload the provider never returned. `token_details`, `generation_config`, and `metadata` were audited against the same engine record paths and are always populated (never null) on every code path, so their `.notNull()` constraints are unchanged; the schema now documents this invariant per-column.

  **Consumers with an existing `llm_calls` table must run:**

  ```sql
  ALTER TABLE llm_calls ALTER COLUMN raw_usage DROP NOT NULL;
  ```

## 0.4.0

### Minor Changes

- a3f74be: Add per-key attribution (ADR-026): `ApiKeyAuth` gains an optional `keyId?: string` — an opaque, caller-supplied label (e.g. `'gemini-paid'`, `'grok-team-A'`) for the API key actually used, never the secret itself. The engine resolves `keyId` from the auth material used for the dispatch attempt that produced the recorded outcome — after any retries, fallbacks, or profile translation — so attribution stays correct even when the engine switches auth material between attempts.

  Key attribution belongs in any-llm rather than client code: the engine is the only component that authoritatively knows which auth material was used at dispatch time. Threading that identity through client-side call sites separately is the pattern that produced a real production bug (calls under one provider billed to the wrong client-side key label because the client's own attribution tracking drifted from what the engine actually dispatched with).

  `keyId`, when provided, is validated per the library's reject-don't-map convention: must be a non-empty string, and must not equal `apiKey` (rejecting the case where a caller passes the secret itself as the label) — both raise a `bad_request` `LlmError`. The resolved `keyId` is carried through `buildRecord` into a new `authKeyId` field on `LlmCallRecord`, persisted to a nullable `auth_key_id` column on `llm_calls` (`@gullabs/drizzle`), and is exempt from the record's secret-redaction pass since it's a label by design. `CliSessionAuth` is unaffected — CLI-session providers have no key identity, so `keyId` is out of scope there.

### Patch Changes

- Updated dependencies [a3f74be]
  - @gullabs/core@0.10.0

## 0.3.8

### Patch Changes

- Updated dependencies [20453fc]
  - @gullabs/core@0.9.0

## 0.3.7

### Patch Changes

- 0b44a5e: Provider-plugin architecture: `@gullabs/core` becomes provider-agnostic (zero Google/Gemini/Gemma knowledge), provider packages own their model configs, pricing, and options types, and wiring goes through a new `composeProviders()` seam. New `@gullabs/xai` package adds a Grok provider (breaking, pre-1.0).

  **Breaking changes:**

  - `ProviderOptions` is removed as a closed type. It is replaced by an extensible `ProviderOptionsMap` interface; provider packages declare their own options via module augmentation (`declare module '@gullabs/core' { interface ProviderOptionsMap { google?: GoogleProviderOptions } }`).
  - `GenConfig.serviceTier` widens from Google's literal union `'flex' | 'standard'` to an opaque provider-defined `string`; `ModelDescriptor.capabilities.serviceTiers` widens to `readonly string[]`. Retry tier pinning (`revalidatePinnedServiceTier`) is now descriptor-driven instead of hardcoding Google's tier vocabulary.
  - `GenConfig.flexFallback` is removed from core. It now lives under `providerOptions.google.flexFallback`, admitted only by the flex branch of each Gemini model's config schema.
  - `@gullabs/core` no longer exports any Google/Gemini/Gemma-named symbol: `GoogleProviderOptions`, `GoogleSafetySetting`, `GoogleSearchTool`, the Gemini/Gemma model descriptors and config schemas, `GEMINI_PRICING`, `TIER_FACTOR`, `geminiPricingSource`, and `defaultGeminiRegistry` all move to `@gullabs/google`. They remain available from `@gullabs/any-llm`, which re-exports both `@gullabs/core` and `@gullabs/google`.
  - `ClientConfig.modelRegistry` is now required — there is no default registry. Build one via `composeProviders()`.
  - `GeminiClientLike.countTokens` is now a required method on the structural client interface. Anyone building a custom fake against this interface (including via `@gullabs/testing`) must implement it.

  **New features:**

  - New `@gullabs/xai` package: an xAI Grok provider adapter (`xaiProvider()`) with `grok-4.5` on the Responses API — reasoning (`low`/`high` effort), native structured output, vision, automatic caching via `promptCacheKey`, and live-verified pricing including the >200k long-context tier.
  - New `ProviderPlugin` interface and `composeProviders()` helper in `@gullabs/core` — the standard way to wire one or more provider packages into `createClient`: `createClient({ ...composeProviders([googleProvider(), xaiProvider()]) })`.
  - New `Client.countTokens()` — dry-run token counting with no generation and no billing, implemented for Google via `@google/genai`'s `models.countTokens`.
  - `GoogleCacheStore` gains an optional token-count preflight gate before cache creation.
  - New `geminiContentToMessages()` migration utility in `@gullabs/google` for converting hand-authored `@google/genai` prompts into any-llm's normalized message shape.
  - New `assertRegistryInvariants()` shared test helper in `@gullabs/testing` for provider-package model-onboarding tests (schema-artifact completeness, JSON-schema staleness, pinned model-id lists, pricing coverage, fixture-list membership).
  - New `claudeCliProvider()` / `codexCliProvider()` plugin factories for the existing dev-only CLI provider packages, so they compose the same way as API-backed providers.

  **Migration notes:**

  Wire providers through `composeProviders()` instead of constructing `adapters`/`modelRegistry`/`pricingSources` by hand:

  ```ts
  import { createClient, composeProviders } from '@gullabs/core'
  import { googleProvider } from '@gullabs/google'

  const client = createClient({
    ...composeProviders([googleProvider()]),
  })
  ```

  Flex-fallback configuration moves to `providerOptions.google.flexFallback` on the request.

- Updated dependencies [0b44a5e]
  - @gullabs/core@0.8.0

## 0.3.6

### Patch Changes

- ba21620: Provider-qualified model identity — explicit `(provider, model)` everywhere (breaking, pre-1.0).

  - `LlmRequest`, `CallSite`, and `ResolvedRequest` now require a top-level `provider: string`; `model` stays the bare provider-native string forwarded verbatim to SDKs/CLIs. Bare requests without a provider, unregistered `(provider, model)` pairs, and slash-style `'provider/model'` strings are rejected with `bad_request`.
  - `ModelRegistry` is keyed by `(provider, model)`: `resolve(provider, model)`, `ModelDescriptor.id` renamed to `model`, duplicate exact pairs throw, the same bare model may exist under multiple providers with different config schemas, and prefix matching never crosses providers.
  - Routing is always by `req.provider`: the single-adapter bypass is removed, custom `route(provider, model, adapters)` results are checked against `adapter.id === req.provider`, and `createClient` verifies every registry descriptor's provider has a matching adapter.
  - Pricing composes per provider: `ClientConfig.pricing` is replaced by `pricingSources: Record<provider, PricingSource>`; the port shape is unchanged and `geminiPricingSource()` is the google-scoped source. A provider without a source yields an unpriced result with a warning.
  - Telemetry events carry `provider`; quota's `providerQuotaMiddleware` reads `req.provider` from the request (the `provider` option is removed).

- Updated dependencies [ba21620]
  - @gullabs/core@0.7.0

## 0.3.5

### Patch Changes

- Updated dependencies [e3da339]
  - @gullabs/core@0.6.0

## 0.3.4

### Patch Changes

- Updated dependencies [b39ceac]
  - @gullabs/core@0.5.0

## 0.3.3

### Patch Changes

- Updated dependencies [78b7636]
  - @gullabs/core@0.4.3

## 0.3.2

### Patch Changes

- c1aa7ad: Open-source documentation pass: rewrote the root README and all package READMEs for
  accuracy and consistency, fixed stale content in DESIGN.md/SPEC.md/docs/architecture.md
  left over from the forward-only structured-output migration, restructured the root
  CHANGELOG.md to point at each package's own changelog, archived internal planning docs
  into `docs/archive/`, and scrubbed a private host name from a `@gullabs/core` source
  comment (no behavior change).

  `@gullabs/any-llm` also ships a new Agent Skill at `skills/any-llm/SKILL.md` teaching AI
  coding assistants (e.g. Claude Code) how to use this library correctly — per-call auth,
  the forward-only structured-output contract, error handling, and common mistakes.

- Updated dependencies [c1aa7ad]
  - @gullabs/core@0.4.2

## 0.3.1

### Patch Changes

- Updated dependencies [dab0792]
  - @gullabs/core@0.4.1

## 0.3.0

### Minor Changes

- Implement the adoption backlog: add core reasoning resolution exports, pricing-source introspection
  and construction-time strict pricing, unpriced-cost warnings, queue-delay attribution on results and
  records, Drizzle `queue_delay_ms`, hardened quota deny/defer decisions, service-tier re-validation
  after Google provider-options merge, and deterministic testing support for rate-limiter wait time.

  Docs now cover ledger sidecar transaction composition, `metadata.operationId` correlation for
  grounded-to-structured workflows, multi-runtime retry caveats, and caller-owned structured-output
  validation.

### Patch Changes

- Updated dependencies
  - @gullabs/core@0.4.0

## 0.2.0

### Minor Changes

- ea4b941: Implement the integration-fixes API cleanup across structured output, ledger identity, Gemini Flex fallback, and API-verified Gemma 4 routing.

  Breaking API changes:

  - Replace Standard Schema/Zod output validation with forward-only `output.jsonSchema`. The library forwards the JSON Schema hint to providers, JSON-parses native structured output, surfaces `outputParsed`, and leaves business validation to callers.
  - Remove `InferOutput`, generic `LlmRequest`/`LlmResult` output typing, `output.schema`, `parse_error`, and `zodToGeminiSchema`.
  - Make `attemptId` the durable ledger identity. The drizzle schema now uses `attempt_id` as the primary key, removes the redundant UUID `id`, and adds `external_id`, `served_service_tier`, and `output_parsed`.
  - Add `idempotencyKey` and `externalId` request correlation fields. `idempotencyKey` is ledger idempotency only; provider calls are not deduplicated.
  - Add provider-builtin Gemini Flex fallback to standard tier on capacity pressure, with `servedServiceTier` returned and persisted so cost/retry logic uses the tier actually served.

  Gemini/Gemma routing changes:

  - Add API-verified Gemma 4 routing (`gemma-4-31b-it`, `gemma-4-26b-a4b-it`) with thinking(level), grounding, native structured output, and vision.
  - Add `nativeStructuredOutput`, `serviceTiers`, `vision`, and `audioInput` capability flags with per-model service-tier gating.

  Only two Gemma 4 model IDs are confirmed callable via the live Google Gemini API. All previously listed IDs (e2b, e4b, 12b variants, google/ aliases) return HTTP 404 and are removed. Both verified models support native structured output (responseMimeType + responseSchema), grounding, vision, and thinkingLevel reasoning. thinkingBudget is rejected by the API with HTTP 400 and is not used.

  Gemma 4 reasoning effort is now constrained to `none`/`high` only (`low`/`medium` are rejected at validation time with a `bad_request` error). This reflects live API behaviour: the models only accept MINIMAL and HIGH `thinkingLevel` values; LOW and MEDIUM return HTTP 400.

  gemini-3.1-pro-preview now rejects effort: 'none' at validation time; the model has no MINIMAL thinking level (thinkingLevel MINIMAL returns HTTP 400).

### Patch Changes

- Updated dependencies [ea4b941]
  - @gullabs/core@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [8f1bf61]
  - @gullabs/core@0.2.0
