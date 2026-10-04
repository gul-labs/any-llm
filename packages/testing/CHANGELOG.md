# @gullabs/testing

## 0.16.0

### Minor Changes

- fb79350: Every result carries the ordered assistant `message` and a `continuation` rule, `AdapterResult.message` is required, and provider state is scoped to its provider and model string (ADR-029 addendum).

  - **`LlmResult.message`** is the assistant output as an ordered `Message` on every provider: text parts and tool calls in provider order, thought, reasoning and server-tool items omitted. `text` and `toolCalls` stay as conveniences; `result.toolCalls` is a copy, so editing a tool call's `args` no longer changes the arguments in `result.message` (which a Gemini 3 signature hashes). A result with nothing representable (a thought-only response whose output cap went to reasoning) has `message.parts === []`: do not append it to history. An assistant message with no parts is `bad_request` before dispatch, on every provider.
  - **`AdapterResult.message` is required.** The engine no longer builds it from `text` and `toolCalls`, because only the adapter knows the provider's interleaving. The Google, xAI, Claude CLI and Codex CLI adapters set it, and `FakeAdapter` and `SignalAwareFakeAdapter` throw a `TypeError` for a scripted result that lacks it.
  - **`LlmResult.continuation`** (`'history' | 'state'`) repeats the descriptor's new `capabilities.continuation`. `'history'` (the default, and grok-4.5/4.6): append `result.message` and send the full history. `'state'` (grok-4.7): send only the new messages plus `result.transientProviderState` and do not replay `result.message`. `capabilities.statelessReasoningReplay` is deleted; `capabilities.providerState: true` is what lets the engine forward `transientProviderState` (`createModelRegistry` rejects `continuation: 'state'` without it).
  - **State is provider-scoped and bound to the model string the host sent.** The xAI state is `{ xai: { model, input } }` (it was `{ model, input }`), and `XaiReplayState` has that shape. Another provider's state, or state bound to another model string (an alias is a different string from its canonical id), is `bad_request`; the next turn uses the same `provider` and `model` string as the previous one (`result.model` is the id the provider returned and is not for routing).
  - **`TokenCount.accuracy`** gains `'estimated'`: the provider counted the history, but the real call sends parts the count cannot include. `@gullabs/google` reports it for a Gemini 3 history that holds function calls. `AdapterCtx.modelDescriptor` carries the resolved descriptor to `countTokens`.
  - **`@gullabs/testing`** adds `runToolLoop(client, req, tools, { auth })`, which follows `result.continuation` after every turn, turns a throwing tool into an `isError` tool result, rejects a call to a tool with no own implementation (a model call named `toString` is a missing tool) with `bad_request`, and rejects a `maxTurns` that is not an integer of at least 1.

  What hosts must change:

  - A custom `ProviderAdapter` (and any scripted `FakeAdapter` result) returns `message: { role: 'assistant', parts }`. Read `result.continuation`, or follow the README loops, instead of assuming one replay rule.
  - Do not append a result whose `message.parts` is empty to your history; retry the call. Code that switches on `TokenCount.accuracy` handles `'estimated'`.
  - Persist grok-4.7 state exactly as returned; state stored in the old `{ model, input }` shape is rejected, so restart those conversations.
  - A custom `ModelDescriptor` that declared `statelessReasoningReplay: true` declares `continuation: 'state', providerState: true` instead.

