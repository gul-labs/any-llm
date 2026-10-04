# @gullabs/xai

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

- fb79350: xAI responses, billing and config: failed responses and credit exhaustion are classified, an incomplete call is not a tool call, a refusal is a result, and request, search-budget and sampling options are checked.

  - **Credit exhaustion.** HTTP 429 or 403 with the body `Your team <id> has either used all available credits or reached its monthly spending limit...` is `rate_limited`, `retryable: false`, `reason: 'credits_exhausted'` (it was a retryable 429 or an `invalid_auth` 403); the team id stays on `cause`, not in the message. This body is doc-derived, not captured: xAI documents the status codes but no body.
  - **A 200 that reports failure** throws an error with the response's usage attached, classified by `error.code`: `server_error` is a retryable `server` error, `rate_limit_exceeded` a retryable `rate_limited`, `bio_policy`, `misalignment_policy_violation` and `image_content_policy_violation` are `content_filter`, `invalid_prompt` and the `invalid_image*` family are `bad_request`, any other or missing code is `unknown` and `status: 'cancelled'` is `unknown`; only the first two are retried. An `error` object beside a completed response is ignored. These shapes come from OpenAI's Responses object and were never captured.
  - **An incomplete call is not a tool call.** A `function_call` of a response that is not `completed` (cut by `max_output_tokens`, or any abnormal end), or whose own `status` is not `completed`, is dropped from `toolCalls`, from `message` and from the replayed `transientProviderState`; `finishReason` keeps the response's own reason (`length` or `other`, no longer rewritten to `tool_calls`) and a warning names the call. A completed call whose `arguments` are not JSON throws a non-retryable `server` error carrying the billed usage. A content part without `text` no longer fails a billed call with a `TypeError`; a `refusal` part gives a result with no text, `finishReason: 'content_filter'` and a warning quoting it; other part types are ignored with a warning. `reasoningText` joins reasoning summary parts with a blank line.
  - **Metadata.** The built-in client reads the HTTP response through the SDK's `.withResponse()` and the adapter puts `x-request-id` and the `x-ratelimit-remaining-*` headers on `providerMetadata.xai` as `requestId` and `rateLimitRemaining` (verbatim values, lower-cased header names; pinned against real captures). A failed call has no `providerMetadata`; its request id is `error.cause.requestID`.
  - **`providerOptions.xai.parallelToolCalls`** with no function tools and no `providerOptions.xai.tools` is `bad_request`. `searchBudget: { maxWebSearchCalls?, maxXItems? }` (integers of at least 1, at least one, needs `tools`; `maxWebSearchCalls` needs `web_search`, `maxXItems` needs `x_search`) is validated by the config schema with the path, never sent to xAI (it has no per-call ceiling), and reported after the call: when `web_search_calls`, or `x_posts_fetched` plus `x_users_fetched`, exceeds it the result carries a warning and `usage.details.search_budget_exceeded = 1` (still returned and priced, since the call is billed; a counter xAI did not report is never counted as exceeded). It is a report, not a ceiling. `maxTurns` and `toolChoice` are unchanged.
  - **Sampling and names.** `temperature` must be 0 to 2 and `topP` 0 to 1 in the `grok-4.5`, `grok-4.6` and `grok-4.7` schemas, never clamped. The structured-output `name` is the schema `title`, held to `^[a-zA-Z0-9_-]{1,64}$` (a title such as "Weather Report" is `bad_request`; the adapter never rewrites it; a schema with no `title` is sent as `structured_output`).
  - **Cleanup.** `XaiAdapterOptions._clientFactory` and `_fetch` are deleted (the seams are an unexported `xaiAdapterWithSeams`, so no test seam is in a shipped type); the unused `file_url` on `XaiInputFilePart` is gone (`file_id` is required); the `{ type: 'text' }` variant of `XaiTextFormat` is gone; the README's "Explicitly deferred" list of features that were built is removed.

  What hosts must change:

  - Alert on `reason: 'credits_exhausted'` instead of rotating keys or retrying; handle `bad_request` and `content_filter` from a failed 200 as caller or policy errors, not transient ones.
  - A tool loop that ran tool calls on `finishReason: 'tool_calls'` needs nothing; one that handled a string `args` can delete that branch. Treat `length` with no tool call as "raise `maxOutputTokens` and retry the turn", and `content_filter` as a possible refusal (see the warning).
  - A custom `XaiClientLike` that should report response headers calls `options.onResponse`. Read `usage.details.search_budget_exceeded` (or the warning) to learn that a call spent more searches than expected.
  - Drop `_clientFactory` / `_fetch` (use `client`, `transport`); rename a structured-output schema `title` that contains anything outside letters, digits, `_` and `-`, or remove it; pass `temperature` within 0 to 2 and `topP` within 0 to 1; stop sending `parallelToolCalls` on requests without tools.

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

## 0.9.0

### Minor Changes

