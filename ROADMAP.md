# Roadmap

Items here are designed seams. The ports or type-system placeholders exist; the machinery is deferred.

This is no longer a Gemini-only tree. `@gullabs/google` and `@gullabs/xai` are first-class provider plugins composed via `composeProviders`. Dev-only CLI providers (`@gullabs/claude-cli`, `@gullabs/codex-cli`) exist for local iteration. What remains deferred is listed below.

---

## Future / Deferred

### Deep lint-policy audit

The repo starts with a deliberately minimal ESLint stack: core ESLint, `@eslint/js`, `typescript-eslint`, and `globals`, scoped tightly to real library source with lighter handling for tests/examples/config.

Defer a deeper lint audit until this baseline is stable in day-to-day use. That later pass should re-evaluate:

- whether any additional correctness rules are worth the noise,
- whether docs/examples need their own stricter gate,
- whether the repo should stay on ESLint or switch part of the surface to another tool,
- and whether any plugin additions are justified by real recurring defects rather than fashion.

### Vertex AI support

Removed because it depended on Google Application Default Credentials (ADC): ambient discovery from `GOOGLE_APPLICATION_CREDENTIALS`, well-known credential files, or the GCE metadata service. That contradicts the library's no-ambient-reads guarantee (see ADR-019 in DECISIONS.md).

Will return with an explicit credential shape — a plain object containing the fields needed to authenticate (service account key material or a short-lived access token), with no ambient discovery. ADC is not in scope.

### Streaming

A `stream()` method that returns an async iterable of normalized `StreamEvent` objects plus a `final: Promise<LlmResult>`. The `ProviderAdapter` interface is designed to accommodate a `runStream` method. Records are written on every terminal stream outcome including abort.

### Agent loop / tool execution

The function-calling **seam** shipped in ADR-029 (tools in, tool-call/tool-result parts out). An in-library agent loop, tool executor, or retry-on-tool-error policy is still out of scope.

### Multimodal output

Model-generated images, audio, and structured files as output parts. The `Part` union is extensible; no output-part variants are defined yet.

### Additional providers

The `ProviderAdapter` port and routing infrastructure are ready. `AuthMaterial` is currently `{ apiKey: string, keyId?: string }` only. Extending to OAuth tokens, bearer tokens, or provider-specific shapes is additive and non-breaking for the port itself, though each new `AuthMaterial` variant is a union extension that may require host-code updates.

Refreshable credentials (OAuth/STS short-lived tokens): resolve at the engine entrypoint via a resolver function; primary design work is the long-lived cache/file stores that currently memoize a client from a single auth snapshot (see ADR-020 in DECISIONS.md).

### `Redactor` port

A port for scrubbing sensitive content from messages and results before persistence. Currently only `redactSecrets` (regex-based, applied to `errorMessage` and select `generationConfig` fields) exists. A proper `Redactor` port would allow host-supplied DLP logic and would be fail-closed to prevent accidental persistence of unredacted content.

See ADR-021 in DECISIONS.md for the reasoning behind deferring this to a host/consumer concern.

### Deferred observability

The following observability features are explicitly deferred by design — they are consumer concerns or future companion packages, not library responsibilities.

- **First-party OpenTelemetry package** — the `Telemetry` port is the designed seam; ship an integration example or a thin `@gullabs/otel` wrapper, not an OTel SDK dependency in core.
- **W3C `traceparent` propagation into provider calls** — needs per-call header injection, which no adapter exposes. Google's `providerOptions.google.httpOptions` admits only `timeout`, and xAI's `transport.fetch` is per client, so a host that must propagate `traceparent` today wraps `fetch` there and reads its own request context. A per-call `headers` option is the missing piece.
- **In-library metrics runtime / `/metrics` endpoint / cache-hit & rate-limiter gauges** — consumers derive metrics from `LlmCallRecord` rows and `Telemetry` events; the library should not own a Prometheus registry or HTTP server.
- **Error sampling / dedup** — call-level `errorKind` is in every record; sampling policy belongs in the host's error-reporting integration (e.g. Sentry's `sampleRate`).
- **Persisted stack traces** — stack frames carry no operational value in production error records and inflate storage; `errorKind` + `errorMessage` are sufficient for postmortems.
- **Typed provider-error schema** — a first-class `providerError` field on `LlmCallRecord` with structured provider-specific fields (HTTP status, provider error code, etc.) is useful but requires per-adapter schema work.
- **TTFB / streaming latency** — time-to-first-byte and per-token streaming latency require a streaming pipeline (`stream()`) which is not yet implemented.
- **Sink-side logical-call latency** — per-attempt `latencyMs` is already captured on every `LlmCallRecord`, correlated by a stable `callId` and ordered by `attemptNumber`, so hosts can already aggregate per-attempt records into a logical-call latency at the sink/query layer today (e.g. group rows by `callId`). What's deferred is a built-in helper/API in the library for this aggregation — today it's a query the host writes itself.
- **Configurable custom-redaction-pattern API** — a `Redactor` port (see existing roadmap item) would allow host-supplied DLP patterns; today only the built-in regex patterns in `redactSecrets` are applied.

### `ResultCache` port

An optional cache keyed on a deterministic hash of the request, enabling idempotent re-runs without hitting the provider.
