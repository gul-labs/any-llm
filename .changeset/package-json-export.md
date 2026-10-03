---
'@gullabs/core': patch
'@gullabs/google': patch
'@gullabs/xai': patch
'@gullabs/quota': patch
'@gullabs/drizzle': patch
'@gullabs/testing': patch
'@gullabs/claude-cli': patch
'@gullabs/codex-cli': patch
'@gullabs/any-llm': patch
---

Every package exports `./package.json`, and the README documents the dual-package hazard.

`require.resolve('@gullabs/core/package.json')` threw `ERR_PACKAGE_PATH_NOT_EXPORTED`; bundlers, license scanners and version checks read that file. The root README now says that the ESM and CommonJS builds are separate copies, so a process that loads one package through both `import` and `require` holds two `LlmError` classes (`instanceof` can miss), and that hosts should use one module format.

What hosts must change: nothing.
