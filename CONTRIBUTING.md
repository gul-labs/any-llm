# Contributing

Thanks for looking. This is a small, opinionated library. [`SPEC.md`](./SPEC.md) is the v1 contract. [`DESIGN.md`](./DESIGN.md) is the north star. When they disagree, SPEC wins.

Only [@atifgul99](https://github.com/atifgul99) can push or merge to `main`. Everyone else works on a fork or a feature branch and opens a pull request.

## Dev setup

Node `>=24` for development (`.nvmrc` pins 24.20.0; published packages support Node `>=22.12.0`). Package manager is **pnpm 11.24.0** (see `packageManager` in the root `package.json`). pnpm settings — overrides, peer-dependency behavior, and build approvals — live in `pnpm-workspace.yaml`.

```bash
pnpm install
pnpm lint           # ESLint flat config
pnpm typecheck      # tsc --noEmit across the workspace, examples included
pnpm check:docs     # typecheck the ts code fences in READMEs and docs against the built packages
pnpm test           # vitest, no network
pnpm -r build       # tsup: ESM + CJS + d.ts
pnpm format:check   # Prettier
pnpm quality        # build + format:check + lint + typecheck + check:docs + test (same gate CI runs)
pnpm example        # network-free end-to-end demo
```

## Principles

- **Tests never hit a real provider.** Use the fakes in `@gullabs/testing`.
- **Adapters stay thin.** Map request ⇄ raw SDK only. The engine validates config, computes cost, persists.
- **Cost is frozen at write time** (integer micro-USD + `pricingVersion`). GROSS tokens: `cached ⊆ input`, `thinking ⊆ output`.
- **Reject, do not map.** No aliases, shims, or compatibility fallbacks. See `Agents.md`.
- **No ambient auth.** Do not read `process.env` for credentials inside the library.
- **Docs compile.** Every `ts` code fence in a README or live doc is typechecked by `pnpm check:docs`; a fence that is deliberately a fragment says ` ```ts no-check `. Design records (ADRs, plans, audits) are not checked.
- Keep the public surface small. Breaking changes follow SemVer. Pre-1.0 minors may break; say so in the changeset.

## Pull requests

1. Branch from `main`.
2. Keep the diff focused. One concern per PR.
3. Add or update tests with the change.
4. Run `pnpm quality` locally.
5. Add a [changeset](https://github.com/changesets/changesets) for any user-facing or published-package change:

   ```bash
   pnpm changeset
   ```

   Docs-only, CI-only, and internal-chore PRs do not need a changeset.

6. Fill in the PR template. Do not paste secrets, live API keys, or provider payloads that contain customer data.

CI must be green. A maintainer reviews and squash-merges.

## What to read first

| File                                             | Why                     |
| ------------------------------------------------ | ----------------------- |
| [`SPEC.md`](./SPEC.md)                           | Build contract          |
| [`docs/architecture.md`](./docs/architecture.md) | How the engine is wired |
| [`DECISIONS.md`](./DECISIONS.md)                 | ADRs                    |
| [`RELEASING.md`](./RELEASING.md)                 | How versions reach npm  |

## Security reports

Do not open a public issue. See [`SECURITY.md`](./SECURITY.md).

## Conduct

Participation is governed by [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