- 0c49eb4: xAI: `providerOptions.xai.toolChoice` forces or disables the server-side search tools (`tool_choice` was only sent alongside function tools).

  - `toolChoice: 'auto' | 'required' | 'none'` applies to `web_search` / `x_search` only. It needs a non-empty `providerOptions.xai.tools` and is rejected together with function tools, file attachments or the request-level `toolChoice`. Resend it on every request. Live on 2026-10-02: `required` ran 3 / 2 / 2 searches on grok-4.5 / 4.6 / 4.7 and `none` ran 0.
  - `maxTurns` (integer ≥ 1, needs search tools) forwards xAI's documented `max_turns`. It caps agentic turns, not searches, and xAI did not enforce it on 2026-10-02 (`max_turns: 1` still ran 10–17 searches). Budget searches in the prompt and assert on `usage.details.web_search_calls`.
  - A response where no server tool ran (`num_server_side_tools_used: 0` with no `server_side_tool_usage_details`) now prices exactly with no tool fee. Before, `none` calls and `auto` calls that skipped the search were recorded as unpriced.
  - Search tools plus `output.jsonSchema` is admitted on `grok-4.5` and `grok-4.7` as well as `grok-4.6` (live-verified). This reverses the 0.8.0 rejection on `grok-4.5`.
  - Tool pricing is unchanged: web search is $5 per 1,000 calls, reconciled against billed ticks on all three models.

  Breaking: an `output.jsonSchema` that uses the OpenAPI `nullable` keyword or uppercase type names (`STRING`, `OBJECT`) now fails locally with `bad_request` naming the path. xAI ignores `nullable`, so the model could not return `null` and wrote `""`, `0` or the string `"null"`. Write nullable fields as `type: ['string', 'null']`. The adapter never rewrites a schema.

  Migration for hosts on 0.6.x:

  - Node ≥ 22.12, `openai ^7` peer; `@google/genai ^2` peer if you upgrade `@gullabs/google` in the same move. Bump every `@gullabs/*` package together.
  - Model identity is provider-qualified since 0.7.0: every request and registry lookup takes an explicit `(provider, model)`, and pricing sources are registered per provider. A `PricingSource` is provider-scoped, so its own `price(model, usage, tier?)` still takes the bare model id.
  - `gemini-3-flash-preview` and `gemini-3.5-flash` were removed in `@gullabs/google` 0.13.0; move to `gemini-3.6-flash`.
  - Delete any local patch that added `toolChoice`; the option has the same name and values here.
  - Convert Gemini-dialect schemas at the call site before routing to xAI, then delete any lowering helper.

## 0.8.0

### Minor Changes

- 64942d1: Register `grok-4.7` and admit the live-verified `priority` tier on `grok-4.5` at 2×. Bill x_search from `x_posts_fetched` and `x_users_fetched`. If required tool counters are absent, leave the snapshot cost unpriced and retain xAI's billed `cost_in_usd_ticks` in raw usage for reconciliation. Long-context rates start at 200,000 input tokens.

  For stateless grok-4.7 conversations, pass the unchanged `result.transientProviderState` as `request.transientProviderState` with only new user or tool-result messages. The state preserves full response output order, including encrypted reasoning, messages, and server-tool items. It is excluded from ledger records. The adapter rejects assistant history alongside state, unknown tool-result ids, a mismatched model, and function-call history without state. Requests without state start fresh and can contain text-only assistant examples. File attachments carried in replay state keep tool cost estimated until attachment billing is live-pinned.

  Structured output with built-in search is descriptor-gated; the live fixture admits it on `grok-4.6`. Direct `grok-4.7` calls require a descriptor that retains the stateless replay capability.

  Breaking change for `grok-4.5`: a request combining `output.jsonSchema` with built-in `web_search` or `x_search` now fails locally. Move grounded structured extraction to `grok-4.6`, or perform search and structured extraction in separate calls. `grok-4.7` does not admit the combination without live evidence.

### Patch Changes

- Updated dependencies [64942d1]
  - @gullabs/core@0.15.0

## 0.7.1

### Patch Changes

- cb4980f: Raise runtime dependency floors: `zod` `^4.6.5` (was `^4.4.3`) in core, google, xai,
  claude-cli and codex-cli, and `@google/genai` `^2.23.0` (was `^2.19.0`) in any-llm. No API
  changes.
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

## 0.5.1

### Patch Changes

- 90a47a1: Classify xAI safety-check HTTP 403 (`Content violates usage guidelines` / `SAFETY_CHECK_TYPE_*`) as `content_filter` instead of `invalid_auth`. HTTP status is a hint; adapters overlay from the structured body only. A bare 403 stays `invalid_auth`. Core JSDoc and the packaged skill document the default-vs-overlay rule.
- Updated dependencies [90a47a1]
  - @gullabs/core@0.12.1

## 0.5.0

### Minor Changes

