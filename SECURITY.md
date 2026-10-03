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
- `redactSecrets()` best-effort scrubbing is applied only to persisted error messages and a handful of `generationConfig` fields (`providerOptions`, `httpOptions.headers`) before they reach the sink.
- Prompt and response text is captured only when a host sets `ClientConfig.payloads`; capture is off by default. Core's secret patterns and the host's `redact` run on every stored string before the size caps (ADR-038).
- The library never deletes stored payloads on its own. Retention and deletion are the host's duty.

## What this library does not guarantee

- The free-form `metadata` bag on `CallMetadata` is **never** scanned or redacted. It is stored verbatim. Do not put secrets in it.
- `redactSecrets` is regex-based, not a DLP engine. Do not treat it as a compliance control.
- A `UsageSink` you install can persist anything you write to it. Review that sink before storing prompts.
- Stored payloads can contain customer data. `redactSecrets` removes common credential patterns, not personal data: supply your own `redact` for that.
- Provider SDKs (`@google/genai`, `openai`, local CLIs) have their own trust boundaries. This library does not sandbox them.

## Supply chain

- Releases are published from GitHub Actions on `main` after CI is green. See [`RELEASING.md`](./RELEASING.md).
- Public releases attach [npm provenance](https://docs.npmjs.com/generating-provenance-statements).
- CI runs `gitleaks` and `pnpm audit --audit-level=high` on every pull request.
- Dependabot opens weekly PRs for npm and GitHub Actions.
