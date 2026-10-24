---
'@gullabs/core': patch
'@gullabs/google': patch
'@gullabs/xai': patch
'@gullabs/testing': patch
'@gullabs/claude-cli': patch
'@gullabs/codex-cli': patch
'@gullabs/any-llm': patch
'@gullabs/drizzle': minor
---

Update runtime dependencies to Google Gen AI 2.31.0, OpenAI 7.43.0 and Zod 4.6.7.
Zod 4.6.7 includes the fix for memory exhaustion when validating oversized constrained
collections (GHSA-mrhx-c7xc-m3w5). Re-pin the JSON Schema fixtures against the updated Zod.

**Breaking:** `@gullabs/drizzle` now requires `drizzle-orm >=0.45.4 <1`, matching the
version exercised by the integration suite and excluding the SQL-identifier injection
vulnerability in releases before 0.45.2 (GHSA-gpj5-g38j-94v9).

Refresh the development toolchain and lockfile to remove vulnerable Vite, launch-editor,
shell-quote and source-map-js versions. Upgrade tsup to 9 and remove its obsolete TypeScript
`baseUrl` deprecation workaround and the esbuild override. Development requires Node
`^24.11.0 || >=26`; published packages retain their Node 22.12.0 floor.
