import { describe, expect, it } from 'vitest'
import { utf8ByteLength } from './utf8.js'

const encoded = (text: string) => new TextEncoder().encode(text).length

describe('utf8ByteLength', () => {
  it('agrees with TextEncoder on every width and on lone surrogates', () => {
    for (const text of [
      '',
      'abc',
      'é',
      '߿',
      'ࠀ',
      '￿',
      '\u{1F600}',
      'a\u{1F600}b',
      '\ud800',
      'a\udc00b',
      '\ud800\ud800',
      '\udc00\ud800',
      '\ud83d',
      '日本語 text \u{10FFFF}',
    ]) {
      expect(utf8ByteLength(text), JSON.stringify(text)).toBe(encoded(text))
    }
  })

  it('agrees with TextEncoder on random strings over the whole UTF-16 range', () => {
    let seed = 12345
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff)
    for (let n = 0; n < 500; n += 1) {
      const units: number[] = []
      for (let i = 0; i < 1 + (next() % 40); i += 1) units.push(next() % 0x10000)
      const text = String.fromCharCode(...units)
      expect(utf8ByteLength(text)).toBe(encoded(text))
    }
  })
})
