/**
 * SHA-256 with no runtime dependency.
 *
 * The library hashes small, bounded inputs synchronously: a history part's canonical
 * JSON (`canonicalJson`, RFC 8785) for the Gemini 3 thought-signature overlay, the bytes
 * of an inline media part and the schema of a tool for the opt-in payload record (ADR-038).
 * `node:crypto` would do it, but it makes the package entry fail to load on every runtime
 * that has no Node built-ins, and the WebCrypto digest is asynchronous and one-shot. This
 * is FIPS 180-4 in plain TypeScript, checked byte for byte against `node:crypto` in
 * `sha256.test.ts`.
 *
 * @module
 */

// prettier-ignore
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** `a[i]` as a number: every index here is in range by construction. */
const at = (a: ArrayLike<number>, i: number): number => a[i] as number

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/** Incremental SHA-256. Feed bytes with {@link Sha256.update}, finish with {@link Sha256.hex}. */
export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
    0x5be0cd19,
  ])
  private readonly block = new Uint8Array(64)
  private readonly w = new Uint32Array(64)
  private filled = 0
  private length = 0
  private done = false

  /** Add `bytes` to the message. */
  update(bytes: Uint8Array): this {
    if (this.done) throw new Error('Sha256: update after hex()')
    this.length += bytes.length
    let at = 0
    while (at < bytes.length) {
      const take = Math.min(64 - this.filled, bytes.length - at)
      this.block.set(bytes.subarray(at, at + take), this.filled)
      this.filled += take
      at += take
      if (this.filled === 64) {
        this.compress()
        this.filled = 0
      }
    }
    return this
  }

  /** Finish and return the digest as 64 lowercase hex characters. */
  hex(): string {
    if (this.done) throw new Error('Sha256: hex() called twice')
    this.done = true
    const bits = this.length * 8
    this.block[this.filled] = 0x80
    this.filled += 1
    if (this.filled > 56) {
      this.block.fill(0, this.filled)
      this.compress()
      this.filled = 0
    }
    this.block.fill(0, this.filled, 56)
    const view = new DataView(this.block.buffer)
    view.setUint32(56, Math.floor(bits / 0x100000000))
    view.setUint32(60, bits >>> 0)
    this.compress()
    let out = ''
    for (const word of this.state) out += word.toString(16).padStart(8, '0')
    return out
  }

  private compress(): void {
    const { w, state, block } = this
    const view = new DataView(block.buffer)
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(i * 4)
    for (let i = 16; i < 64; i += 1) {
      const w15 = at(w, i - 15)
      const w2 = at(w, i - 2)
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[i] = (at(w, i - 16) + s0 + at(w, i - 7) + s1) | 0
    }
    let a = at(state, 0)
    let b = at(state, 1)
    let c = at(state, 2)
    let d = at(state, 3)
    let e = at(state, 4)
    let f = at(state, 5)
    let g = at(state, 6)
    let h = at(state, 7)
    for (let i = 0; i < 64; i += 1) {
      const t1 =
        (h +
          (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) +
          ((e & f) ^ (~e & g)) +
          at(K, i) +
          at(w, i)) |
        0
      const t2 =
        ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    state[0] = (at(state, 0) + a) | 0
    state[1] = (at(state, 1) + b) | 0
    state[2] = (at(state, 2) + c) | 0
    state[3] = (at(state, 3) + d) | 0
    state[4] = (at(state, 4) + e) | 0
    state[5] = (at(state, 5) + f) | 0
    state[6] = (at(state, 6) + g) | 0
    state[7] = (at(state, 7) + h) | 0
  }
}

/**
 * SHA-256 of `input` as 64 lowercase hex characters. A string is hashed as its UTF-8
 * bytes. Synchronous, and it needs no `node:crypto`, `Buffer` or WebCrypto, so it works
 * on every runtime that runs the package.
 */
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input
  return new Sha256().update(bytes).hex()
}
