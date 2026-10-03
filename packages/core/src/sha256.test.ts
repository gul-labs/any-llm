import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { Sha256, sha256Hex } from './sha256.js'

const node = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
    expect(sha256Hex('a'.repeat(1_000_000))).toBe(
      'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
    )
  })

  it('agrees with node:crypto at every padding boundary (0 to 200 bytes)', () => {
    for (let n = 0; n <= 200; n += 1) {
      const bytes = randomBytes(n)
      expect(sha256Hex(bytes), `length ${n}`).toBe(node(bytes))
    }
  })

  it('agrees with node:crypto on larger random inputs', () => {
    for (const n of [1_000, 4_095, 4_096, 4_097, 65_537, 1_048_577]) {
      const bytes = randomBytes(n)
      expect(sha256Hex(bytes), `length ${n}`).toBe(node(bytes))
    }
  })

  it('hashes a string as UTF-8, including astral characters and lone surrogates', () => {
    for (const text of ['héllo', '日本語', '𝄞 clef', 'lone \ud800 surrogate', '\u0000']) {
      expect(sha256Hex(text), text).toBe(node(text))
    }
  })

  it('is incremental: any split of the input gives the same digest', () => {
    const bytes = randomBytes(1_000)
    for (const split of [1, 7, 63, 64, 65, 500, 999]) {
      const hash = new Sha256()
      hash.update(bytes.subarray(0, split)).update(bytes.subarray(split))
      expect(hash.hex(), `split ${split}`).toBe(node(bytes))
    }
  })

  it('refuses to be reused after hex()', () => {
    const hash = new Sha256().update(new Uint8Array(1))
    hash.hex()
    expect(() => hash.hex()).toThrow(/twice/)
    expect(() => hash.update(new Uint8Array(1))).toThrow(/after hex/)
  })
})
