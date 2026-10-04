import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const src = (p: string) =>
  fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@gullabs/core': src('core'),
      '@gullabs/google': src('google'),
      '@gullabs/xai': src('xai'),
      '@gullabs/drizzle': src('drizzle'),
      '@gullabs/quota': src('quota'),
      '@gullabs/testing': src('testing'),
      '@gullabs/claude-cli': src('claude-cli'),
      '@gullabs/codex-cli': src('codex-cli'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
      // The v8 provider remaps coverage through the AST, so the same test suite
      // reports lower (and more accurate) numbers than a source-line measurement.
      // These thresholds are calibrated to the AST-aware measurement, not relaxed.
      thresholds: {
        statements: 89,
        branches: 87,
        functions: 89,
        lines: 90,
      },
    },
  },
})
