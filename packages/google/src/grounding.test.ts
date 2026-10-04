/**
 * normalizeGroundingCitations — unit tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import {
  countWebSearchQueries,
  normalizeGroundingCitations,
  readSearchEntryPoint,
} from './grounding.js'

describe('normalizeGroundingCitations', () => {
  it('dedupes chunks with duplicate URLs, keeping first-seen order', () => {
    const groundingMetadata = {
      groundingChunks: [
        { web: { uri: 'https://example.com/a', title: 'Example A' } },
        { web: { uri: 'https://other.com/b', title: 'Other B' } },
        { web: { uri: 'https://example.com/a', title: 'Example A (dup)' } },
      ],
    }

    const citations = normalizeGroundingCitations(groundingMetadata)

    expect(citations).toEqual([
      { url: 'https://example.com/a', title: 'Example A', sourceName: 'Example A' },
      { url: 'https://other.com/b', title: 'Other B', sourceName: 'Other B' },
    ])
  })

  it('falls back to hostname (without www.) when title is missing', () => {
    const groundingMetadata = {
      groundingChunks: [{ web: { uri: 'https://www.example.com/page' } }],
    }

    const citations = normalizeGroundingCitations(groundingMetadata)

    expect(citations).toEqual([
      { url: 'https://www.example.com/page', sourceName: 'example.com' },
    ])
  })

  it('prefers title over hostname when both are present', () => {
    const groundingMetadata = {
      groundingChunks: [
        { web: { uri: 'https://www.example.com/page', title: 'Example Site' } },
      ],
    }

    const citations = normalizeGroundingCitations(groundingMetadata)

    expect(citations).toEqual([
      {
        url: 'https://www.example.com/page',
        title: 'Example Site',
        sourceName: 'Example Site',
      },
    ])
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty object', {}],
  ])('returns [] for empty/missing grounding metadata (%s)', (_label, input) => {
    expect(normalizeGroundingCitations(input)).toEqual([])
  })

  it.each([
    ['a string', 'not-an-object'],
    ['a number', 42],
    ['groundingChunks not an array', { groundingChunks: 'nope' }],
    ['groundingChunks missing', { somethingElse: true }],
  ])('returns [] for malformed top-level shape (%s)', (_label, input) => {
    expect(normalizeGroundingCitations(input)).toEqual([])
  })

  it('skips individual malformed chunks without bailing the whole array', () => {
    const groundingMetadata = {
      groundingChunks: [
        null,
        'not-an-object',
        {},
        { web: {} },
        { web: { uri: 'not a valid url' } },
        { web: { uri: 'https://good.example.com/', title: 'Good' } },
      ],
    }

    const citations = normalizeGroundingCitations(groundingMetadata)

    expect(citations).toEqual([
      { url: 'https://good.example.com/', title: 'Good', sourceName: 'Good' },
    ])
  })

  it('skips a javascript: URI (unsafe scheme), producing no citation', () => {
    const groundingMetadata = {
      groundingChunks: [{ web: { uri: 'javascript:alert(1)', title: 'Evil' } }],
    }

    const citations = normalizeGroundingCitations(groundingMetadata)

    expect(citations).toEqual([])
  })

  it('skips a mailto: URI (non-http(s) scheme), producing no citation', () => {
    const groundingMetadata = {
      groundingChunks: [{ web: { uri: 'mailto:x@y.com' } }],
    }

    const citations = normalizeGroundingCitations(groundingMetadata)

    expect(citations).toEqual([])
  })

  it('still normalizes a normal https:// URI correctly (regression guard)', () => {
    const groundingMetadata = {
      groundingChunks: [
        { web: { uri: 'https://example.com/page', title: 'Example Page' } },
      ],
    }

    const citations = normalizeGroundingCitations(groundingMetadata)

    expect(citations).toEqual([
      {
        url: 'https://example.com/page',
        title: 'Example Page',
        sourceName: 'Example Page',
      },
    ])
  })

  it('skips a chunk with an unsafe scheme while keeping a valid https chunk from the same array', () => {
    const groundingMetadata = {
      groundingChunks: [
        { web: { uri: 'javascript:alert(1)', title: 'Evil' } },
        { web: { uri: 'https://good.example.com/', title: 'Good' } },
      ],
    }

    const citations = normalizeGroundingCitations(groundingMetadata)

    expect(citations).toEqual([
      { url: 'https://good.example.com/', title: 'Good', sourceName: 'Good' },
    ])
  })
})

describe('countWebSearchQueries', () => {
  it('counts occurrences, treats an empty list as a known zero, and a missing list as unknown', () => {
    expect(countWebSearchQueries({ webSearchQueries: ['a', 'a', 'b'] })).toBe(3)
    expect(countWebSearchQueries({ webSearchQueries: [] })).toBe(0)
    expect(countWebSearchQueries({})).toBeUndefined()
    expect(countWebSearchQueries({ webSearchQueries: 'a' })).toBeUndefined()
    expect(countWebSearchQueries(undefined)).toBeUndefined()
    expect(countWebSearchQueries(null)).toBeUndefined()
  })

  it('counts only non-empty strings: an empty string or a non-string is not a query', () => {
    expect(countWebSearchQueries({ webSearchQueries: ['a', '', null, 3, 'b'] })).toBe(2)
    // A list that names no real query is malformed, not a reported zero.
    expect(countWebSearchQueries({ webSearchQueries: [''] })).toBeUndefined()
    expect(countWebSearchQueries({ webSearchQueries: [null] })).toBeUndefined()
  })
})

describe('readSearchEntryPoint', () => {
  it('returns a non-empty object and nothing else', () => {
    const entry = { renderedContent: '<div/>' }
    expect(readSearchEntryPoint({ searchEntryPoint: entry })).toEqual(entry)
    expect(readSearchEntryPoint({ searchEntryPoint: {} })).toBeUndefined()
    expect(readSearchEntryPoint({ searchEntryPoint: 'x' })).toBeUndefined()
    expect(readSearchEntryPoint({ searchEntryPoint: [1] })).toBeUndefined()
    expect(readSearchEntryPoint({})).toBeUndefined()
    expect(readSearchEntryPoint(null)).toBeUndefined()
  })
})

describe('normalizeGroundingCitations — groundingSupports', () => {
  const chunks = [
    { web: { uri: 'https://a.example/x', title: 'A' } },
    { web: { uri: 'https://b.example/y', title: 'B' } },
  ]

  it('ignores malformed supports without throwing', () => {
    const out = normalizeGroundingCitations({
      groundingChunks: chunks,
      groundingSupports: [
        null,
        { groundingChunkIndices: 'x' },
        { segment: 'x', groundingChunkIndices: [0, 'y'] },
      ],
    })
    expect(out.map((c) => c.cited)).toEqual([true, false])
    expect(out.every((c) => c.textRange === undefined)).toBe(true)
  })

  it('takes the first usable range for a chunk even if an earlier support had none', () => {
    const out = normalizeGroundingCitations(
      {
        groundingChunks: chunks,
        groundingSupports: [
          { segment: { partIndex: 3, endIndex: 5 }, groundingChunkIndices: [0] },
          { segment: { startIndex: 1, endIndex: 4 }, groundingChunkIndices: [0] },
          { segment: { startIndex: 0, endIndex: 2 }, groundingChunkIndices: [0] },
        ],
      },
      [{ text: 'abcdef', offset: 10 }],
    )
    expect(out[0]?.textRange).toEqual({ start: 11, end: 14 })
  })

  it('chunks that one support points at get a range each: mutating one never changes another', () => {
    const out = normalizeGroundingCitations(
      {
        groundingChunks: chunks,
        groundingSupports: [
          { segment: { startIndex: 1, endIndex: 4 }, groundingChunkIndices: [0, 1] },
        ],
      },
      [{ text: 'abcdef', offset: 0 }],
    )
    const [first, second] = out
    expect(first?.textRange).toEqual({ start: 1, end: 4 })
    expect(second?.textRange).toEqual({ start: 1, end: 4 })
    expect(first?.textRange).not.toBe(second?.textRange)
    if (first?.textRange !== undefined) first.textRange.end = 99
    expect(second?.textRange).toEqual({ start: 1, end: 4 })
  })

  it('a zero-length or inverted segment has no range', () => {
    const out = normalizeGroundingCitations(
      {
        groundingChunks: chunks,
        groundingSupports: [
          { segment: { startIndex: 2, endIndex: 2 }, groundingChunkIndices: [0] },
          { segment: { startIndex: 4, endIndex: 2 }, groundingChunkIndices: [1] },
        ],
      },
      [{ text: 'abcdef', offset: 0 }],
    )
    expect(out.map((c) => c.textRange)).toEqual([undefined, undefined])
    expect(out.map((c) => c.cited)).toEqual([true, true])
  })
})