- 2ab1ea6: Add `grok-4.6` with live-verified reasoning (`low`/`medium`/`high`/`xhigh`) and `serviceTier: 'priority'`. Widen core `ReasoningEffort` with `'xhigh'`. Refresh xAI pricing (`xai-2026-08-12`: 4.5 cached $0.30/$0.60; 4.6 $2/$0.50/$6 and $4/$1/$12) and re-verify Gemini snapshot (`gemini-2026-08-12`; registered-model rates unchanged). xAI `price()` now receives the served tier (`'default'` | `'priority'`) instead of `undefined`; custom xAI pricing sources must price `'default'` at the standard list.

### Patch Changes

- Updated dependencies [2ab1ea6]
  - @gullabs/core@0.12.0

## 0.4.1

### Patch Changes

- 4458ce7: Dependency upgrades: test against `openai@7` and `@google/genai@2.16`; widen xAI peer to `openai ^6 || ^7`.

## 0.4.0

### Minor Changes

- 09010db: File-store fail-closed delete + xAI Files host ergonomics.

  - `XaiFileStore` / `GoogleFileStore`: `delete(id, { failClosed?: boolean, signal? })` — default fail-open; opt-in throw on non-not-found failures; empty id always `bad_request`; 404 success both modes.
  - `@gullabs/testing`: `FakeXaiFileStore` in-memory store with TTL clock and fail-closed delete.
  - Docs: multi-provider install (core + google + xai + peers); attachment_search counters visible on `usage.details` / `usage.raw`.

## 0.3.0

### Minor Changes

- d46fd27: Add xAI Files store (`XaiFileStore`) and core `FileRefPart` for provider-hosted file ids.

  - `@gullabs/core`: new `FileRefPart` (`kind: 'file-ref'`) + `isFileRefPart` guard on the `Part` union.
  - `@gullabs/xai`: `XaiFileStore` (upload with TTL, get, list, idempotent delete, content); adapter maps `file-ref` → Responses `input_file.file_id`; rejects Gemini Files URIs.
  - `@gullabs/google`: reject `file-ref` with clear `bad_request` (Gemini uses `FileUriPart` URIs).

### Patch Changes

- Updated dependencies [d46fd27]
  - @gullabs/core@0.11.0

## 0.2.5

### Patch Changes

- Updated dependencies [a3f74be]
  - @gullabs/core@0.10.0

## 0.2.4

### Patch Changes

- c89f6f3: Fix a live-observed correctness defect: transport-level connection failures (the `openai` SDK's `APIConnectionError` / `APIConnectionTimeoutError`, thrown as `"Connection error."` when the request never reaches xAI's servers, plus Node/undici errno signatures like `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EAI_AGAIN`, `EPIPE`, `socket hang up`, and `fetch failed`) previously fell through `classifyXaiError`'s generic HTTP-status classification to `kind: 'unknown', retryable: false`. Temporal treats `retryable: false` as fatal, so a transient network blip was killing host workflow runs outright instead of being retried (observed live 2026-07-10).

  These are now reclassified `kind: 'server', retryable: true` — the same "provider fault, not caller fault, safe to retry" bucket this adapter already uses elsewhere for provider-side failures with no HTTP status. Detection matches the OpenAI SDK's error class by constructor name (avoiding a runtime import of `openai` outside `client.ts`), falls back to message/errno pattern matching, and also inspects a wrapped `.cause`. All prior classifications (auth, rate-limit, bad-request, timeout, content-filter) are unchanged.

## 0.2.3

### Patch Changes

- 8896b06: Fix a live-observed correctness defect: when the xAI Responses API returns multiple `type: 'message'` output items in one response (observed live: strict `json_schema` mode, `grok-4.5`, reasoning effort `high`, two complete JSON documents in two separate message items), the adapter previously concatenated `output_text` across ALL message items, producing corrupted, invalid-JSON text (`...}\n}{\n"..."`). This broke a downstream consumer's parse gate and killed a Temporal host run.

  The adapter now takes only the LAST `type: 'message'` output item's `output_text` parts as the result text, matching the Responses API convention that the final message item is the response and earlier ones are superseded. Joining multiple `output_text` parts _within_ a single message item is unchanged (that is legitimate segmentation, not duplication), and `reasoningText` assembly from `type: 'reasoning'` items is unaffected. When more than one message item is present, a `warnings` entry now names the dropped item count.

## 0.2.2

### Patch Changes

- Updated dependencies [20453fc]
  - @gullabs/core@0.9.0

## 0.2.1

### Patch Changes

- af00325: Docs + fixture + test only — zero adapter behavior change. Codifies the 2026-07-09 live-verified finding that xAI's `strict: true` on `text.format` json_schema performs no OpenAI-style compile-time schema validation (missing `additionalProperties: false`, optional properties, `format`/other keywords, `anyOf`, `$defs`/`$ref`, and nullable unions were all accepted with HTTP 200 across 13 single-variant live probes plus 1 combined probe, 14 calls total). Adds a fixture (`10-non-strict-schema-accepted.json`) and a fixture-backed test proving this adapter forwards schemas to xAI verbatim, and documents in the README that OpenAI-strict schema rewriting is unnecessary for xai as of that verification date.

## 0.2.0

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
