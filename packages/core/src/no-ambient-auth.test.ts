/**
 * Permanence guard: the library MUST NEVER read credentials from the
 * environment or any ambient source.
 *
 * These tests fail (intentionally) if anyone re-introduces:
 *   - `process.env` in non-test source files under packages/core or packages/google
 *   - `AuthProvider` or `envAuth` in the public exports of @gullabs/core
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as CoreExports from './index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect all *.ts source files under `dir`, excluding *.test.ts files.
 * Only non-test source files are checked for ambient-auth patterns.
 */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = []

  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name)
      if (entry.isDirectory()) {
        // Skip node_modules and dist output directories
        if (entry.name === 'node_modules' || entry.name === 'dist') continue
        walk(fullPath)
      } else if (
        entry.isFile() &&
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts')
      ) {
        files.push(fullPath)
      }
    }
  }

  walk(dir)
  return files
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MONOREPO_ROOT = resolve(import.meta.dirname, '../../..')
const CORE_SRC = resolve(MONOREPO_ROOT, 'packages/core/src')
const GOOGLE_SRC = resolve(MONOREPO_ROOT, 'packages/google/src')
const XAI_SRC = resolve(MONOREPO_ROOT, 'packages/xai/src')
const CLAUDE_CLI_SRC = resolve(MONOREPO_ROOT, 'packages/claude-cli/src')
const CODEX_CLI_SRC = resolve(MONOREPO_ROOT, 'packages/codex-cli/src')

// ---------------------------------------------------------------------------
// 1. No process.env in non-test source files
// ---------------------------------------------------------------------------

