# Security Policy

## Supported versions

Security fixes land on `main` and are published as patched npm releases of the affected `@gullabs/*` packages. Pre-1.0 packages do not receive long-lived backport branches. Upgrade to the latest version of the package you use.

## Reporting a vulnerability

**Do not open a public issue.**

Report privately through [GitHub Security Advisories](https://github.com/gul-labs/any-llm/security/advisories/new).

We aim to acknowledge within a few business days. Please include:

- Affected package and version
- A minimal reproduction or a clear description of the impact
- Whether you believe the issue is already being exploited

We will coordinate a fix and a public advisory before any disclosure.

## What this library guarantees

- The library never reads provider credentials from the environment, well-known files, or cloud metadata. Callers pass `auth` on every call.
- The library never logs or persists provider API keys as secrets. `keyId` is an opaque label and must not be the key.
- `redactSecrets()` best-effort scrubbing (linear time; credential patterns only) is applied to: the persisted `error_message`, `reasoning_text` and tool-call arguments of every `llm_calls` row (and, for arguments, the value of any key named like a secret), the `providerOptions` and `httpOptions.headers` of `generation_config`, and every string of a stored payload (ADR-038).
- The full prompt and response text is stored only when a host sets `ClientConfig.payloads`; that is off by default. `payloads`, `include` and `storePayload: false` govern the `llm_call_payloads` table only. The `llm_calls` row always carries the text the model or provider produced: reasoning text, tool-call arguments, error messages, plus citations and your `metadata`. The table in [`docs/ledger.md`](./docs/ledger.md#what-each-table-holds) lists every text-bearing column and what covers it; a host that must keep that text out of the ledger does not persist those columns (a wrapping sink).
- A payload is built from a snapshot of the request taken at dispatch, bounded per string before any pattern runs, and built inside the `sinkTimeoutMs` budget; a payload that cannot be built is dropped, never stored half redacted (ADR-038).
- The library never deletes stored payloads on its own. Retention and deletion are the host's duty, and `purgeLlmCallPayloads` / `deleteLlmCallPayloads` cover the payload table, not the `llm_calls` columns.

## What this library does not guarantee

- The free-form `metadata` bag on `CallMetadata` is **never** scanned or redacted. It is stored verbatim. Do not put secrets in it.
- `redactSecrets` is regex-based, not a DLP engine. Do not treat it as a compliance control.
- A `UsageSink` you install can persist anything you write to it. Review that sink before storing prompts.
- Stored payloads can contain customer data. `redactSecrets` removes common credential patterns (provider keys, bearer and Authorization credentials, signed-URL parameters, secret-named JSON keys), not personal data: supply your own `redact` for the payload, and a wrapping sink for the `llm_calls` text columns. A synchronous host `redact` cannot be interrupted.
- `llm_call_payloads` has no tenant column, so row-level security written against `llm_calls` does not cover it; read it through `llm_calls` and write policies as an `exists`. Drizzle's query logger and Postgres statement logging record bound parameters, which for a payload insert is the payload.
- Provider SDKs (`@google/genai`, `openai`, local CLIs) have their own trust boundaries. This library does not sandbox them.

## Supply chain

- Releases are published from GitHub Actions on `main` after CI is green. See [`RELEASING.md`](./RELEASING.md).
- Public releases attach [npm provenance](https://docs.npmjs.com/generating-provenance-statements).
- CI runs `gitleaks` and `pnpm audit --audit-level=high` on every pull request.
- Dependabot opens weekly PRs for npm and GitHub Actions.