- fb79350: Typed error reasons, structured-first classification, honest billing of failures, and host callbacks that cannot crash the process.

  - **`LlmErrorReason`** is a closed union on `LlmError.reason`: `transport_timeout`, `quota_window`, `daily_quota`, `credits_exhausted`, `spend_ceiling`, `grounding_missing`, `cache_not_found`, `quota_store_unavailable`. A new member is a core minor; keep a `default` branch when you switch on it. `LlmCallRecord.errorReason` and `CallErrorEvent.reason` carry it (and `@gullabs/drizzle` stores it, see the ledger changeset).
  - **Classification reads structured evidence first.** `classifyError` checks an integer HTTP status (100-599, also a numeric string, `statusCode`, and a status that exists only on the `cause` chain) before any message text, so an `HTTP 400` whose message says "timeout" is `bad_request`. `classifyHttpStatus` maps 404 and 413 to `bad_request`, forwards `retryAfterMs` for every retryable status, and leaves 409 `unknown`. A transport failure (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE`, an allow-list of `UND_ERR_*` codes, `ENOTFOUND`, `ENETUNREACH`, `EHOSTUNREACH`, or a whole message of `fetch failed`, `connection error`, `socket hang up` or a Node syscall failure) is a retryable `server` error; undici's own deadlines stay retryable `timeout`; undici programming errors are not retried. New exports: `parseRetryAfter(headers, now)` (`retry-after-ms`, `retry-after` as seconds, HTTP-date or `6m0s`, and rate-limit reset headers read by meaning: the reset of the exhausted windows, else the earliest reset; capped at 24 h, an epoch value is not a 56-year delay), `isTransportError(e)` and `causeChain(value)` (bounded, cycle-safe; `@gullabs/xai` uses it instead of its own copy).
  - **`mayHaveBilled`.** An adapter sets `LlmError.mayHaveBilled: true` on an error that arrived after the provider had started work (an `error` event inside an open stream). `callCost.unpricedAttempts` then counts the attempt even for `rate_limited`, `bad_request` and `invalid_auth`, which are otherwise known to cost nothing; `callCost.microUsd` is a lower bound. A failed attempt with no usage is known-free only for a 4xx or 5xx status.
  - **`LlmError.warnings`** (new, with `LlmErrorOptions.warnings`): notes an adapter attaches to a failed attempt that carries `usage`; the engine writes them to that attempt's row. A billed failure keeps its usage-clamp warnings. `llm.call.sink.failed` carries `attemptId`, `attemptNumber`, `provider` and `model`.
  - **`llmErrorOptionsOf(error)`** returns every `LlmErrorOptions` field of an error-shaped value, including one built by another copy of core; the engine's own error copy and `@gullabs/testing` use it, so a field added to `LlmErrorOptions` is carried everywhere.
  - **Only `LlmError` escapes.** `generate`, `runStructured` and `countTokens` reject only with `LlmError`; anything else a host registry, a middleware or a bug throws is classified (`unknown` unless the value says otherwise) with the original as `cause`. A malformed `auth` (a string, `null`, a number, an array) is `invalid_auth` with a fixed message that never echoes the value. A missing request is `bad_request`.
  - **A host's objects are never re-stamped.** An `LlmError` used as an abort reason, or thrown by an adapter from several calls, is copied (the original as `cause`) instead of being stamped with the first call's `callId`; the engine writes rows, results and events with the `callId` it minted.
  - **Call identity is fixed at call start.** `generate()` and `runStructured()` read `provider`, `model` and the resolved descriptor once, before the first `await`, and snapshot the request, call site and options (reassigning `request.metadata` mid-call changes nothing; do not mutate nested objects in flight). After `registry.resolve` the engine verifies that the descriptor belongs to the provider and that the requested string is its canonical id or a declared alias, so a custom registry that prefix-matches fails with `bad_request`. A call whose final error did not come out of a provider attempt (a middleware refusal, a quota deferral, an exhausted retry budget, an abort during back-off) writes one zero-usage refusal row even when earlier attempts ran, numbered with the refused attempt; `attemptNumber: 0` stays "no attempt had run". The middleware list is copied and frozen at `createClient`.
  - **Middleware cannot reroute (ADR-037).** The `next` handed to every middleware refuses a request whose `provider` or `model` differs from the call's, with `bad_request` and a refusal row. The engine dispatches, validates config, prices and authenticates with the values it recorded at call start.
  - **Host callbacks are guarded.** Telemetry hooks, the logger's methods, a limiter's `Release` and the `@gullabs/quota` handlers go through one guard (exported as `guardHostCall`) that absorbs a throw (a throwing `then` getter on the returned value included) and handles the rejection of a returned promise, so `async onError` can no longer end the process after a billed call. A failed hook or logger is logged once at `debug` as `llm.hook.failed` (`callId`, `phase`, `error`). A throwing `Scheduler.clearTimeout` no longer leaves a call half cleaned up.
  - **No silent empty answers.** When any provider returns `finishReason: 'length'` with no answer, no structured output and no tool call after spending reasoning tokens, the result and the record carry a warning (`maxOutputTokens (M) was used up by reasoning (T tokens); no answer was produced`); a whitespace-only answer counts as none. `GenConfig.maxOutputTokens` is documented as including reasoning.
  - **`TokenCount.accuracy`** gains `'estimated'` (see the adapter-contract changeset).

  What hosts must change:

  - A 404 or 413 that was retried as `unknown` (or matched on `unknown`) is `bad_request`. A reset-header delay can be shorter than before.
  - Alerts or dashboards that matched `llm.telemetry.hook.failed` match `llm.hook.failed`.
  - Code that branched on a non-`LlmError` rejection reads `error.cause`. Custom `ModelRegistry` implementations resolve exactly (canonical id or declared alias).
  - Middleware that rerouted or built provider fallback moves that logic into the host: catch the error and call `generate` again with the other target's config and auth, as a separate call with its own `callId`; give both the same `externalId`. Treat the request as immutable once passed to `next`.
  - Queries that assumed `attemptNumber: 0` is the only zero-usage refusal row also expect refusal rows numbered above 0.
  - Custom adapters call `classifyError` (and `isTransportError` when they widen it) instead of keeping their own transport regexes, and may set `mayHaveBilled` and `warnings` on an error that carries `usage`.

- fb79350: `@gullabs/google`: errors classified from the structured body, filter stops and billed repeats handled, option limits, modality pricing, an incomplete call is not a tool call, and file and cache stores that classify and delete idempotently (ADR-036, ADR-039, ADR-044).

  **Errors.**

  - `classifyGoogleError` (new export) reads the structured body: `RetryInfo.retryDelay` becomes `retryAfterMs`; a per-day quota (`QuotaFailure` quota id containing `PerDay`) is `rate_limited`, `retryable: false`, `reason: 'daily_quota'`; `API_KEY_INVALID` / `API_KEY_EXPIRED` (Google sends the first as HTTP 400) are `invalid_auth`, not `bad_request`; a stale `cachedContent` (HTTP 403, "CachedContent not found") is `bad_request` with `reason: 'cache_not_found'` instead of `invalid_auth`. The expired-key, per-minute, per-day and capacity bodies are doc-derived, not captures, and no real 429 body survives.
  - `isGeminiCapacityError` is true only for HTTP 503. A Flex 429 follows the ordinary rate-limit path (the `RetryInfo` delay is honoured, no immediate Standard dispatch, no tier pin): Google documents no field that tells a capacity 429 from a quota 429, and nothing reads the message text. A flex call the adapter sends again at the standard tier carries a warning, naming the 300 s client-side ceiling when no `timeoutMs` is set.
  - A candidate that stopped for `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_SAFETY`, `IMAGE_PROHIBITED_CONTENT` or `IMAGE_RECITATION` with no answer text and no complete tool call throws `content_filter` (`retryable: false`, billed usage attached) instead of returning an empty success; the message names the blocking safety category and the error's `cause` carries the raw `finishReason`, bounded `finishMessage` and `safetyRatings`. `providerMetadata.google.candidate` carries the raw finish evidence, bounded (`finishMessage` 512 characters, lists 50 entries, strings 2048 characters, a warning when cut); `groundingMetadata` and `promptFeedback` are bounded the same way (8 levels), and citations are built from the full response.
  - Two failures that are billed and would repeat are not retried: the adapter's own client-side ceiling (5 minutes standard, 25 minutes flex, armed when no `timeoutMs` is set) and the SDK's transport timer are `kind: 'timeout'`, `retryable: false`, `reason: 'transport_timeout'` (an HTTP 408 or 504 keeps core's retry); and a candidate-less HTTP 200 that billed reasoning tokens (the output cap spent on thinking, which fails the same way again) is `server`, `retryable: false`, with the cap hint. With the default `retryMiddleware` a standard call that hit the ceiling used to run three times.
  - `countTokens` counts `messages`, `system` and `tools` (an empty `system` string is absent everywhere): with `system` or `tools` the library calls the REST `countTokens` with a full `generateContentRequest`, because the SDK's Developer API method cannot carry them. The count carries no response schema, thinking config, `toolConfig`, safety settings or Search tool, so it is not the whole prompt `generate()` bills. The REST path reads the body once (an unparseable error body is classified by its HTTP status, a non-JSON body is cut to 500 characters, a 200 that is not a JSON object is a retryable `server` error) and has not been checked against a live call. The SDK client and the REST count go to one pinned endpoint: the SDK's `GOOGLE_GEMINI_BASE_URL` override is not read.

  **Request checks (all `bad_request` before dispatch).**

  - `cachedContent` together with `system`, `tools` or `providerOptions.google.tools`; `GoogleCacheStore.create` and `getOrCreate` accept `tools` and `toolConfig` instead.
  - `safetySettings` `category` and `threshold` outside Google's documented lists (the model config schemas too).
  - An inline PDF over 50 MB (the cap follows media-type normalisation: `Application/PDF` and `application/pdf; x=y` count too), or more than 100 MB of inline data and text in a request.
  - `providerOptions.google.httpOptions.timeout` above 2147483647 ms, and, with `timeoutMs` set, below `timeoutMs + 5000`; `timeoutMs` above 2147478647 in the gemini and gemma config schemas (the SDK deadline is `timeoutMs` plus a 5 s buffer, and Node fires a longer timer after 1 ms).
  - A thinking budget at or above `maxOutputTokens` is a warning, not a rejection, as is `reasoning.effort: 'high'` on a Gemini 3.x model with `maxOutputTokens` below 4,096 (thinking reached 4,000 tokens in 7 of 72 `high` calls); `docs/thinking-token-distribution.md` has the measurements.

  **Results.**

  - A function call is complete only when the candidate finished with `STOP` (or no finish reason). Beside `MAX_TOKENS`, a filter stop or any other finish it is dropped from `toolCalls` and from `result.message`, a warning names it, and `finishReason` is `length`, `content_filter` or `other` instead of `tool_calls`.
  - A 200 with no `usageMetadata` is unknown usage: `usage.details.usage_missing` is `1`, a warning says so, and the pricing source returns an unpriced (`microUsd: null`), `estimated` cost, not an exact $0.
  - A schema answer from Gemma wrapped in a markdown code fence (41 % of 162 in a 2026-10-03 probe) is returned as sent with `outputParsed: false` and a `gemma_fenced_json` warning; nothing is unwrapped.
  - Gemini input is priced by modality: Gemini 2.5 Flash, 2.5 Flash-Lite and 3.1 Flash-Lite bill audio input (and cached audio) above text on the standard and flex tiers. The adapter records `promptTokensDetails` and `cacheTokensDetails` as `usage.details.input_<modality>` and `cached_<modality>`, and audio tokens are billed at the audio rates (an audio call used to be priced at the text rate and marked exact). A request with audio whose response reports no audio tokens gets a warning and, on those models, `confidence: 'estimated'`; a reported cached `AUDIO` count is billed at the cached audio rate even when `promptTokensDetails` is absent, and the call is `'estimated'` whenever the response leaves the audio share unknown or contradicts itself (cached tokens beside audio stay `'exact'` only when `cacheTokensDetails` covers every cached token without audio). `GEMINI_PRICED_TIERS` is `['standard', 'flex']` and `GeminiTierRates` has no `batch` (no schema admits a batch tier, so `'batch'` is an unpriced tier). `GEMINI_PRICING` is deep-frozen.
  - `GoogleCacheHandle.totalTokenCount` is the create response's `usageMetadata.totalTokenCount`, so a host can price cache storage.

  **Stores.**

  - `GoogleFileStore` and `GoogleCacheStore` classify every error through the same path as `generate()`: `provider: 'google'`, the structured overlays (a bad key is `invalid_auth`, a per-day quota `rate_limited` / `daily_quota` and not retryable, `RetryInfo` becomes `retryAfterMs`, a stale cache 403 `cache_not_found`). A file that ends `FAILED` follows `File.error`: `DEADLINE_EXCEEDED`, `INTERNAL` and `UNAVAILABLE` are a retryable `server` error, any other code a non-retryable `bad_request`, and Google's status is kept. The upload polling timeout is `kind: 'server'`, `retryable: false` (it was `timeout`, `retryable: false`, which contradicted the rule that every `timeout` is retryable): poll the file by name instead of uploading again. The poll wait and the poll request are both raced against the abort and the rest of the polling deadline, and the clock is checked before a request starts and before its answer is accepted: a poll interval longer than the time left, a stalled `get()`, or an `ACTIVE` answer that arrives after the deadline all end as the timeout error, never a handle.
  - Deleting a file or cache that Google no longer has is success, in both modes: HTTP 404, `NOT_FOUND` and the 403 whose message says the resource is not found or "may not exist" (an error with no status at all is also read by its message; any other known status, such as a 500 whose message says "file not found", is a failed delete: `failClosed` throws and `onDeleteError` fires; a status is known wherever core reads one, in `status`, `statusCode`, `code`, `response`, `error` or a `cause`, as a number or a numeric string, and in `httpStatus`) (the cache wording is a live capture, the file wording comes from public bug reports). `GoogleCacheStore.create` rejects a `ttlSeconds` that is not a positive integer before any call, an `expireTime` that does not parse falls back to now plus the TTL, and `getOrCreate` drops an expired entry from its in-process map. `GoogleFileStore.upload` passes its `signal` (an abort releases the caller), removes its abort listener on every exit, and takes a `scheduler` for the poll wait; when the deadline or an abort ends the upload first, the default wait's timer is cleared, so none stays pending (a host-supplied `sleep` cannot be cancelled and its timer runs out). The inline-size check no longer allocates an encoded copy of every text part.
  - `GeminiClientLike.countTokens` receives `systemInstruction` and `tools` at the top level of its parameters (they were under `config`), `GeminiFilesClientLike.upload` accepts `config.abortSignal`, and `GeminiCachesClientLike.create` accepts `config.tools` and `config.toolConfig` and may return `usageMetadata.totalTokenCount`: a host-supplied client implements these.
  - Deleted: `GeminiAdapterOptions._clientFactory` (the test seam is an unexported function, so it is in no shipped type), the `httpOptions.headers` field of the request type, and exports used only inside their own module.
  - **`@gullabs/testing`**: the fake Gemini candidate type gains `finishMessage`, `safetyRatings`, `citationMetadata` and `urlContextMetadata`, and `promptTokensDetails` and `cacheTokensDetails`; deleting a cache that is already gone succeeds silently in `FakeGoogleCacheStore`, as in the real store.

  What hosts must change:

  - Handle `content_filter` from a call that used to return an empty result, and do not retry it; a `403` that meant a stale cache is `bad_request` / `cache_not_found` (drop the handle and recreate); a bad API key is `invalid_auth`; a flex 429 is no longer retried on Standard at once (honour `retryAfterMs` or let `retryMiddleware` do it; only a 503 falls back).
  - A host that wants another attempt after a client-side ceiling or an output cap spent on thinking does it itself (raise `maxOutputTokens` for the second, call again for the first).
  - A tool loop that read `finishReason: 'tool_calls'` beside a stopped candidate now sees `length` or `content_filter` and no `toolCalls`; code that treated a `usage_missing`-marked cost as `0` reads `null`; Gemma schema users handle a fenced `result.text` themselves. Audio calls on the three models above now cost more (correctly); remove any use of the `'batch'` tier.
  - Move `system` and `tools` into `GoogleCacheStore.create` when you send `cachedContent`; replace any `safetySettings` value outside Google's lists; pass `httpOptions.timeout` within the bounds above and `timeoutMs` at or below 2147478647; drop `_clientFactory` (use `client`); set a proxy through your own `client`, not `GOOGLE_GEMINI_BASE_URL`.
  - Branch on `kind: 'server'` (not `'timeout'`) for a file that did not become `ACTIVE` in time; treat `invalid_auth` from the stores as a credential problem and `daily_quota` as a stop, not a retry. A custom `GeminiClientLike`, `GeminiFilesClientLike` or `GeminiCachesClientLike` follows the parameter shapes above.

- fb79350: Search facts in usage, a priced Gemini grounding fee, a fail-closed `requireGrounding`, and structured output plus Search off on Gemini 3.x (ADR-035).

  - **Search facts, on every provider.** `usage.details.web_search_requested` is `1` when the request enabled web search, and `web_search_calls` is the observed number of searches (absent when the response does not say, `0` when the provider says none ran). Google counts non-empty query strings in `groundingMetadata.webSearchQueries`, so a repeated query counts each time; a list that names no query is an unknown count. `@gullabs/xai` already reported `web_search_calls`; it now also sets `web_search_requested`, and reports `0` when xAI states that no server tool ran. A Gemini call that requested Search and whose response has no `groundingMetadata`, or no `webSearchQueries`, carries a warning.
  - **Priced fee.** `@gullabs/google` prices grounding on `cost.details.tools`: Gemini 3 charges `web_search_calls × $0.014`, Gemini 2.5 charges `$0.035` once per grounded prompt (Google's pricing page, read 2026-10-03; `pricingVersion` is `gemini-2026-10-03`). A call that ran Search is always `cost.confidence: 'estimated'`: Google's free daily allowance is shared across a project, so every fee is charged in full; a requested count that is unknown leaves the tools lane `0` and the cost estimated. `usage.details.tool_use_prompt` records `toolUsePromptTokenCount` (Gemini 2.5) and is not priced. Whether Google bills repeated queries or tool-use tokens is not established (ADR-035, BACKLOG.md). Before, a grounded call was priced as exact with no fee.
  - **Failed and cached Search.** A candidate-less or blocked HTTP 200 that billed tokens on a call that sent `googleSearch` carries `usage.details.web_search_requested = 1` (so the cost is `'estimated'`) and the grounding warning in `LlmError.warnings`, which the engine persists on the row. A Search tool held in a `cachedContent` cache is priced: `GoogleCacheHandle.toolKinds` records the kinds of tool given to `create`, `providerOptions.google.cachedContent` takes the cache name or `{ cacheName, toolKinds }` (only the name goes to Google), and a handle that lists `googleSearch` marks the call as a Search call. When the request declares no search (a bare cache name, or no cache) and the response carries `groundingMetadata`, the metadata is the evidence: `web_search_requested` is `1`, `web_search_calls` the observed query count, the fee is priced, the cost is `estimated` and a warning says the request did not declare `googleSearch`. `cachedContent` is admitted only on models with a caching capability (Gemma 4 rejects it), and the Gemini 2.5 and Gemma schemas no longer list `allowSchemaWithSearch`.
  - **`providerOptions.google.requireGrounding: true`** fails the call unless `groundingMetadata` is present with at least one query: a `server` error with `reason: 'grounding_missing'` and the attempt's usage attached; it needs `googleSearch` in the same request. The check judges only a candidate that finished with `STOP` (or no finish reason): a safety-style stop with no evidence is `content_filter` (`retryable: false`), `MAX_TOKENS` returns `finishReason: 'length'`. `grounding_missing` is `retryable: false` when an output schema is attached (the same schema plus Search request missed on every captured call of five of six Gemini 3 models, so a retry repeats a billed failure) and retryable without one.
  - **Structured output plus Search is off on all six Gemini 3.x models** (`structuredOutputWithTools: false`; it was `true`). Live probes showed Flash-Lite models skipping Search and no model returning `groundingMetadata` with a response schema (a 2026-10-03 probe: best 3.1 Pro, 2 of 4 schema calls; `docs/grounded-structured.md` has the rates). A request that sets `output.jsonSchema` with `providerOptions.google.tools: [{ googleSearch: {} }]` is `bad_request` before any network call, naming the two-call recipe. `providerOptions.google.allowSchemaWithSearch: true` is the opt-in for the pair, admitted only where a capture measured it (the six Gemini 3.x models), needing both `googleSearch` and a schema, and turning `requireGrounding` on unless you pass `requireGrounding: false`; Gemini 2.5 and Gemma reject the pair with or without the flag. Search held by a cache handle (`cachedContent: { cacheName, toolKinds: ['googleSearch'] }`) is held to the same rule: with a schema it needs the opt-in, and `allowSchemaWithSearch` and `requireGrounding` accept the handle in place of `tools`. A bare cache name with a schema is not blocked; if the response reports search queries it is returned with a warning (priced from the queries, `estimated`). A non-boolean `allowSchemaWithSearch` or `requireGrounding` is `bad_request` naming the field.
  - **`@gullabs/testing`**: `fakeGeminiResponse` accepts `toolUsePromptTokenCount`, and `FakeGoogleCacheStore` handles carry `toolKinds`.

  What hosts must change:

  - `cost_micro_usd` on a grounded Gemini row now includes the grounding fee, and is an estimate: it can overstate (free allowance) or understate (unknown count, unpriced tool-use tokens). Treat `cost.confidence: 'estimated'` and `token_details->>'web_search_requested' = '1'` accordingly.
  - Replace a grounded plus structured call on Gemini with two calls: grounded research with `googleSearch` and no schema, then structured synthesis with `output.jsonSchema` and no `googleSearch`; both keep their own ledger rows (`docs/grounded-structured.md`).
  - A host that needs proof Search ran sets `requireGrounding: true` and handles `reason: 'grounding_missing'` and `content_filter`; do not rely on a retry after `grounding_missing` on a schema call.
  - Pass `{ cacheName: handle.cacheName, toolKinds: handle.toolKinds }` as `cachedContent` when the cache holds `googleSearch` (a bare name still works and is priced from the evidence). Drop `cachedContent` from Gemma calls and `allowSchemaWithSearch` from Gemini 2.5 and Gemma calls.

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

- fb79350: The model registry: exact ids with declared aliases, stated limits and admitted media types, introspection, and a shutdown date (ADR-033, ADR-043).

  - **Exact ids (supersedes ADR-006).** `createModelRegistry` no longer falls back to the longest prefix, so `gemini-2.5-flash-image` or a live-audio id is no longer validated, adapted and priced as the shorter text model. `ModelDescriptor.aliases?: readonly string[]` declares real provider version suffixes; aliases are unique within a provider and never equal a canonical id. An unknown id is `bad_request` listing the closest registered ids. `assertModelMatchesDescriptor(req, descriptor, adapterProvider)` (new) is what the Google and xAI adapters use: a request names the canonical id or a declared alias, the string is sent to the provider unchanged and recorded as sent, and pricing and the rate-limiter key use the canonical descriptor.
  - **Limits.** `ModelDescriptor.limits: { contextWindow, maxOutputTokens }` is required, from each provider's documentation. `maxOutputTokens` is `number | null`: `null` means the provider documents no output limit (xAI Grok 4.x, Gemma 4), no figure is invented and the config schema applies no cap; a number is the schema's cap (Gemini 65,536). `maxOutputTokensSchema(limits)` is exported for the config field. `createModelRegistry` rejects missing limits, non-positive-integer limits and `maxOutputTokens` above `contextWindow`. The `claude-cli` limits are what the CLI reports for its own run (Fable 5.1 64,000 and Haiku 4.5 32,000 output tokens).
  - **Media types.** `capabilities.inputMimeTypes` lists the IANA types a model takes in `inline-media` and `file-uri` parts (lower-case `type/subtype` or a `type/*` family). `assertInputMimeTypesAdmitted`, `assertMediaTypeAdmitted` and `isMediaTypeAdmitted` are exported; the Google and xAI adapters check before dispatch, and Google also in `countTokens`. Admission ignores case and `; parameters` and sends your string unchanged; an empty or missing type is `bad_request`. Gemini admits `application/pdf` plus the `text/*`, `image/*`, `audio/*` and `video/*` families, Gemma 4 `image/*` and `video/*`, xAI `image/jpeg` and `image/png` only (`image/jpg` is rejected), the CLI providers nothing. `GoogleFileStore.upload` applies the same rule. The `capabilities.vision` and `capabilities.audioInput` flags are deleted: `inputMimeTypes` is the one statement of multimodal support.
  - **Introspection and snapshot.** `ModelRegistry.findByModel(model)` returns every descriptor whose canonical id or alias equals `model`, across providers; `listDescriptors()` is required. `ModelDescriptor.configKeys` is the sorted list of top-level config keys the schema names across a union's branches, derived with the new `toConfigKeys(configSchema)` (it follows local `$ref`s). `createModelRegistry` recomputes `configKeys` and `configJsonSchema` and rejects a descriptor whose declared ones differ, validates `inputMimeTypes`, freezes each descriptor's `limits`, `inputMimeTypes`, `aliases` and `configKeys`, and answers `resolve`, `findByModel` and `listDescriptors` from a copy taken at construction. `createClient` rejects a `modelRegistry` that lacks any of the three methods.
  - **`shutdownDate`.** A descriptor may declare `shutdownDate: 'YYYY-MM-DD'` (UTC, a real calendar date). The first successful call per client and model within 90 days of it carries a typed warning `{ type: 'shutdown', message, shutdownDate }` (`Warning` is now `{ type: 'other', message } | { type: 'shutdown', message, shutdownDate }`); later calls on that client do not repeat it (the advisory is given back when the attempt that chose it fails before it has a result), and the call is never refused. `SHUTDOWN_WARNING_DAYS` (90) is exported. `gemini-3.1-flash-lite` declares `2027-05-07` (replacement `gemini-3.5-flash-lite`), so it warns from 2027-02-06.
  - Both Gemma 4 descriptors keep `capabilities.grounding: true` on the strength of a live capture.

  What hosts must change:

  - Requests name a registered `model` or a declared alias. A string that relied on prefix resolution (a dated snapshot, a `-latest` suffix) is `bad_request`: use a registered id, or add the suffix to `aliases` on a descriptor in a custom registry.
  - A custom `ModelRegistry` resolves exactly and implements `findByModel` and `listDescriptors` (or is built with `createModelRegistry`).
  - A custom `ModelDescriptor` adds `limits`, `configKeys: toConfigKeys(configSchema)`, a `configJsonSchema` built with `toConfigJsonSchema(configSchema)`, and `capabilities.inputMimeTypes` if the model takes media; it removes `vision` and `audioInput` (ask `isMediaTypeAdmitted(type, descriptor.capabilities?.inputMimeTypes ?? [])` instead) and sets `limits.maxOutputTokens: null` where the provider documents none (code that reads it as a number handles `null`). Do not mutate a registered descriptor's `limits` or `inputMimeTypes` (it throws in strict mode).
  - A `maxOutputTokens` above a Gemini model's limit (65,536) is `bad_request` at config validation; a part whose media type the model does not admit (WebP, GIF or `image/jpg` on xAI, `application/json` on Gemini) is `bad_request` before dispatch, naming `messages[i].parts[j]`.
  - Code that narrows `Warning` on `type === 'other'` handles `'shutdown'` too; a host that treats any `warnings` entry as a failure expects the advisory once per client for `gemini-3.1-flash-lite`, and moves that model to `gemini-3.5-flash-lite` before 2027-05-07.

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

- fb79350: `runStructured` takes the same call options as `generate`, and malformed parts and messages are `bad_request`.

  - `RunStructuredOptions` gains `externalId` (persisted on every attempt row), `attachments?: Part[]` (appended to the rendered user message, after its text), `history?: Message[]` (prepended, validated like `generate` messages, sent as given: a history ending in a user message gives two consecutive user turns) and `transientProviderState` (admitted only by models that declare `capabilities.providerState`). A rendered user message that is empty, or whitespace only, with no attachments is `bad_request` before dispatch (it used to send an empty text part); attachments alone are a valid message.
  - `runStructured` checks that every `attachments` element is a part object of a known `kind` and every `history` element a `{ role, parts }` message, and `generate` checks `messages` the same way, before anything reads them. A `null`, an `{}` or an unknown `kind` is `bad_request` naming the path (`history[1].parts[0].kind`) instead of a raw `TypeError` classified `unknown`. A call site declares no tools, so `tool-call` and `tool-result` parts in `attachments` or `history` are `bad_request`; a tool loop belongs to `generate`.
  - The library still never validates `output`: hosts validate and retry.
  - `canonicalJson` serialises `-0` as `0` (as RFC 8785 and `JSON.stringify` do, so a value hashes the same before and after a JSON round trip), accepts plain objects from another realm, and rejects input nested deeper than 1000 levels or with a symbol key with `bad_request` instead of a `RangeError` or a silently ignored key.

  What hosts must change:

  - A call site with no `userTemplate` (or one that renders to the empty string) passes `attachments`, or the call fails with `bad_request`; give such a call site a template, or pass the content as an attachment.
  - Do not pass tool-call or tool-result parts to `runStructured`; use `generate` for a tool loop. Fix any code that relied on a malformed part or message reaching the provider.
  - Hosts that fell back to `generate()` to set `externalId`, attach a file or send text or media history can use `runStructured` again.

- fb79350: `@gullabs/testing` reproduces failures faithfully: error factories, recorders, a client fake, store fakes, a CLI runner fake, a `FakeClock` that is also a scheduler, and whole-adapter fakes that throw what the real adapters throw (ADR-041).

  - **Clock.** `FakeClock` implements `Scheduler`: `setTimeout`, `clearTimeout`, `advance` (fires due timers in order), `advanceAsync` (lets promise continuations run between timers), `pendingTimers`, `set`. Its methods work detached (`Clock` and `Scheduler` methods are `this: void`); `advance`, `advanceAsync` and `set` throw `RangeError` for `NaN`, an infinite amount and (for `advance`) a negative one; an `advance` inside a timer callback is allowed and time never ends behind the furthest target. Pass it as both `clock` and `scheduler` of `createClient`; `FakeAdapter`, `SignalAwareFakeAdapter` and `scriptedRateLimiter` take their delay from the client's scheduler.
  - **Errors.** `fakeHttpError`, `fakeNetworkError` (names the syscall and errno of its code: `ECONNREFUSED` is `connect`), `fakeBilledFailure`, `fakeStreamFailure({ kind?, retryable?, message?, provider?, usage? })` (the `LlmError` an adapter throws for an error event inside an open stream: `mayHaveBilled`, not retried by default, booked unpriced even for `rate_limited` or `bad_request`) and `fakeProviderError('google' | 'xai', scenario, { headers? })`, which build the real `@google/genai` `ApiError` and `openai` `APIError` from the error bodies pinned in the provider fixtures. `@google/genai` and `openai` are optional peer dependencies.
  - **Whole-adapter fakes throw what real adapters throw.** `FakeAdapter`, `SignalAwareFakeAdapter` and `FakeClient` run an error built by `fakeProviderError` through the real provider classifier (`classifyGoogleError` / `classifyXaiError`, loaded the first time one is thrown) before throwing: a per-day Gemini quota is `rate_limited`, `retryable: false`, `reason: 'daily_quota'`, exhausted xAI credits are `credits_exhausted`, a bad Gemini key is `invalid_auth`, a stale cache is `bad_request` / `cache_not_found`. `@gullabs/google` and `@gullabs/xai` are optional peer dependencies of `@gullabs/testing` (exact release version, like core). The SDK-level fakes (`makeFakeGemini`, `makeFakeXai`) still hand the raw SDK error to the real adapter. Tests run each scenario through a `FakeAdapter` and through the real adapter and require equal results. `FakeClient` rejects only with `LlmError`, like a real `Client`: an `Error` entry is classified with core's `classifyError` (the original is the `cause`). `FakeAdapter` and `SignalAwareFakeAdapter` throw `TypeError` at construction for an entry that is neither an `Error` nor a complete `AdapterResult` (replace `{ status: 429 }` with `fakeHttpError(429)`); concurrent delayed `FakeAdapter` calls each take their own entry.
  - **Abort.** `FakeClient.countTokens` rejects an already-aborted signal (`aborted`) before it answers, like the real client, and `SignalAwareFakeAdapter` keeps its abort listener until the call settles, so an abort that lands while an error is being classified wins.
  - **Recorders.** `RecordingSink({ dedupeOn: 'attemptId' })` is idempotent on `attemptId` like the Drizzle ledger (repeats are kept on `duplicates`), de-duplicates the payload on its own as the payload table does (the first payload for an `attemptId` wins, including one that arrives with a repeat of a record that had none), and keeps payloads on `payloads`; `RecordingTelemetry`; `RecordingLogger` (`messages(level)`, `find(event)`); `fakeLlmResult` (an unpriced, `estimated` cost and one unpriced attempt in `callCost` by default instead of an exact `$0`, and `callId` / `attemptId` numbered per process so two results do not collide under `dedupeOn`); `FakeClient` (request capture, `expectRequest`).
  - **Stores and runner.** `FakeGoogleFileStore` (applies the real store's media-type admission, takes `failUpload`, rejects a blank name with `bad_request`, routes an aborted `delete` signal through `failClosed` / `onDeleteError`, and ends an `upload` at once when the signal aborts while it reads a Blob, each checked against the real store in a parity test) and `FakeGoogleCacheStore` (takes `failCreate`, `preflight` and `coalesce`; handles carry `toolKinds`; deleting a gone cache succeeds) classify scripted errors as the real stores do. `FakeCliRunner` scripts `@gullabs/claude-cli` and `@gullabs/codex-cli` runs, including `{ timeout: true }`, which rejects with a `TimeoutError` as a runner whose timeout expired does. `fakeXaiResponse` builds `function_call` output items (`functionCalls`).
  - **`@gullabs/google`** exports `classifyGoogleError` and `GEMINI_INPUT_MIME_TYPES` for this, and its file store takes a `scheduler` for the poll wait; the Gemini flex/standard client-side timeout ceiling runs on `ctx.scheduler`, so a `FakeClock` passed as the client's `scheduler` fires both.

  What hosts must change:

  - A test that threw `fakeProviderError(...)` from a `FakeAdapter` and expected the engine's generic classification now sees the provider's classification; update the expected `kind`, `retryable` and `reason`. Install `@gullabs/google` / `@gullabs/xai` next to `@gullabs/testing` to use those scenarios in a whole-adapter fake (and for `FakeGoogleFileStore.upload`, which takes its admitted media types from `@gullabs/google`).
  - Code that read the raw error off a `FakeClient` rejection reads it from `error.cause`. A `fakeLlmResult()` that relied on a priced `$0` passes `cost`. A `FakeAdapter` entry that is not an `Error` or a complete result is a `TypeError`.

## 0.8.2

### Patch Changes

- 64942d1: Add `serviceTier` to the exported fake Gemini usage metadata type so host tests can simulate the provider's served-tier echo.
- Updated dependencies [64942d1]
  - @gullabs/core@0.15.0

## 0.8.1

### Patch Changes

- Updated dependencies [cb4980f]
  - @gullabs/core@0.14.1

## 0.8.0

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

## 0.7.1

### Patch Changes

- 6a5a662: Fix Codex WS-C follow-ups: file-ref attachment pricing is estimated until the counter is live-pinned; Google toolCallId uses provider `functionCall.id` (or a unique per-name suffix) and replays it; requested tool names/count persist alongside generationConfig.
- Updated dependencies [6a5a662]
  - @gullabs/core@0.13.1

## 0.7.0

### Minor Changes

- 0521973: Breaking (pre-1.0): function-calling seam (ADR-029). `FinishReason` includes `tool_calls`; `tool-call` / `tool-result` parts; `LlmRequest.tools` / `toolChoice`; `toolCalls` on results and records.

  No agent loop. `runStructured` + tools is `bad_request`. Google and grok-4.5/4.6 implement and gate on `functionCalling`. CLI adapters reject `tools` and the new part kinds. Google `countTokens` stays `exact` with tools; xAI `countTokens` rejects tools. xAI store:false replay is live-verified.

### Patch Changes

- Updated dependencies [0521973]
- Updated dependencies [0521973]
  - @gullabs/core@0.13.0

## 0.6.1

### Patch Changes

- Updated dependencies [90a47a1]
  - @gullabs/core@0.12.1

## 0.6.0

### Minor Changes

- 2ab1ea6: Add `grok-4.6` with live-verified reasoning (`low`/`medium`/`high`/`xhigh`) and `serviceTier: 'priority'`. Widen core `ReasoningEffort` with `'xhigh'`. Refresh xAI pricing (`xai-2026-08-12`: 4.5 cached $0.30/$0.60; 4.6 $2/$0.50/$6 and $4/$1/$12) and re-verify Gemini snapshot (`gemini-2026-08-12`; registered-model rates unchanged). xAI `price()` now receives the served tier (`'default'` | `'priority'`) instead of `undefined`; custom xAI pricing sources must price `'default'` at the standard list.

### Patch Changes

- Updated dependencies [2ab1ea6]
  - @gullabs/core@0.12.0

## 0.5.0

### Minor Changes

- 09010db: File-store fail-closed delete + xAI Files host ergonomics.

  - `XaiFileStore` / `GoogleFileStore`: `delete(id, { failClosed?: boolean, signal? })` — default fail-open; opt-in throw on non-not-found failures; empty id always `bad_request`; 404 success both modes.
  - `@gullabs/testing`: `FakeXaiFileStore` in-memory store with TTL clock and fail-closed delete.
  - Docs: multi-provider install (core + google + xai + peers); attachment_search counters visible on `usage.details` / `usage.raw`.

## 0.4.3

### Patch Changes

- Updated dependencies [d46fd27]
  - @gullabs/core@0.11.0

## 0.4.2

### Patch Changes

- Updated dependencies [a3f74be]
  - @gullabs/core@0.10.0

## 0.4.1

### Patch Changes

- b2b7f8c: docs: host-owned factory wiring example
- Updated dependencies [20453fc]
  - @gullabs/core@0.9.0

## 0.4.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [0b44a5e]
  - @gullabs/core@0.8.0

## 0.3.0

### Minor Changes

- ba21620: Provider-qualified model identity — explicit `(provider, model)` everywhere (breaking, pre-1.0).

  - `LlmRequest`, `CallSite`, and `ResolvedRequest` now require a top-level `provider: string`; `model` stays the bare provider-native string forwarded verbatim to SDKs/CLIs. Bare requests without a provider, unregistered `(provider, model)` pairs, and slash-style `'provider/model'` strings are rejected with `bad_request`.
  - `ModelRegistry` is keyed by `(provider, model)`: `resolve(provider, model)`, `ModelDescriptor.id` renamed to `model`, duplicate exact pairs throw, the same bare model may exist under multiple providers with different config schemas, and prefix matching never crosses providers.
  - Routing is always by `req.provider`: the single-adapter bypass is removed, custom `route(provider, model, adapters)` results are checked against `adapter.id === req.provider`, and `createClient` verifies every registry descriptor's provider has a matching adapter.
  - Pricing composes per provider: `ClientConfig.pricing` is replaced by `pricingSources: Record<provider, PricingSource>`; the port shape is unchanged and `geminiPricingSource()` is the google-scoped source. A provider without a source yields an unpriced result with a warning.
  - Telemetry events carry `provider`; quota's `providerQuotaMiddleware` reads `req.provider` from the request (the `provider` option is removed).

### Patch Changes

- Updated dependencies [ba21620]
  - @gullabs/core@0.7.0

## 0.2.5

### Patch Changes

- Updated dependencies [e3da339]
  - @gullabs/core@0.6.0

## 0.2.4

### Patch Changes

- Updated dependencies [b39ceac]
  - @gullabs/core@0.5.0

## 0.2.3

### Patch Changes

- Updated dependencies [78b7636]
  - @gullabs/core@0.4.3

## 0.2.2

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

## 0.2.1

### Patch Changes

- Updated dependencies [dab0792]
  - @gullabs/core@0.4.1

## 0.2.0

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

## 0.1.2

### Patch Changes

- Updated dependencies [ea4b941]
  - @gullabs/core@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [8f1bf61]
  - @gullabs/core@0.2.0