describe('no-ambient-auth: no process.env in source files', () => {
  it('packages/core/src — no non-test source file reads process.env', () => {
    const files = collectSourceFiles(CORE_SRC)
    expect(files.length).toBeGreaterThan(0) // sanity: must find at least one file

    const violations: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      // Check non-comment lines only: skip lines that are pure JSDoc/inline comments.
      const codeLines = content
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      if (codeLines.some((line) => line.includes('process.env'))) {
        violations.push(file.replace(MONOREPO_ROOT + '/', ''))
      }
    }

    expect(
      violations,
      `process.env found in core source files:\n${violations.join('\n')}`,
    ).toHaveLength(0)
  })

  it('packages/google/src — no non-test source file reads process.env', () => {
    const files = collectSourceFiles(GOOGLE_SRC)
    expect(files.length).toBeGreaterThan(0)

    const violations: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      const codeLines = content
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      if (codeLines.some((line) => line.includes('process.env'))) {
        violations.push(file.replace(MONOREPO_ROOT + '/', ''))
      }
    }

    expect(
      violations,
      `process.env found in google source files:\n${violations.join('\n')}`,
    ).toHaveLength(0)
  })

  it('packages/xai/src — no non-test source file reads process.env', () => {
    const files = collectSourceFiles(XAI_SRC)
    expect(files.length).toBeGreaterThan(0)

    const violations: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      const codeLines = content
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      if (codeLines.some((line) => line.includes('process.env'))) {
        violations.push(file.replace(MONOREPO_ROOT + '/', ''))
      }
    }

    expect(
      violations,
      `process.env found in xai source files:\n${violations.join('\n')}`,
    ).toHaveLength(0)
  })

  // The real runner passes the child an allowlisted copy of the environment, so it
  // reads `process.env` once, to filter it. That read is the scrub of credential
  // variables, not a credential read: nothing else may touch it.
  it('packages/claude-cli/src — process.env is read only to build the child allowlist', () => {
    const files = collectSourceFiles(CLAUDE_CLI_SRC)
    expect(files.length).toBeGreaterThan(0)

    const violations: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      const codeLines = content
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      if (
        codeLines.some(
          (line) =>
            line.includes('process.env') && !line.includes('buildChildEnv(process.env'),
        )
      ) {
        violations.push(file.replace(MONOREPO_ROOT + '/', ''))
      }
    }

    expect(
      violations,
      `process.env found in claude-cli source files:\n${violations.join('\n')}`,
    ).toHaveLength(0)
  })

  // The real runner passes the child an allowlisted copy of the environment, so it
  // reads `process.env` once, to filter it. That read is the scrub of credential
  // variables, not a credential read: nothing else may touch it.
  it('packages/codex-cli/src — process.env is read only to build the child allowlist', () => {
    const files = collectSourceFiles(CODEX_CLI_SRC)
    expect(files.length).toBeGreaterThan(0)

    const violations: string[] = []
    for (const file of files) {
      const content = readFileSync(file, 'utf-8')
      const codeLines = content
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      if (
        codeLines.some(
          (line) =>
            line.includes('process.env') && !line.includes('buildChildEnv(process.env'),
        )
      ) {
        violations.push(file.replace(MONOREPO_ROOT + '/', ''))
      }
    }

    expect(
      violations,
      `process.env found in codex-cli source files:\n${violations.join('\n')}`,
    ).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. AuthProvider and envAuth must not appear in @gullabs/core public exports
// ---------------------------------------------------------------------------

describe('no-ambient-auth: removed symbols absent from @gullabs/core public exports', () => {
  it('AuthProvider is not exported from @gullabs/core', () => {
    // AuthProvider was an interface, so it only exists as a type export.
    // We verify the runtime module object has no such key.
    expect(Object.keys(CoreExports)).not.toContain('AuthProvider')
  })

  it('envAuth is not exported from @gullabs/core', () => {
    expect(Object.keys(CoreExports)).not.toContain('envAuth')
  })

  it('AuthMaterial is still exported (kept as a type — not a runtime value, so may not appear in keys)', () => {
    // AuthMaterial is a type-only export; TypeScript erases it at runtime.
    // This test documents the expected shape rather than asserting a key presence.
    // The real type-level enforcement happens in typecheck (pnpm typecheck).
    // We just assert the runtime module doesn't accidentally carry a stale envAuth value.
    const exports = CoreExports as Record<string, unknown>
    expect(exports['envAuth']).toBeUndefined()
    expect(exports['AuthProvider']).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Source-text check: catch re-introduction via `export type { AuthProvider }`
  // or any other export form. Runtime Object.keys() only catches value exports;
  // `export type { AuthProvider }` would slip through — this test catches it.
  // -------------------------------------------------------------------------

  it('packages/core/src/index.ts contains no export of AuthProvider or envAuth (value OR type)', () => {
    const INDEX_TS = resolve(CORE_SRC, 'index.ts')
    const source = readFileSync(INDEX_TS, 'utf-8')

    // Match any export statement that mentions the banned identifier.
    // Covers: `export { AuthProvider }`, `export type { AuthProvider }`,
    //         `export { foo, AuthProvider, bar }`, and re-export forms.
    // The regex looks for an export block whose brace-content contains the word.
    const BANNED = ['AuthProvider', 'envAuth']

    for (const name of BANNED) {
      // Match export { ... <name> ... } or export type { ... <name> ... }
      // Use word-boundary-like check: preceded/followed by non-word chars.
      const inExportBlock = /export\s+(?:type\s+)?\{[^}]*\}/g
      let match: RegExpExecArray | null
      const violations: string[] = []
      while ((match = inExportBlock.exec(source)) !== null) {
        // Check if the banned identifier appears as a standalone word in this block
        if (new RegExp(`\\b${name}\\b`).test(match[0])) {
          violations.push(match[0].trim())
        }
      }
      // Also catch direct named-export forms: `export const envAuth = ...`
      // or `export function AuthProvider` etc.
      if (
        new RegExp(
          `^export\\s+(?:const|let|var|function|class|type|interface)\\s+${name}\\b`,
          'm',
        ).test(source)
      ) {
        violations.push(`direct export of ${name}`)
      }
      expect(
        violations,
        `packages/core/src/index.ts must not export '${name}' in any form (value or type):\n${violations.join(
          '\n',
        )}`,
      ).toHaveLength(0)
    }
  })
})
