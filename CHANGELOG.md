# Changelog

All notable changes to this project are documented per-package. This file is a short
pointer plus a condensed, human-readable project history — not the authoritative
changelog.

## Where to find changes

The nine packages are one [changesets](https://github.com/changesets/changesets) `fixed`
group: they always release at the same version, and mixed versions are unsupported
([RELEASING.md](RELEASING.md)). Merging a changeset to `main` makes the Release workflow
open a "Version Packages" pull request; merging that pull request publishes. For the
authoritative, current, per-version change history of a package, see its own changelog:

- [packages/any-llm/CHANGELOG.md](packages/any-llm/CHANGELOG.md)
- [packages/core/CHANGELOG.md](packages/core/CHANGELOG.md)
- [packages/google/CHANGELOG.md](packages/google/CHANGELOG.md)
- [packages/xai/CHANGELOG.md](packages/xai/CHANGELOG.md)
- [packages/drizzle/CHANGELOG.md](packages/drizzle/CHANGELOG.md)
- [packages/quota/CHANGELOG.md](packages/quota/CHANGELOG.md)
- [packages/testing/CHANGELOG.md](packages/testing/CHANGELOG.md)
- [packages/claude-cli/CHANGELOG.md](packages/claude-cli/CHANGELOG.md)
- [packages/codex-cli/CHANGELOG.md](packages/codex-cli/CHANGELOG.md)

All packages follow [semantic versioning](https://semver.org/). They are currently
pre-1.0 (`0.x`), so per semver's pre-1.0 convention, breaking changes may land in minor
version bumps rather than being reserved for a major release — always check the
per-package changelog above before upgrading.

---

## Highlights

A condensed, narrative history of the project for newcomers. For exact per-version
details, use the per-package changelogs linked above.

### Initial v1 scope

The first implementation shipped a deliberately narrow scope (see `SPEC.md`): a
`createClient` engine with a config-resolution → adapter → normalize → validate → cost →
record pipeline, `defineCallSite` for typed reusable prompt templates, a Gemini
`ProviderAdapter` over `@google/genai`, cost computation with a Gemini pricing snapshot,
structured `LlmError` classification, a Drizzle `UsageSink` reference schema, and a
`@gullabs/testing` package of fakes (clock, id generator, recording sink, scriptable
Gemini client) for testing consumers without hitting real provider APIs.

### Multimodal content and per-model config validation

`Message.parts` became a `Part` union (`TextPart | InlineMediaPart | FileUriPart`),
adding support for inline base64 media and provider-hosted file references. The
`@gullabs/google` package gained a `GoogleFileStore` (upload/poll/delete) and a
`GoogleCacheStore` for explicit context caching, plus grounding-metadata capture and a
guard that rejects combining Google Search grounding with structured output.
`ModelDescriptor` grew capability metadata (`sampling`, `caching`, `grounding`) and a
per-model JSON Schema config validator that the engine now runs before dispatch, so
invalid config is rejected at the door instead of silently passed through.

### Per-call auth migration, timeout hardening, and Flex-tier fixes

**Breaking:** the pluggable `AuthProvider` port and `envAuth()` helper were removed —
the library no longer reads credentials from `process.env` or any ambient source.
Every `generate()` / `runStructured()` call must now pass `{ auth: { apiKey } }`
explicitly. Vertex AI auth was dropped in the same change (see `ROADMAP.md` for its
planned return with explicit, non-ADC credentials).

Alongside the auth migration: a `redactSecrets` utility now scrubs API keys and tokens
from error messages before they're persisted to the audit sink (the error thrown to the
caller is left unredacted); `retryMiddleware`'s `timeoutMs` became a true overall
wall-clock ceiling across all retry attempts rather than a per-attempt budget; a Gemini
3.x cache `minTokens` value was corrected from 4096 to Google's actual 2048 floor; and
the Flex service-tier path picked up client-side timeout enforcement to compensate for
a known `@google/genai` SDK bug affecting Flex-tier timeouts.

### Forward-only structured output and the quota package

**Breaking:** structured output moved to a forward-only model. `LlmRequest.output` now
takes a plain `{ jsonSchema: JsonValue }` instead of a Zod schema; the engine forwards
the schema to the provider as a generation hint, JSON-parses the response, and returns
`LlmResult.output: unknown` plus `outputParsed: boolean`. The library no longer performs
output validation itself — callers own validation, retry, and acceptance policy.
`InferOutput`, generic output typing, `output.schema`, `parse_error`, and
`zodToGeminiSchema` were removed as a result. Custom `PricingSource` implementations must
now also provide `hasModel()` and `listModels()`, so strict pricing checks use the same
exact/prefix model-resolution rules as runtime pricing — hosts using their own
`PricingSource` instead of the built-in `geminiPricingSource()` need to add these.

The same release added `idempotencyKey` (later removed again: ledger rows are per
attempt, and `externalId` is the correlation key, ADR-031) and `externalId` to
`LlmRequest` for ledger correlation, made `attempt_id` the Drizzle primary key (dropping the redundant UUID
`id` column), and made Gemini Flex calls fall back to standard tier automatically under
capacity pressure — with the tier actually served reported back as `servedServiceTier`
so cost accounting and retries stay consistent.

A new companion package, `@gullabs/quota`, was introduced for provider-level quota
control (RPM/RPD enforcement) outside of core, with a `QuotaDecision` model that
distinguishes temporary `defer` outcomes from permanent `deny` outcomes.

### Provider plugins, xAI Grok, and grok-4.6

The engine stopped knowing about Gemini. Each provider is a self-contained plugin
(`composeProviders`) that owns its adapter, model descriptors, strict config schemas,
and pricing snapshot. `@gullabs/xai` shipped over the `openai` SDK Responses API with
canonical IDs only (`grok-4.5`, then `grok-4.6`). 4.6 admits `reasoning.effort` of
`low|medium|high|xhigh` and `serviceTier: 'priority'`; served tier is echoed verbatim
and cost uses the snapshot `priorityFactor`. Gemini and xAI pricing snapshots were
re-frozen from live official sources (`gemini-2026-08-12`, `xai-2026-08-12`).

Dev-only CLI providers (`@gullabs/claude-cli`, `@gullabs/codex-cli`) exist for local
iteration and are not production adapters.
