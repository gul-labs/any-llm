/**
 * Package-surface importability tests for @gullabs/codex-cli.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import {
  codexCliAdapter,
  codexCliRegistry,
  codexCliProvider,
  toOpenAiStrictOutputSchema,
} from './index.js'

describe('@gullabs/codex-cli package surface', () => {
  it('codexCliAdapter is a function', () => {
    expect(typeof codexCliAdapter).toBe('function')
  })

  it('codexCliProvider is a function', () => {
    expect(typeof codexCliProvider).toBe('function')
  })

  it('codexCliRegistry.resolve("gpt-6-sol") is defined', () => {
    expect(codexCliRegistry.resolve('codex-cli', 'gpt-6-sol')).toBeDefined()
  })

  it('deleted gpt-5 ids do not resolve', () => {
    for (const id of ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-5.3-codex-spark']) {
      expect(codexCliRegistry.resolve('codex-cli', id)).toBeUndefined()
    }
  })

  it('toOpenAiStrictOutputSchema is a function', () => {
    expect(typeof toOpenAiStrictOutputSchema).toBe('function')
  })
})
