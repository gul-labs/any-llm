---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/xai': minor
'@gullabs/quota': minor
'@gullabs/drizzle': minor
'@gullabs/testing': minor
'@gullabs/claude-cli': minor
'@gullabs/codex-cli': minor
'@gullabs/any-llm': minor
---

Lockstep versions with `@gullabs/core` as an exact peer, runtime support that is written down and tested, correct `exports`, and `LICENSE` plus `NOTICE` in every tarball.

- **One version for every package.** The nine `@gullabs/*` packages are one changesets `fixed` group and always release at the same version; a package with no code change still gets the bump. `@gullabs/google`, `@gullabs/xai`, `@gullabs/quota`, `@gullabs/drizzle`, `@gullabs/testing`, `@gullabs/claude-cli`, `@gullabs/codex-cli` and `@gullabs/any-llm` declare `@gullabs/core` as a `peerDependency` pinned to the exact release version instead of a regular dependency, so a second copy of core cannot sit in `node_modules` without a peer-dependency conflict and `instanceof LlmError` always sees one engine. Mixed versions, patch releases included, are a peer-dependency error under pnpm's strict peers and `ERESOLVE` under npm 7+; they are not supported or tested.
- **No Node built-in in `core`, `google`, `xai`, `quota`, `drizzle` and `any-llm`.** Ids come from `globalThis.crypto.randomUUID()`, hashes from the new dependency-free `sha256Hex(input)` that `@gullabs/core` exports next to `canonicalJson`, and `Buffer` and `process` are gone. The built ESM entries load with every `node:` import blocked and fake-backed calls run with `Buffer` and `process` removed (`pnpm test:runtime`, in CI); ESLint rejects `node:*`, `Buffer` and `process` in their source. Deno 2.4.1 passes by hand; Bun, Cloudflare Workers, Vercel Edge and browsers are not tested. `claude-cli`, `codex-cli` and `testing` stay Node only. `createClient` throws `bad_request` (path `ids`) when `ClientConfig.ids` is not given and the runtime has no `globalThis.crypto.randomUUID`, instead of failing with a `TypeError` on the first call.
- **`exports` has nested conditions**: `import` gives `index.d.ts` and `index.js`, `require` gives `index.d.cts` and `index.cjs`, and every package also exports `./package.json`. A TypeScript consumer under `node16` / `nodenext` that `require`s a package now gets CommonJS types (it got ESM types), and `require.resolve('@gullabs/core/package.json')` no longer throws. The ESM and CommonJS builds are separate copies: a process that loads one package through both holds two `LlmError` classes, so use one module format.
- **One Node floor, `>=22.12.0`**, in every `engines`, the README and the SPEC. CI runs the tests on 22.12.0 and 24.
- **Every tarball ships `LICENSE` and `NOTICE`** (Apache-2.0 4(d)); `@gullabs/drizzle` also ships its `sql/` directory.

What hosts must change:

- Install `@gullabs/core` next to any package that is not the facade, at the same version (`pnpm add @gullabs/core @gullabs/xai openai`); npm 7+ and pnpm install a missing peer unless `autoInstallPeers` or `legacy-peer-deps` is off. Upgrade every `@gullabs/*` package together.
- Remove any use of `VERSION` from `@gullabs/core` or `@gullabs/any-llm` (it read `0.0.0`); read your own `package.json`. `@gullabs/any-llm` still exports `ANY_LLM_VERSION`.
- On a runtime without `crypto.randomUUID` (a browser page served over plain http, some embedded runtimes), pass `ids`.
- A host compiled with `moduleResolution: node16` that `require`s a package may see new, correct type errors where it relied on the ESM declarations.
