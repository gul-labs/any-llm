# Releasing

This monorepo uses [Changesets](https://github.com/changesets/changesets) for version management and publishing to npm. Publishing is done by GitHub Actions, not from a developer machine.

## Provenance

Provenance comes from [npm trusted publishing](https://docs.npmjs.com/trusted-publishers). The Release job requests `id-token: write`; on every publish pnpm 11 exchanges the Actions OIDC token for a short-lived publish credential and attaches a provenance attestation from it. Each package needs a trusted publisher configured on npmjs.com (package → Settings → Trusted Publisher → GitHub Actions, organization `gul-labs`, repository `any-llm`, workflow `release.yml`). A package without one still publishes through the `NPM_TOKEN` fallback, but **without** provenance.

There is no `NPM_CONFIG_PROVENANCE` setting. pnpm 11 publishes natively and reads `provenance` only from the `--provenance` CLI flag, not from the environment or `.npmrc`, and `changeset publish` does not pass that flag. This is why `@gullabs/*` 0.14.0 (the first pnpm 11 release) shipped without attestations while 0.13.x has them.

After a release, confirm the attestation landed: `npm view @gullabs/<pkg>@<version> dist.attestations`.

If the repository is ever made private, npm rejects provenance bundles (`E422 Unsupported GitHub Actions source repository visibility: "private"`); remove the trusted publishers and `id-token: write` in that case.

npm compares the manifest `repository.url` against the attestation's `sourceRepositoryURI` (derived from the OIDC claims, which include `GITHUB_REPOSITORY`). The org/repo path must be exactly `gul-labs/any-llm`. The comparison is literal: different casing fails, and so does a former org name that GitHub still redirects (the org was renamed from `GulLabs` to `gul-labs`). A `git+https://….git` form is valid npm metadata; change the path only.

Verbatim registry error from Release [31787709259](https://github.com/gul-labs/any-llm/actions/runs/31787709259), from the earlier lowercase-casing incident under the old org name (quoted as-is; the paths in it are historical):

```
E422 422 Unprocessable Entity - PUT https://registry.npmjs.org/@gullabs%2fxai
Error verifying sigstore provenance bundle: Failed to validate repository
information: package.json: "repository.url" is
"git+https://github.com/gullabs/any-llm.git", expected to match
"https://github.com/GulLabs/any-llm" from provenance
```

The Release workflow fails fast if any public package's `repository.url` path does not equal `GITHUB_REPOSITORY`, before `changeset publish` starts. `packages/core/src/package-metadata.test.ts` asserts the same path on every public package and that this file lists each one. After an org/repo rename, update that test's `repoPath` first.

Registry provenance validation is not exercised by `npm publish --dry-run`. A rejected publish does not consume that package's version, so retry by rolling the path fix forward — never revert to a stale path. `changeset publish` is sequential: if a later package fails after an earlier one succeeded, the published versions are immutable. Before merging a metadata-only fix, verify with `npm view @gullabs/<pkg> version` and `git ls-remote --tags origin` and add a patch changeset for any version already on the registry.

## Release security

`release.yml` runs on `workflow_run`, which executes in the base repository with secrets even when the triggering CI run came from a fork PR. The job therefore only runs when the CI run succeeded **and** was a `push` event **and** came from this repository **and** from `main`. Top-level permissions are `contents: read`; the write grants are scoped to the release job. Do not loosen any of these conditions.

## Versioning: one version for every package

All nine packages are one changesets [`fixed` group](./.changeset/config.json) and always publish at the same version. Any changeset that bumps one of them bumps all of them, including packages with no code change in that release. The compatibility rule is therefore "same version number", and it is the whole compatibility matrix: **mixed versions are unsupported and untested.** Core contracts change on most minors, so a companion built against one core is not known to work with the next, and a per-package peer range would need mixed-version testing on every release.

`@gullabs/core` is an **exact-version `peerDependency`** of every other package (`workspace:*` in `peerDependencies`; pnpm replaces it with the exact release version when packing) and a `devDependency` for builds. It is never a regular dependency. Consequences:

- A host that installs any package needs `@gullabs/core` at the same version. npm 7+ and pnpm install a missing peer automatically; `pnpm add @gullabs/core @gullabs/xai openai` is the explicit form.
- Two copies of core cannot coexist silently, so `instanceof LlmError` and the other cross-package contracts stay sound. There is deliberately no `Symbol.hasInstance` brand: it would only exist to support the unsupported mixed install.
- Mixing versions, patch releases included, is a peer-dependency error under pnpm's `strictPeerDependencies` and an `ERESOLVE` error under npm 7+ (unless `--legacy-peer-deps` is set, which is outside the contract).
- Pre-1.0, a breaking change anywhere in the group is a `minor` for the whole group.

Do not add a new `@gullabs/*` package that depends on core without adding it to the `fixed` group and giving it the same peer + devDependency shape; `packages/core/src/lockstep-manifests.test.ts` fails otherwise.

### Packed-install checks

`scripts/packed-install.mjs` (`pnpm test:packed-install`, CI job `packed-install`) packs every package exactly as publishing does, serves the tarballs from a throwaway registry on `127.0.0.1` (the `@gullabs` scope only; third-party dependencies come from the real registry, nothing is published), and installs them into temp projects with pnpm (strict peers) and npm:

1. a direct provider set (every package except the facade),
2. the facade alone,
3. the facade plus a direct provider (`@gullabs/xai`).

Each must install, resolve exactly one `@gullabs/core` copy, load under ESM and CJS, and typecheck an example. The drizzle tarball must ship `sql/install.sql` and the upgrade files, and `@gullabs/drizzle/sql/*` must resolve through both `require.resolve` and `import.meta.resolve`. The negative cases install this tree's own companion tarballs next to core re-registered at a different patch and at a different minor (no network needed for them); pnpm strict peers must reject both (npm's behaviour is printed for information). A tarball of the previous release is not fetched, so that comparison stays a manual pre-release check. The script needs the real npm registry for third-party packages (`@google/genai`, `openai`, `drizzle-orm`, `typescript` and their dependencies), so a registry outage fails the CI job: re-run it. On success, failure and Ctrl-C it removes its temp directory, closes the throwaway registry and kills every child process group. Once no changesets are pending, the script also asserts that all packages share one version, which is what the "Version Packages" PR must satisfy. Run it locally after `pnpm -r build`.

## How it works

1. **Add a changeset** while you work — which packages, which semver bump, what changed.
2. **Open and merge the feature PR to `main`.** Feature-branch CI does not publish.
3. **Let the `Release` workflow run after `main` CI succeeds.** `.github/workflows/release.yml` is triggered by a successful `CI` workflow run on `main`.
4. **Changesets decides whether to version or publish:**
   - Pending `.changeset/*.md` files → `changesets/action` opens a "Version Packages" PR.
   - Versions already bumped and no pending changesets → `changesets/action` runs `pnpm release` and publishes unpublished versions (trusted publishing via OIDC, `NPM_TOKEN` as fallback).

Do not block a normal CI release on local `npm whoami`. Local npm auth is only for the emergency manual path.

## Day-to-day: adding a changeset

```bash
# From the repo root, on your feature branch:
pnpm changeset
```

The CLI asks which packages changed, the bump level, and a one-line summary. Commit the file under `.changeset/` with the code.

Docs-only, CI-only, and internal-chore PRs do not need a changeset.

## Release flow

```
feature branch  →  PR + changeset file merged to main
                        ↓
              GitHub Actions: Release workflow
                        ↓
         changesets/action opens "Version Packages" PR
         (bumps package.json versions + writes CHANGELOGs)
                        ↓
         Maintainer reviews & squash-merges "Version Packages" PR
                        ↓
              GitHub Actions: Release workflow
                        ↓
         changesets/action publishes to npm with provenance
         GitHub Release tags are created automatically
```

There is also a valid fast path when the feature branch already includes the version commit:

```
feature branch  →  PR with code + package.json/CHANGELOG version bumps merged to main
                        ↓
              GitHub Actions: CI succeeds on main
                        ↓
              GitHub Actions: Release workflow
                        ↓
         changesets/action publishes the already-versioned unpublished packages
```

Use only one path per release:

- **Normal path:** commit `.changeset/*.md`, merge to `main`, then merge the generated "Version Packages" PR.
- **Pre-versioned path:** run `pnpm version-packages` on the feature branch, commit package/changelog updates, and merge that PR directly to `main`.

Do not keep both a pending changeset file and a committed version bump for the same change.

## Packages published

All packages are published to the `@gullabs` scope with `publishConfig.access = "public"`:

| Package               | npm                                               |
| --------------------- | ------------------------------------------------- |
| `@gullabs/any-llm`    | https://www.npmjs.com/package/@gullabs/any-llm    |
| `@gullabs/core`       | https://www.npmjs.com/package/@gullabs/core       |
| `@gullabs/google`     | https://www.npmjs.com/package/@gullabs/google     |
| `@gullabs/xai`        | https://www.npmjs.com/package/@gullabs/xai        |
| `@gullabs/drizzle`    | https://www.npmjs.com/package/@gullabs/drizzle    |
| `@gullabs/quota`      | https://www.npmjs.com/package/@gullabs/quota      |
| `@gullabs/testing`    | https://www.npmjs.com/package/@gullabs/testing    |
| `@gullabs/claude-cli` | https://www.npmjs.com/package/@gullabs/claude-cli |
| `@gullabs/codex-cli`  | https://www.npmjs.com/package/@gullabs/codex-cli  |

## Required repository secret

| Secret      | Description                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TOKEN` | npm automation token with publish access to the `@gullabs` scope. Generate at https://www.npmjs.com/settings → Access Tokens → Generate New Token → Automation. |

`GITHUB_TOKEN` is provided by GitHub Actions and passed to `changesets/action` as `github-token` (v2 no longer reads it from the environment). `NPM_TOKEN` is the fallback for packages without a trusted publisher; once all nine have one, it can be deleted.

## Manual release (emergency)

```bash
pnpm -r build
pnpm version-packages
changeset publish   # requires npm login on this machine
```

Prefer CI. A laptop publish will not attach the same provenance as the Actions OIDC identity.

Some pre-open-source CHANGELOG entries were later anonymized in-repo. The repo CHANGELOG is canonical; older GitHub Releases and already-published npm tarballs are historical snapshots.

## Snapshot / pre-releases

```bash
pnpm changeset pre enter alpha
# ... commit changesets as normal ...
pnpm changeset pre exit   # when ready to graduate
```
