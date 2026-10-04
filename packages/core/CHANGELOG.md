# @gullabs/core

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

- fb79350: Citations say whether the answer cites them and where (`Citation.cited`, `Citation.textRange`), and Google exposes `searchEntryPoint`.

  - **`Citation`** gains `cited?: boolean` (the answer text itself cites the source) and `textRange?: { start; end }` (the first span of `LlmResult.text` tied to the source, UTF-16 offsets, `text.slice(start, end)`).
  - **Gemini** fills them from `groundingSupports`: a chunk a support points at is cited, Google's UTF-8 byte offsets are converted (`partIndex` does not count thought parts, and the answer part is indexed among the non-thought parts), and no `groundingSupports` leaves both absent. Each range is checked against `groundingSupports[].segment.text`: when the slice of `result.text` is not exactly that text the range is dropped, the source stays `cited: true`, and the result carries a warning.
  - **xAI** fills them from `url_citation` annotations: a non-empty range is verified (the slice of `result.text` must be exactly `[[N]](<the source's url>)`, indexed from the start of the `output_text` part that carries the annotation, in UTF-16 code units) and gives `cited: true`; a wrong range is dropped with a warning and the source stays `cited: true`. A zero-width annotation leaves `cited` absent, because xAI reported no marker range, which says nothing about whether the answer cites it: on xAI `cited` is never `false`. The numeric label of the source's own inline marker (`"1"`) is no longer reported as `Citation.title`; a real numeric title such as `"2024"` is kept.
  - **`providerMetadata.google.searchEntryPoint`** is the one place the Search Suggestions widget Google requires a grounded answer to display is stored; the raw `providerMetadata.groundingMetadata` no longer contains `searchEntryPoint` (it was a second copy of kilobytes of HTML on every persisted grounded row). Render `renderedContent` as untrusted HTML in a sandboxed iframe.

  What hosts must change: do not read `citation.title === '1'` as a title; a UI that needs the sources with an inline marker filters on `cited === true`; treat a missing `cited` on xAI as unknown, not uncited; treat a missing `textRange` on a `cited: true` citation as "no verified range"; read the widget from `providerMetadata.google.searchEntryPoint`, not from `providerMetadata.groundingMetadata.searchEntryPoint` (the raw copy is gone).

- fb79350: The cost of a whole call, per-attempt telemetry, the provider's own billed total beside the snapshot price, and an advisory spend ceiling (ADR-036, ADR-039).

  - **`Telemetry.onAttempt?(AttemptEvent, span?)`** fires once per provider attempt, after the attempt's ledger row went to the sink, with `attemptNumber`, `usage`, `cost` and, on failure, `errorKind`, `reason` and `retryable`; a refusal that never reached an attempt emits none. Hooks are never awaited and their failures are swallowed.
  - **`LlmResult.callCost?: { microUsd, attempts, unpricedAttempts }`** (type `CallCost`) sums the library-priced amount of every attempt (retries and billed failures included), counts the attempts that began, and counts attempts that were dispatched but have no priced usage (a timeout, abort or connection failure with no usage, or usage that could not be priced). `unpricedAttempts > 0` means `microUsd` is a lower bound; attempts known to cost nothing (rejected before dispatch, provider 400/401/429 and other HTTP error answers) are not counted. `result.cost` stays the successful attempt alone. `CallSuccessEvent` and `CallErrorEvent` carry `callCost`; `CallErrorEvent` also gains `usage` and `cost` of the last failing attempt.
  - **`Cost.providerReported?: { microUsd }`** carries the total a provider says it billed. For xAI it is `usage.cost_in_usd_ticks` (1 tick = 1e-10 USD) rounded to whole µUSD, present even when the snapshot cannot price the call. `Cost.microUsd` stays the snapshot price, and the engine adds a `cost drift` warning when the totals differ by more than 1 µUSD per lane that can carry rounding (a non-zero amount, or tokens for it, including a lane that rounded to zero).
  - **Unknown or unpriced usage is not exact.** `normalizeUsage` returns `estimated` and warns when `totalTokens` is larger than `inputTokens + outputTokens` (the provider counted tokens the fields omit, as Gemini 2.5 does for Search results), and the engine reports that call's cost as `'estimated'`. xAI server-tool counters are classified by an explicit table: `mcp_calls` (Remote MCP) is token-only on xAI's pricing page and stays `'exact'`; counters xAI bills per use with no rate here (`code_interpreter_calls`, `file_search_calls`, `document_search_calls`, `image_generation_calls`) and any counter the table does not know make the call `'estimated'` with a warning. Image and X video understanding are token-priced and name no counter, so none is added; the warning then says the token cost may be complete.
  - **`spendPreflightMiddleware({ limitMicroUsd, key, spentSoFar })`** calls your `spentSoFar(key)` (micro-USD, from your ledger) before dispatch and, at or above `limitMicroUsd`, throws `rate_limited`, `retryable: false`, `reason: 'spend_ceiling'` with a refusal row. It is advisory: the read and the dispatch are not atomic, concurrent workers can overshoot, and the call that crosses the ceiling is allowed. A `spentSoFar` that throws or rejects fails the call closed with `LlmError { kind: 'server', retryable: false, cause }`. It sets no `Middleware.role` and works inside or outside retry; inside `retryMiddleware`, a provider failure followed by a ceiling hit leaves the caller with the `spend_ceiling` error.

  What hosts must change:

  - A host that showed `result.cost` as "cost of this request" under-reported when retries billed: read `result.callCost` instead, and treat `microUsd` as a lower bound when `unpricedAttempts > 0`.
  - A call that ran an unpriced server tool is `'estimated'`; treat `cost.confidence` accordingly. A `cost drift` warning means the provider's prices changed or a billed lane is missing: re-snapshot the rates.
  - Nothing is required to use `spendPreflightMiddleware`; add it to `ClientConfig.middleware` (first, outside retry, to check once per logical call).

