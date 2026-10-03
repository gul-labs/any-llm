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

Runtime support is written down and tested (ADR-042), the `exports` maps serve the right types to `require`, and `VERSION` is gone.

- **`VERSION` is deleted from `@gullabs/core`** (and so from `@gullabs/any-llm`, which re-exported it). It read `0.0.0` while the package was at 0.15. Read your own `package.json`; `@gullabs/any-llm` still exports `ANY_LLM_VERSION`, sourced from its `package.json`.
- **`@gullabs/core` exports `sha256Hex(input)`**: SHA-256 as lowercase hex, synchronous, for a string (UTF-8) or a `Uint8Array`, with no `node:crypto`. It is next to `canonicalJson`, which adapters pair it with.
- **No Node built-in in `core`, `google`, `xai`, `quota`, `drizzle` and `any-llm`.** Ids come from `globalThis.crypto.randomUUID()`, the payload and signature hashes use `sha256Hex`, and `Buffer` is gone. The built ESM entries load with every `node:` import blocked and fake-backed calls through core, the Gemini and xAI adapters, the drizzle sink and a quota store run with `Buffer` and `process` removed (`pnpm test:runtime`, in CI); ESLint rejects `node:*`, `Buffer` and `process` in their source. By hand under Deno 2.4.1 every check passes except the one asserting that `node:crypto` is blocked, which only holds under the Node hook. Bun, Cloudflare Workers, Vercel Edge and browsers are not tested. `claude-cli`, `codex-cli` and `testing` stay Node only. The README's "Runtimes" section lists exactly what is verified.
- **`exports` has nested conditions**: `import` gives `index.d.ts` and `index.js`, `require` gives `index.d.cts` and `index.cjs`. A TypeScript consumer under `node16` / `nodenext` that `require`s a package now gets CommonJS types (it got ESM types, "masquerading as ESM"). `publint --strict` and `attw --pack` run on every package in `pnpm quality`.
- **One Node floor, `>=22.12.0`**, in every `engines`, the README and the SPEC (which said "Node ≥20"). CI runs the tests on 22.12.0 and 24.

What hosts must change: remove any use of `VERSION` from `@gullabs/core` or `@gullabs/any-llm`. Nothing else is required; a host that compiled with `moduleResolution: node16` and `require` may see new (correct) type errors where it relied on the ESM declarations.
