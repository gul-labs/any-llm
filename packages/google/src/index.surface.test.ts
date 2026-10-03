/**
 * Package-surface importability tests for @gullabs/google.
 *
 * Proves that timeout constants are reachable from the package root index —
 * catching export/re-export mismatches at test time rather than at consumer
 * build time.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import * as surface from './index.js'
import {
  FLEX_DEFAULT_TIMEOUT_MS,
  GOOGLE_SEARCH_REQUESTED_DETAIL,
  TRANSPORT_TIMEOUT_BUFFER_MS,
  googleProvider,
} from './index.js'
import type {
  GeminiCountTokensParams,
  GeminiCountTokensResponseShape,
  GoogleSignatureState,
} from './index.js'

describe('@gullabs/google package surface: timeout constants', () => {
  it('FLEX_DEFAULT_TIMEOUT_MS is exported and equals 1_500_000', () => {
    expect(FLEX_DEFAULT_TIMEOUT_MS).toBe(1_500_000)
  })

  it('TRANSPORT_TIMEOUT_BUFFER_MS is exported and equals 5_000', () => {
    expect(TRANSPORT_TIMEOUT_BUFFER_MS).toBe(5_000)
  })
})

describe('@gullabs/google package surface: grounding marker', () => {
  it('exports the token_details key that marks a call that sent googleSearch', () => {
    expect(GOOGLE_SEARCH_REQUESTED_DETAIL).toBe('google_search_requested')
  })
})

describe('@gullabs/google package surface: googleProvider', () => {
  it('googleProvider is a function reachable from the package root', () => {
    expect(typeof googleProvider).toBe('function')
  })
})

describe('@gullabs/google package surface: deleted citation helper', () => {
  it('does not export normalizeGroundingCitations', () => {
    expect('normalizeGroundingCitations' in surface).toBe(false)
  })
})

describe('@gullabs/google package surface: token counting', () => {
  it('GeminiCountTokensParams/GeminiCountTokensResponseShape types are reachable', () => {
    const params: GeminiCountTokensParams = { model: 'gemini-2.5-pro', contents: [] }
    const response: GeminiCountTokensResponseShape = { totalTokens: 1 }
    expect(params.model).toBe('gemini-2.5-pro')
    expect(response.totalTokens).toBe(1)
  })
})

describe('@gullabs/google package surface: thought signatures', () => {
  it('exports the overlay state type; the hashing helpers stay internal', () => {
    const state: GoogleSignatureState = { google: { signatures: [] } }
    expect(state.google.signatures).toEqual([])
    expect('partSha256' in surface).toBe(false)
  })
})