- fb79350: One call deadline shared by the engine and retry, an abort that never dispatches, a bounded sink, a scheduler port, and a retry that honours the provider's delay.

  - **The call deadline.** `timeoutMs` is armed when the call starts, so middleware time counts against it, and `EngineCtx.deadlineAt` (new, on the `clock`'s scale) is the end of that budget. `EngineCtx.signal` is the caller's signal merged with the deadline (it can abort with an `LlmError('timeout')` reason), and an attempt's window is what the deadline has left. An attempt that ends without a result after the timer fired, while the call is still pending, ends the call with the deadline error and aborts `ctx.signal`, so a middleware that hangs cannot hold `generate()`. A result an attempt produced is returned when work after `next()` runs past the deadline: one success row, no `timeout`. `config.timeoutMs`, `sinkTimeoutMs` and `countTokens`' `timeoutMs` must be finite, greater than 0 and at most 2147483647 (a longer timer fired after 1 ms), else `bad_request` before any row.
  - **Validators run under the deadline.** An async `inputContract` validator and the per-attempt config validation end at `timeoutMs` or the caller's abort (a validator that never settles no longer holds `generate()` or `runStructured()`), and a deadline that passed while one ran is re-checked before the middleware chain and before dispatch.
  - **Retry.** `retryMiddleware` measures against `ctx.deadlineAt`, reads `ctx.clock` and no longer takes a `now` option or stamps `attemptTimeoutMs`. It validates its policy at construction (`maxAttempts` a positive integer, `baseDelayMs` and `maxDelayMs` finite from 0 to 2147483647, `shouldRetry` synchronous), and `maxDelayMs` defaults to 60 s, the same as the quota `maxDeferMs`. A provider `retryAfterMs` is honoured or the retry stops: a delay longer than `maxDelayMs`, or one that leaves the next attempt less than 250 ms of the budget, rethrows that attempt's own error with `retryAfterMs` intact (whatever `shouldRetry` says) and logs `llm.call.retry.stopped`; a delay that is `NaN`, zero or negative is not a delay; up to 10 % (at most 1 s) of jitter is added on top of a provider delay. `computeBackoffMs` returns `retryAfterMs` unchanged and `maxDelayMs` caps only the computed back-off. A retry is pinned to the served tier only when the request named a tier, so an untiered call is never retried with an explicit `serviceTier: 'standard'`.
  - **Abort.** A signal that is already aborted fails `generate()` / `runStructured()` with `aborted` before the middleware chain (one refusal row, `onError`), an abort between attempts stops the next dispatch, and `countTokens` rejects without calling the adapter. A middleware or adapter that rejects with the signal's own reason (any custom `Error`) is `aborted` with that reason as `cause`. A `signal` that is not an `AbortSignal` is `bad_request` (`issues[0].path` `signal`) and arms no timer.
  - **Sink and limiter.** `ClientConfig.sinkTimeoutMs` (default 5000) bounds each `sink.record`; on expiry the engine logs `llm.call.sink.timeout` and returns the result or error unchanged. The wait also ends 100 ms after an abort or the deadline (`llm.call.sink.interrupted`); the write is always started. When a timeout or abort wins while `rateLimiter.acquire` is pending, the engine calls the `Release` it resolves with later.
  - **`ClientConfig.scheduler?: { setTimeout, clearTimeout }`** runs every wait the engine owns (attempt timeout, deadline, sink waits, retry back-off through `EngineCtx.scheduler`, adapter waits through the optional `AdapterCtx.scheduler`). The default is the platform's timers; the scheduler must run on the `clock`'s scale. `FakeClock` implements both. `countTokens` passes the scheduler to the adapter.
  - **`countTokens` takes `CountTokensOptions`** (`GenerateOptions` plus an optional `timeoutMs`); caller abort and the timeout end the call even when the adapter ignores its signal.
  - `RateLimiter.acquire(key, signal, hint?)` receives a `RateLimitHint` (`estimatedInputTokens`, an estimate from the new `estimateInputTokens(req)` that does not count media, and `nowMs`, the engine clock's reading) and `Release` takes the attempt's usage, `(usage?: Usage) => void`.

  What hosts must change:

  - Drop `now` from `retryMiddleware` options and give the client a `clock` that advances in real time when you set `timeoutMs`; a frozen clock leaves middleware time uncounted. A call whose `timeoutMs` was above 2147483647 or not positive now fails with `bad_request`.
  - A 429 whose `retryAfterMs` exceeds `maxDelayMs` now reaches the caller after the first attempt instead of being retried early: raise `maxDelayMs` to wait in process, or reschedule from `error.retryAfterMs`. Code that matched the old "Overall timeout budget" message reads `kind` and `retryable`.
  - A hand-built `EngineCtx` (a middleware unit test) adds `scheduler`. A middleware that waits or does I/O honours `ctx.signal`; a custom `RateLimiter.acquire` rejects when its signal fires.

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

- fb79350: Gemini 3.x function calling works across turns: thought signatures travel as an overlay on the host's history (ADR-029 addendum).

  Gemini 3.x returns a `thoughtSignature` on the first function call of each model turn and answers HTTP 400 when a replayed function call has lost it. The adapter used to discard the signature, so every Gemini 3.x request that replayed a tool call failed.

  - **The overlay.** `result.transientProviderState` is `{ google: { signatures: [{ messageIndex, partIndex, kind, model, partSha256, signature }] } }`, an overlay that says which part of the host's own messages gets which signature; the library keeps no copy of the history. `kind` is `'text'` or `'tool-call'`. `partSha256` is the SHA-256 of the part's RFC 8785 canonical JSON, so an edited text or tool argument is detected while key order is not (history stored in Postgres `jsonb` still verifies). `@gullabs/core` exports `canonicalJson(value)`, a dependency-free RFC 8785 serializer for `JsonValue`.
  - **Replay rules, all `bad_request` before dispatch.** Every function-call entry must hit an assistant message whose part at `partIndex` hashes to `partSha256`, issued for the same `model` string the request names; an edited, reordered or removed function call, an out-of-range index, a duplicate entry, another provider's state or a malformed overlay is rejected, and an assistant message that replays tool calls needs an entry for its first tool-call part (which also rejects history produced by another provider). A stale **text** entry (edited, trimmed, moved or removed text, or issued for another model) is dropped with a warning and not carried into the next state, because Google treats text signatures as optional, so a host that `.trim()`s the final answer keeps working. Google's dummy signature is not offered.
  - **Trimming.** `dropMessagesFromSignatureState(state, indices)` (new, exported) drops the entries of messages you removed and shifts the later `messageIndex`es down; the `@gullabs/google` README shows a front-trim, a rewind and a compaction. The rule is whole turns only, and never keep a message that holds a function call without its entry. A response that cannot be hashed (a lone surrogate in a function call's arguments or in text) no longer fails a billed call: the result is returned without an entry for that part and with a warning, and the next turn's `bad_request` names the part.
  - **Wire shape.** `functionResponse.response` is always an object: an error result is `{ error }`, a non-object result is wrapped as `{ output }`, an object is sent as is. Gemini returns a `functionCall.id` and the adapter keeps it as the tool call's id. An id the library synthesizes when Gemini sends none is `anyllm_call_<name>_<n>` (it was `call_<name>_<n>` and was replayed to Gemini), is unique among the ids already in the history, and is never sent to Gemini (a response pairs with its call by name and order).
  - **Import.** `geminiContentToMessages({ contents, model })` imports signatures from model text and `functionCall` parts into a returned `transientProviderState` instead of rejecting them; a signature on any other part, or without `model`, is `bad_request`.
  - Gemini 2.5 and Gemma need no signatures. `countTokens` sends none, so it reports `accuracy: 'estimated'` for a Gemini 3 history that holds function calls.

  What hosts must change:

  - On Gemini 3.x, send each turn with `result.message` appended unedited to the history and `result.transientProviderState` passed back as `transientProviderState`, on the same `model` string. Store the state with the history it belongs to; after removing messages pass their positions to `dropMessagesFromSignatureState` instead of editing the state by hand. The `@gullabs/google` README shows the loop.
  - Hand-authored or other-provider function-call history cannot be replayed into Gemini 3.x (there is no signature to attach); keep such conversations on the provider that produced them.
  - Code that matched synthesized ids of the form `call_<name>_<n>` uses `anyllm_call_<name>_<n>`.

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

- fb79350: Standard JSON Schema on Google and xAI, and a schema keyword a provider would ignore is `bad_request` (ADR-034).

  `output.jsonSchema` and `tools[].inputJsonSchema` are standard JSON Schema (a 2020-12 subset). Google and xAI accept every keyword and silently ignore the ones they do not enforce, so each adapter declares the keywords it enforces and rejects the rest with `bad_request`, naming the JSON path (`output.jsonSchema.properties.kind`, `tools[1].inputJsonSchema...`; names containing `.`, `[`, `]`, `"` or `\` are bracket-quoted), before dispatch. Nothing is rewritten. Annotations (`$schema`, `$id`, `$comment`, `title`, `description`, `examples`, `default`, `deprecated`, `readOnly`, `writeOnly`) are accepted by both. `@gullabs/claude-cli` passes the schema to the CLI untouched and `@gullabs/codex-cli` keeps its own OpenAI-strict preflight, so neither runs these checks.

  - **Malformed schemas fail closed.** A value in a schema position that is not a schema (`properties: { a: 'string' }`, `items: 'string'`, `anyOf: ['x']`), a keyword value of the wrong type (`maxLength: '3000'`, a negative or fractional count, a `required` that is not a list of names), a `pattern` that is not a valid regular expression, a `$ref` that points at data (`#/properties`), a cyclic JavaScript object (what a dereferencing tool produces; use `$ref` / `$defs`) and nesting deeper than 128 levels are `bad_request` with the path. A circular `$ref` error names the `$ref` that closes the cycle, and a `$ref` that only leads to other `$ref`s is rejected everywhere.
  - **Google** sends `responseJsonSchema` and `functionDeclarations[].parametersJsonSchema`, always, verbatim and in your key order (the OpenAPI-dialect `responseSchema` and `parameters` fields are gone). `$ref` / `$defs` (recursive too), `anyOf`, `prefixItems`, `items: false` and `additionalProperties` are enforced; `const`, `allOf`, `exclusiveMinimum`, `multipleOf` and `uniqueItems` are ignored and `oneOf` is read as `anyOf`, so those are rejected. `pattern`, `minLength` and `maxLength` are accepted but only probabilistically obeyed. Gemma additionally rejects `format`, `minLength` and `maxLength`; the Gemma profile follows the resolved descriptor, so a declared alias gets it. A `format` other than `date-time`, `date` or `email` is rejected (`time` included). `pattern` is held to the same regex subset as xAI, inside a character class too (`[\p{L}]` is rejected like `\p{L}`).
  - **xAI** runs the same assertion on tool schemas as on output schemas, and rejects the keywords xAI documents as not enforced: `oneOf`, `allOf`, `not`, `if`/`then`/`else`, `multipleOf`, `uniqueItems`, a constraining `propertyNames`, a recursive `$ref`, an unlisted `format`, `items: false`, a pattern outside xAI's regex subset, and `minLength`/`maxLength`, `minItems`/`maxItems`, `minProperties`/`maxProperties` above xAI's limits.
  - **`z.record(z.string(), X)` works on both providers.** It emits `propertyNames: { type: 'string' }`, which constrains nothing; exactly that form is accepted and sent verbatim. Any other `propertyNames` (`z.record(z.enum([...]), X)`) is rejected.
  - **`@gullabs/core` exports** `assertStandardJsonSchema` (moved from `@gullabs/xai`, where it was internal), `assertJsonSchemaProfile` and `JsonSchemaProfile` (what adapters call), and `PORTABLE_JSON_SCHEMA_KEYWORDS`, `PORTABLE_JSON_SCHEMA_FORMATS` (frozen) and `assertPortableJsonSchema`: the intersection of the **Gemini 3.x and xAI** profiles, for a build-time lint of every call site (Gemma 4 additionally rejects `format`, `minLength` and `maxLength`; `claude-cli` and `codex-cli` are outside it).
  - `output.jsonSchema` for a custom descriptor with `nativeStructuredOutput: false` is `bad_request`; it used to be dropped without a word.

  What hosts must change:

  - Replace `z.literal('x')` (emits `const`) with `z.enum(['x'])`; replace `z.discriminatedUnion` (emits `oneOf`) with `z.union` (emits `anyOf`); drop `multipleOf`, `uniqueItems`, `exclusiveMinimum` and `allOf`, or validate those constraints in your own code. On Google remove `format: 'time'` and any `format` outside the three above; on xAI remove a recursive schema. If you use Zod's `startsWith`, `endsWith` or `includes`, chain `.meta({ format: undefined })` (or write `z.string().regex(...)`) so the non-standard `format` is dropped and the `pattern` stays. Fix any schema the checks reject (the error names the path).
  - Add `assertPortableJsonSchema(z.toJSONSchema(schema), 'call-site-name')` to a test over every call site that must run on both Gemini 3.x and xAI.
  - Validate `output` yourself: `pattern`, `minLength` and `maxLength` on Gemini are soft, and the library never validates the result.

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

- fb79350: `@gullabs/quota`: consume only on allow, a time-zone day boundary, tokens per minute, presets, an in-memory store, a bounded Upstash call and an explicit store-failure policy (ADR-041).

  **Windows and policies.**

  - **Consume on allow.** `upstashQuotaStore.checkAndConsume` runs one Lua `EVAL` that reads every counter and increments them all only when every window is under its limit, so a denied call changes nothing (it used to increment both windows before deciding). A custom `QuotaStore` checks and consumes atomically too (all windows or none); the Upstash store needs `EVAL`, which Upstash REST supports. A single call larger than a whole window passes into an empty window.
  - **`ProviderQuotaRule.dayBoundary?: { timeZone }`** (`Intl.DateTimeFormat`, no dependency, correct on DST days) rolls the per-day window over at local midnight; the counter's TTL is the time left in that day, in whole milliseconds (a fractional clock no longer leaves a dangling counter). The day counter is keyed by the zone's canonical name (`US/Pacific` and `America/Los_Angeles` share a counter; UTC spelled any way is the same window as no boundary). `ProviderQuotaRule.tpm` limits input tokens per minute.
  - **Builders.** `quotaPolicy({ provider, models, defaults, dayBoundary?, scope? })` (limits are looked up by own property, so a model named `toString` or `constructor` gets `defaults`), `quotaPolicyForGemini` (now defaulting to `America/Los_Angeles`: Google's rate-limits page, read 2026-10-03, says daily quotas reset at midnight Pacific time; limits are per project, so use one scope per project) and `quotaPolicyForXai` (no numbers baked in: xAI limits depend on the team's tier, so the host passes `rpm` and `tpm`; no day window). `models` are keyed by canonical model id: a table keyed by a declared alias of the model being called throws `bad_request` instead of silently not limiting it. An option or limit key the builders do not know (`defaultLimits`, a misspelt `rpmm`, an `rpd` on the xAI preset) is `bad_request`, and so is a limit that is not a non-negative integer, **checked when the policy is built** (a `NaN` from `Number(process.env.X)` is a startup error, not the first request's). `rpm: 0`, `rpd: 0` and `tpm: 0` all mean "provider disabled" (`deny`, `provider_disabled`, no store round trip).
  - **`inMemoryQuotaStore({ clock })`** for tests and single-node hosts; `providerQuotaMiddleware` works without a `store` (a limit of `0` still denies, the windows are skipped with one `llm.quota.windows_skipped` warning per instance and scope).
  - **Tokens.** The engine passes `RateLimitHint.estimatedInputTokens` (from the new `estimateInputTokens(req)`, which counts text, tool calls and results, tool declarations and the output schema, and not media) to `RateLimiter.acquire` and releases with the attempt's usage; `providerQuotaMiddleware` does the same itself. The reservation is corrected with the real usage through the new `QuotaStore.adjustTokens`, started when the attempt ends and never awaited (at-most-once: a process that ends first loses the correction and the reservation stays; a failure is a `backend_error` event and an `llm.quota.reconcile_failed` warning; `Release` and `QuotaAdmission.reconcile` correct once however often they are called). `enforceProviderQuota` resolves to a `QuotaAdmission` instead of `void`.

  **Deferrals and errors.**

  - **`maxDeferMs`** (middleware and `providerQuotaRateLimiter`, default 60,000, a finite number >= 0 else `bad_request` at construction; `Infinity` is rejected, pass a large finite number to disable the cap): a deferral longer than that fails with `rate_limited`, `retryable: false`, `reason: 'quota_window'` instead of being retried, so retry does not sleep through a per-day window. 60 s equals the retry `maxDelayMs` default, so a per-minute deferral stays retryable.
  - **A `deny` is a typed error:** `rate_limited`, `retryable: false`, `reason: 'quota_window'` (the decision and the `deny` event keep `provider_disabled`).
  - **A fail-closed store outage is one error.** Under `onStoreError: 'fail-closed'` every store failure (a timeout, an HTTP failure, a transport failure, a malformed reply, a store that throws its own `rate_limited`) is `LlmError { kind: 'server', retryable: false, reason: 'quota_store_unavailable' }` with the store's error as `cause`; one store call per dispatch and one refusal row. A caller abort or deadline that interrupts the call is still the abort or the timeout. `onStoreError` (`'fail-open' | 'fail-closed'`, no default) is validated when the middleware or limiter is built. A malformed Upstash `EVAL` reply is a store failure and never an admission: the reply must be an array of one status (exactly `0` or `1`) and one non-negative integer counter per window, a `1` must follow from windows that started under their limits, and a `0` must be explained by a window over its limit (an unknown status such as `2` used to read as a denial that a low count then turned into `allowed: true`).
  - **Order.** `Middleware` gains a readonly `role?: 'retry' | 'quota'` (set by `retryMiddleware` and `providerQuotaMiddleware`, not configurable); `createClient` rejects, with `bad_request`, a quota middleware outside a retry middleware, whatever the ids. The middleware looks the policy up by the descriptor's canonical model id, so an alias is limited like its model, and core pins `modelDescriptor` at every middleware boundary.
  - **Time.** Windows are named by the `now` option, else the engine clock (`ctx.clock`; for the limiter, `RateLimitHint.nowMs`, which the engine sets from the same clock), and only a direct `acquire` call with no time uses the system clock.
  - **`upstashQuotaStore({ url, token, timeoutMs?, scheduler? })`** bounds each REST call (default 2,000 ms), passes the caller's signal so a slow store cannot hold a call past its `config.timeoutMs`, clears its timer and listener when a custom `invoke` throws synchronously, and cancels the body of a non-OK response.
  - CI runs the shipped Lua scripts and the Upstash store on a real Lua interpreter (`lua5.4`, `REQUIRE_LUA=1`).

  What hosts must change:

  - Order middleware as `[retryMiddleware(...), providerQuotaMiddleware(...)]`; the reverse is rejected at construction.
  - Pass `onStoreError: 'fail-open' | 'fail-closed'` to `providerQuotaMiddleware`, `providerQuotaRateLimiter` and `enforceProviderQuota` whenever a store is given: there is no default and a missing value is `bad_request`. Handle `quota_store_unavailable` (the quota store is down, not the provider) where you handle store outages, and `reason: 'quota_window'` by rescheduling (`retryAfterMs` is still set) rather than retrying in process.
  - A custom `QuotaStore` implements `adjustTokens` (a no-op when it enforces no `tpm`), bounds its own calls (`adjustTokens` is not awaited by the call), and its `checkAndConsume` receives the optional `tpm`, `tokens` and `dayBoundary` inputs. A custom `RateLimiter` may ignore the new `hint` and `usage` arguments.
  - Rename `quotaPolicyForGemini({ defaultLimits })` to `defaults`; key `models` by canonical ids; pass a finite `maxDeferMs`; to wait out a per-minute window with `retryMiddleware`, set its `maxDelayMs` and `maxAttempts` high enough (every deferral consumes an attempt).
  - Replace `rpm: 0` meaning "unlimited" with an omitted `rpm`; `tpm: 0` is a disabled provider, not an error. Existing per-day counters keyed by the UTC date, or by a non-canonical zone alias, are not reused. Handlers `onEvent`, `onReconcileError` and `onWindowChecksSkipped` may be `async`: a rejection can no longer crash the process.

- fb79350: `runStructured` takes the same call options as `generate`, and malformed parts and messages are `bad_request`.

  - `RunStructuredOptions` gains `externalId` (persisted on every attempt row), `attachments?: Part[]` (appended to the rendered user message, after its text), `history?: Message[]` (prepended, validated like `generate` messages, sent as given: a history ending in a user message gives two consecutive user turns) and `transientProviderState` (admitted only by models that declare `capabilities.providerState`). A rendered user message that is empty, or whitespace only, with no attachments is `bad_request` before dispatch (it used to send an empty text part); attachments alone are a valid message.
  - `runStructured` checks that every `attachments` element is a part object of a known `kind` and every `history` element a `{ role, parts }` message, and `generate` checks `messages` the same way, before anything reads them. A `null`, an `{}` or an unknown `kind` is `bad_request` naming the path (`history[1].parts[0].kind`) instead of a raw `TypeError` classified `unknown`. A call site declares no tools, so `tool-call` and `tool-result` parts in `attachments` or `history` are `bad_request`; a tool loop belongs to `generate`.
  - The library still never validates `output`: hosts validate and retry.
  - `canonicalJson` serialises `-0` as `0` (as RFC 8785 and `JSON.stringify` do, so a value hashes the same before and after a JSON round trip), accepts plain objects from another realm, and rejects input nested deeper than 1000 levels or with a symbol key with `bad_request` instead of a `RangeError` or a silently ignored key.

  What hosts must change:

  - A call site with no `userTemplate` (or one that renders to the empty string) passes `attachments`, or the call fails with `bad_request`; give such a call site a template, or pass the content as an attachment.
  - Do not pass tool-call or tool-result parts to `runStructured`; use `generate` for a tool loop. Fix any code that relied on a malformed part or message reaching the provider.
  - Hosts that fell back to `generate()` to set `externalId`, attach a file or send text or media history can use `runStructured` again.

- fb79350: xAI calls stream internally, a started run ends under one policy, and transport and timeout handling are precise (ADR-032, ADR-040).

  **Streaming.** `run()` sends `stream: true`, reads the server-sent events to the final one and returns the same result as before; public `stream()` is still on the ROADMAP. Live probes (17 to 28 minute reasoning runs on grok-4.5, 4.6 and 4.7, Node's default `fetch`) completed with a longest gap of 15 s between events, so Node's 300 s timer no longer kills a long reasoning call. The client reads the response body itself (the `openai` SDK still sends the request and classifies HTTP errors). The final response object can omit output items the stream carried, so the adapter rebuilds the item list from the events and reconciles it with the final object: the final object wins where both carry a field, each correction is a `warnings` entry, and a disagreement never fails the call (the only malformed shapes that fail a call are a final event without a response object and a body that is not JSON). A bare `event: keepalive` frame and `data: [DONE]` are skipped; items the final object omits are matched from the end of an id group and never duplicated; `response.incomplete` is incomplete whatever its response object says; an absurd stream index (above 10,000) is a typed `server` error instead of a stall; the SSE reader is linear in the bytes read. `XaiResponseMeta` (new, passed to `onResponse` once the response is complete) carries the response headers, `streamNotes` and `streamProgressed`. `XaiClientLike` is unchanged: a fake still resolves to one response object.

  **One policy for a run that started.**

  - Output began and then the stream was cut, ended early, was malformed, hit a mid-stream `error` event or a terminal `response.failed`: `retryable: false` (a reasoning call burns tokens before its first visible event and a retry repeats that spend), `kind: 'server'` or the code's kind; Node's own timers keep `kind: 'timeout'`. A failure before any output event keeps its code's retryability and has no usage, so the attempt counts as unpriced. A mid-stream `rate_limit_exceeded` is never retried.
  - Such a failure carries `error.usage` estimated from what was received (input is the whole wire input over 4, including the replayed `'state'` history, instructions, tools and output schema, image data counting nothing; output is the received characters over 4), marked `usage.details.usage_estimated = 1`, priced `'estimated'`, never exact, and understating (hidden reasoning tokens and tool fees are not counted). A failure after the final event carries that event's exact usage; usage in a `response.created` snapshot is never used. An engine `timeoutMs` deadline or a caller abort that stops a call after output began keeps the estimate; in core, after a timeout or abort wins the race over a dispatched adapter call, the engine waits up to 64 microtask turns (no timer) for the adapter's own failure and adopts its `usage` and `servedServiceTier` onto the cancellation error, which stays the error.
  - Mid-stream `error` events and failed responses set `mayHaveBilled`, so `rate_limited` and `bad_request` events count in `callCost.unpricedAttempts`; a `response.failed` is always an unpriced attempt when it carries no usage.
  - A typed `error` event with a nested `error` object keeps its code and message; a 200 that is not an event stream carries up to 500 characters of the body, secrets redacted, in the error `cause` (a deadline or abort that ends the read of that body is the timeout or aborted error, not `bad_request`); a terminal response without token counts is a typed non-retryable `server` error and any other failure to map a complete response carries the response's exact usage.

  **Timeouts and transport.**

  - `xaiAdapter({ transport: { fetch, fetchOptions, idleTimeoutMs? } })` (and `xaiProvider`) passes the host's `fetch` and `fetchOptions` to the SDK client and to `countTokens`. The adapter validates `transport` when it is created and keeps a private copy: a non-object transport, a `fetch` that is not a function, or `fetchOptions` that is `null`, an array or a primitive is `bad_request`, and `fetchOptions` cannot carry `headers`, `signal`, `body` or `method`; `transport` cannot be combined with an injected `client`. `transport.fetch` must return the request's `text/event-stream` response: a `fetch` that buffers it into a JSON body is a non-retryable `bad_request` (stub `transport.fetch` with an event-stream body to test a streaming failure; `makeFakeXai` replaces `responses.create` and does not exercise the stream). `transport.idleTimeoutMs` (integer from 1, off by default) ends a stream that sends no bytes, heartbeat comments included, for that long as a non-retryable `kind: 'timeout'`, `reason: 'transport_timeout'`.
  - Every call carries an SDK `timeout`: `config.timeoutMs + 5000` when set, else `XAI_DEFAULT_TIMEOUT_MS` (one hour). The request deadline is the SDK `timeout` for the header wait and the client's own timer for the rest of the stream; a stream past it is `kind: 'timeout'`, `retryable: false`, `reason: 'transport_timeout'` and its message quotes the configured timeout (that is the adapter's deadline: with a `timeoutMs` the engine's own timer fires 5 s earlier and ends the call as a retryable `timeout` with no `reason`, which `retryMiddleware` does not retry because the budget is spent). An undici header or body timeout and the SDK's own deadline are non-retryable `transport_timeout` (a connect timeout, an OS `ETIMEDOUT` and a TLS handshake timeout stay retryable: the SDK wraps all of them as `APIConnectionTimeoutError`, so the adapter recognises its own deadline only when the error has no cause, or just the SDK's own `AbortError`, and the call ran as long as the `timeout` it set). The grok config schemas reject `timeoutMs` above 2147478647. Exported: `XAI_DEFAULT_TIMEOUT_MS`, `XAI_TIMEOUT_BUFFER_MS`, `XaiTransport`, `XaiRequestOptions`, `XaiResponseMeta`, `XaiSdkDeadline`. `XaiClientLike.responses.create` options are `{ signal?, timeout?, onResponse? }` and `buildXaiClient(auth, transport?)` takes the transport. `classifyXaiError(error, deadline?, estimatedInputTokens?, requestTimeoutMs?)` takes the extra context; without `deadline` an SDK deadline is never reported.
  - `countTokens` is bounded by `countTokensTimeoutMs` (adapter option, default 60,000 ms, `XAI_COUNT_TOKENS_TIMEOUT_MS`) and every `XaiFileStore` call by `timeoutMs` (store option, default 60,000 ms, `XAI_FILES_DEFAULT_TIMEOUT_MS`; headers and body count), both integers from 1 to the same maximum as `timeoutMs`; past it the call is a retryable `timeout`. A failed `countTokens` or Files call keeps its response headers (a 429's `Retry-After` reaches `retryAfterMs`, `x-request-id` is in the message). `XaiFileStore.get`, `delete` and `getContent` encode the file id as one URL path segment and reject `.` and `..`; a 2xx body that is not JSON is a typed `server` error. The inline-image size check no longer counts the line breaks of a wrapped base64 image against the 20 MiB ceiling.

  What hosts must change:

  - A host with reasoning-only xAI calls can drop its undici `transport`. A host with tool-using calls expected to run past 300 s without any streamed event should keep it (that case was not tested: the longest streamed tool run was 99 s); the `transport` option stays for proxies, mTLS and custom `fetch`. Do not raise undici's `bodyTimeout` and `headersTimeout` to the whole request deadline: keep `bodyTimeout` near the longest quiet gap you measured and set `transport.idleTimeoutMs` to bound a half-open connection.
  - A `transport.fetch` wrapper that returns a buffered JSON body returns the event stream instead; do not mutate a `transport` object after creating the adapter (create a new one).
  - If your retry policy relied on an xAI transport timeout (an idle, header or body timer, or the deadline of a call with no `timeoutMs`) being retryable, it no longer is: decide in the host whether to resubmit. The engine's own `timeoutMs` deadline is still a retryable `timeout`, and `retryMiddleware` still does not retry it. Resubmit a call that failed after output began only knowingly (it was not retried because it may have billed; read `error.usage` for a lower bound of its cost). Read `err.usage` and `callCost` for an aborted call instead of assuming none.
  - If you supply your own `XaiClientLike`, its `create` receives `timeout` (and may call `onResponse`); keep `timeoutMs` at or below 2147478647.

## 0.15.0

### Minor Changes

- 64942d1: `computeCost` looks up concrete rates for `(model, tier)` and no longer applies a tier multiplier. `ModelDescriptor.capabilities` gains `structuredOutputWithTools`.

  The public `ReasoningEffort` union gains `max` for CLI models whose strict schemas admit it.

  `LlmRequest` and `LlmResult` gain `transientProviderState` for opaque provider continuation payloads. The engine forwards this state to and from adapters without writing it to call records or generation config; callers own secure storage when a later turn needs it. Model descriptors gain `statelessReasoningReplay` to declare which models require exact wire replay.

  `LlmError` can carry provider-reported usage from a billed response that failed after HTTP success. The engine records and prices that failed attempt, including when retry middleware makes another attempt.

  Pricing-source migration: supply a lookup `(model, tier) => ModelRates | undefined` that returns the concrete rates for that tier; `tier === undefined` must resolve to standard. Remove the old `tierFactors` argument from `computeCost` calls. Unknown defined tiers must return `undefined` from the lookup.

## 0.14.1

### Patch Changes

- cb4980f: Raise runtime dependency floors: `zod` `^4.6.5` (was `^4.4.3`) in core, google, xai,
  claude-cli and codex-cli, and `@google/genai` `^2.23.0` (was `^2.19.0`) in any-llm. No API
  changes.

## 0.14.0

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

## 0.13.1

### Patch Changes

- 6a5a662: Fix Codex WS-C follow-ups: file-ref attachment pricing is estimated until the counter is live-pinned; Google toolCallId uses provider `functionCall.id` (or a unique per-name suffix) and replays it; requested tool names/count persist alongside generationConfig.

## 0.13.0

### Minor Changes

- 0521973: Breaking (pre-1.0): required `TokenCount.accuracy`, required `Cost.details.tools`, first-class `citations` on generate results and call records, and xAI Live Search tools.

  - `TokenCount.accuracy` is `'exact' | 'lower-bound'` (Google exact; xAI tokenize-text lower-bound). Non-text parts on xAI `countTokens` are `bad_request`.
  - `Cost.details` is `{ input, cached, output, tools }` with invariant `microUsd = input + cached + output + tools`. Google/CLI token pricing sets `tools: 0`.
  - `LlmResult` / `AdapterResult` / `LlmCallRecord` / drizzle persist `citations?: { url, title?, sourceName? }`. Empty arrays are omitted. Public `normalizeGroundingCitations` is deleted.
  - grok-4.5 admits `reasoning.effort` `low|medium|high` (live 2026-08-24). `providerOptions.xai.tools` admits `web_search` / `x_search`. xAI prices `web_search_calls` / `x_search_calls` / `document_search_calls` from live usage details.

- 0521973: Breaking (pre-1.0): function-calling seam (ADR-029). `FinishReason` includes `tool_calls`; `tool-call` / `tool-result` parts; `LlmRequest.tools` / `toolChoice`; `toolCalls` on results and records.

  No agent loop. `runStructured` + tools is `bad_request`. Google and grok-4.5/4.6 implement and gate on `functionCalling`. CLI adapters reject `tools` and the new part kinds. Google `countTokens` stays `exact` with tools; xAI `countTokens` rejects tools. xAI store:false replay is live-verified.

## 0.12.1

### Patch Changes

- 90a47a1: Classify xAI safety-check HTTP 403 (`Content violates usage guidelines` / `SAFETY_CHECK_TYPE_*`) as `content_filter` instead of `invalid_auth`. HTTP status is a hint; adapters overlay from the structured body only. A bare 403 stays `invalid_auth`. Core JSDoc and the packaged skill document the default-vs-overlay rule.

## 0.12.0

### Minor Changes

- 2ab1ea6: Add `grok-4.6` with live-verified reasoning (`low`/`medium`/`high`/`xhigh`) and `serviceTier: 'priority'`. Widen core `ReasoningEffort` with `'xhigh'`. Refresh xAI pricing (`xai-2026-08-12`: 4.5 cached $0.30/$0.60; 4.6 $2/$0.50/$6 and $4/$1/$12) and re-verify Gemini snapshot (`gemini-2026-08-12`; registered-model rates unchanged). xAI `price()` now receives the served tier (`'default'` | `'priority'`) instead of `undefined`; custom xAI pricing sources must price `'default'` at the standard list.

## 0.11.0

### Minor Changes

- d46fd27: Add xAI Files store (`XaiFileStore`) and core `FileRefPart` for provider-hosted file ids.

  - `@gullabs/core`: new `FileRefPart` (`kind: 'file-ref'`) + `isFileRefPart` guard on the `Part` union.
  - `@gullabs/xai`: `XaiFileStore` (upload with TTL, get, list, idempotent delete, content); adapter maps `file-ref` → Responses `input_file.file_id`; rejects Gemini Files URIs.
  - `@gullabs/google`: reject `file-ref` with clear `bad_request` (Gemini uses `FileUriPart` URIs).

## 0.10.0

### Minor Changes

- a3f74be: Add per-key attribution (ADR-026): `ApiKeyAuth` gains an optional `keyId?: string` — an opaque, caller-supplied label (e.g. `'gemini-paid'`, `'grok-team-A'`) for the API key actually used, never the secret itself. The engine resolves `keyId` from the auth material used for the dispatch attempt that produced the recorded outcome — after any retries, fallbacks, or profile translation — so attribution stays correct even when the engine switches auth material between attempts.

  Key attribution belongs in any-llm rather than client code: the engine is the only component that authoritatively knows which auth material was used at dispatch time. Threading that identity through client-side call sites separately is the pattern that produced a real production bug (calls under one provider billed to the wrong client-side key label because the client's own attribution tracking drifted from what the engine actually dispatched with).

  `keyId`, when provided, is validated per the library's reject-don't-map convention: must be a non-empty string, and must not equal `apiKey` (rejecting the case where a caller passes the secret itself as the label) — both raise a `bad_request` `LlmError`. The resolved `keyId` is carried through `buildRecord` into a new `authKeyId` field on `LlmCallRecord`, persisted to a nullable `auth_key_id` column on `llm_calls` (`@gullabs/drizzle`), and is exempt from the record's secret-redaction pass since it's a label by design. `CliSessionAuth` is unaffected — CLI-session providers have no key identity, so `keyId` is out of scope there.

## 0.9.0

### Minor Changes

- 20453fc: Input contracts: strict template interpolation, opt-in `inputSchema`/`inputContract`
  validation, and pre-attempt ledger rows for refused calls (ADR-025).

  **Breaking changes:**

  - Strict template interpolation is now the unconditional default. Every `{{var}}`
    placeholder referenced by `callSite.system`/`callSite.userTemplate` must have a
    string-typed value present in `vars`, or `runStructured` refuses the call with
    `LlmError('bad_request')` before any request is built — templates that previously
    dispatched with literal `{{placeholder}}` text left in place now fail locally instead.
    There is no opt-out and no preserved fallback.
  - Pre-attempt refusals now write zero-usage `attemptNumber: 0` ledger rows. Any
    `LlmError` thrown inside `runPipeline` after `callId` allocation but before the first
    attempt runs — including `@gullabs/quota` denials, with no `@gullabs/quota` code
    changes — produces a synthetic `LlmCallRecord` (`attemptId` derived by the existing
    first-attempt idempotency rule: `request.idempotencyKey` when supplied, minted
    otherwise). Refusals that previously left no ledger row now appear as one.

  **New features:**

  - `CallSite.inputSchema?: StandardSchemaV1` — validates `vars` before interpolation,
    so a missing business field surfaces as the schema's own error.
  - `LlmRequest.inputContract?: { schema: StandardSchemaV1; value: unknown }` — the
    equivalent opt-in contract for the `generate()` path; validated once per logical
    call, before `@gullabs/quota` and before the retry middleware.
  - `createClient({ requireInputContract: true })` — fleet-wide toggle requiring every
    call to carry a contract (`inputSchema` on `runStructured`, `inputContract` on
    `generate()`).
  - `LlmErrorOptions.issues` / `LlmError.issues` — structured `{ path, message }[]`
    validation failures, populated by both input-contract paths and by model-config
    validation.

  See ADR-025 in `DECISIONS.md` for the full design and the row-less/ledgered boundary
  table.

## 0.8.0

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

## 0.7.0

### Minor Changes

- ba21620: Provider-qualified model identity — explicit `(provider, model)` everywhere (breaking, pre-1.0).

  - `LlmRequest`, `CallSite`, and `ResolvedRequest` now require a top-level `provider: string`; `model` stays the bare provider-native string forwarded verbatim to SDKs/CLIs. Bare requests without a provider, unregistered `(provider, model)` pairs, and slash-style `'provider/model'` strings are rejected with `bad_request`.
  - `ModelRegistry` is keyed by `(provider, model)`: `resolve(provider, model)`, `ModelDescriptor.id` renamed to `model`, duplicate exact pairs throw, the same bare model may exist under multiple providers with different config schemas, and prefix matching never crosses providers.
  - Routing is always by `req.provider`: the single-adapter bypass is removed, custom `route(provider, model, adapters)` results are checked against `adapter.id === req.provider`, and `createClient` verifies every registry descriptor's provider has a matching adapter.
  - Pricing composes per provider: `ClientConfig.pricing` is replaced by `pricingSources: Record<provider, PricingSource>`; the port shape is unchanged and `geminiPricingSource()` is the google-scoped source. A provider without a source yields an unpriced result with a warning.
  - Telemetry events carry `provider`; quota's `providerQuotaMiddleware` reads `req.provider` from the request (the `provider` option is removed).

## 0.6.0

### Minor Changes

- e3da339: Extend `AuthMaterial` from `{ apiKey: string }` to a union of `ApiKeyAuth` (`{ apiKey: string }`) and the new `CliSessionAuth` (`{ cliSession: true }`), an explicit opt-in credential shape for the dev-only CLI provider packages (`@gullabs/claude-cli`, `@gullabs/codex-cli`). `requireAuth()` now accepts either variant. This is a shape-only extension — existing `{ apiKey }` call sites keep compiling unchanged.

  `@gullabs/google` narrows to `ApiKeyAuth` via a new `requireApiKey(auth)` helper and throws `invalid_auth` when `apiKey` is missing; the Google adapter, cache store, and file store never accept `CliSessionAuth`.

## 0.5.0

### Minor Changes

- b39ceac: Document the breaking strict model-config contract ahead of release.

  Built-in descriptors are moving to a descriptor-owned schema boundary:
  `descriptor.configSchema` is the runtime source of truth, `descriptor.configJsonSchema`
  is derived from it for forms, and callers should stop depending on exported
  repair helpers or broad JSON-schema-only config flows.

  The docs now call out the related behavior changes that must be handled at the
  same boundary:

  - omit `serviceTier` to use provider-default request behavior, and set `flex`
    explicitly when Flex is required;
  - use `reasoning.effort` for Gemini 3 and Gemma level-based models instead of
    `reasoning.budgetTokens`;
  - remove `effort: 'none'` on models that cannot disable thinking, such as
    `gemini-3.1-pro-preview`;
  - stop using `providerOptions.google` as an override lane for descriptor-owned
    fields;
  - continue treating `priority` as rejected until the library ships verified
    pricing, served-tier recording, and tests for it.

## 0.4.3

### Patch Changes

- 78b7636: Fix bugs found in a second round of independent Codex adversarial review, run
  against the commits from the previous two releases:

  - `@gullabs/core`: `resolveReasoning()` now rejects negative, non-integer, `NaN`,
    and `Infinity` `budgetTokens` with a deterministic `bad_request` `LlmError`
    instead of silently mapping them to a valid reasoning effort. The Gemini
    config JSON Schema's `reasoning.budgetTokens` property now also declares
    `minimum: 0` for defense-in-depth consistency with the same check.
  - `@gullabs/google`: `normalizeGroundingCitations()` now only produces
    citations for `http:`/`https:` URLs with a non-empty hostname, skipping
    malformed/unsafe schemes (e.g. `javascript:`, `mailto:`) instead of
    including them in the returned citation list.
  - `@gullabs/any-llm`: fixed the shipped skill's `Cost.microUsd` nullability
    comment (it's `number | null`, not `number | undefined`).

## 0.4.2

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

## 0.4.1

### Patch Changes

- dab0792: Fix bugs found in an independent adversarial audit of the adoption-backlog implementation:

  - `@gullabs/core`: `resolveReasoning()` no longer throws for positive sub-tier `budgetTokens` values on level-api models (only an explicit `0` budget is rejected as "none"); the engine no longer double-counts rate-limiter queue wait as provider-dispatch `latencyMs` when a call fails before dispatch ever starts (`latencyMs` is now `0` in that case, matching the documented `queueDelayMs`/`latencyMs` split).
  - `@gullabs/google`: add `normalizeGroundingCitations()` and the `Citation` type, a fail-open post-processing helper for deduplicating and normalizing Gemini grounding-chunk citations.
  - `@gullabs/quota`: reject non-integer/negative `rpm`/`rpd` quota-rule config with a deterministic `LlmError` (`kind: "bad_request"`, `retryable: false`) instead of a plain `Error` or silently disabling enforcement.

## 0.4.0

### Minor Changes

- Implement the adoption backlog: add core reasoning resolution exports, pricing-source introspection
  and construction-time strict pricing, unpriced-cost warnings, queue-delay attribution on results and
  records, Drizzle `queue_delay_ms`, hardened quota deny/defer decisions, service-tier re-validation
  after Google provider-options merge, and deterministic testing support for rate-limiter wait time.

  Docs now cover ledger sidecar transaction composition, `metadata.operationId` correlation for
  grounded-to-structured workflows, multi-runtime retry caveats, and caller-owned structured-output
  validation.

## 0.3.0

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

## 0.2.0

### Minor Changes

- 8f1bf61: Simplify auth and harden production readiness.

  Streamline provider authentication so callers no longer need to manage credential objects directly — ADC and explicit key paths both work without boilerplate. Add structured error types, retry-on-transient-failure logic, and cost-accounting helpers to the core pipeline. The Google adapter gains first-class Gemini 1.5 / 2.0 model support with token-level cost computation.
