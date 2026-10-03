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

Lockstep versions: every `@gullabs/*` package now ships at the same version, and mixed versions are unsupported.

**Core is now a peer dependency.** `@gullabs/google`, `@gullabs/xai`, `@gullabs/quota`, `@gullabs/drizzle`, `@gullabs/testing`, `@gullabs/claude-cli`, `@gullabs/codex-cli` and `@gullabs/any-llm` declare `@gullabs/core` as a `peerDependency` pinned to the exact release version instead of a regular dependency. That makes a second copy of core in `node_modules` impossible without a peer-dependency conflict, so `instanceof LlmError`, the shared registry and the middleware contracts always see one engine.

What hosts must change:

- Install `@gullabs/core` next to any package that is not the facade, at the same version: `pnpm add @gullabs/core @gullabs/xai openai`. npm 7+ and pnpm install a missing peer for you unless you have disabled `autoInstallPeers` / `legacy-peer-deps`.
- Upgrade every `@gullabs/*` package together. An install that mixes versions, patch releases included, is a peer-dependency error under pnpm's `strictPeerDependencies` and under npm 7+ unless `--legacy-peer-deps` is set. Mixed installs are not supported or tested.
- Packages with no code change in a release still get a version bump, because the group moves as one.

No runtime behaviour changes.
