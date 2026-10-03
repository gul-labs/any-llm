/**
 * canonicalJson — RFC 8785 (JCS) conformance and JSON-domain rules.
 *
 * Vectors are copied from RFC 8785: the section 3.2.2/3.2.3 sample, the
 * property-sorting example, and Appendix B's number serialization table.
 */
import { describe, expect, it } from 'vitest'
import { canonicalJson } from './canonical-json.js'
import { LlmError } from './errors.js'
import type { JsonValue } from './types.js'

function fromHex(hex: string): number {
  const view = new DataView(new ArrayBuffer(8))
  view.setBigUint64(0, BigInt(`0x${hex}`))
  return view.getFloat64(0)
}

function expectBadRequest(fn: () => unknown): LlmError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ kind: 'bad_request', retryable: false })
    return error as LlmError
  }
  throw new Error('expected canonicalJson to throw')
}

describe('canonicalJson: RFC 8785 vectors', () => {
  it('canonicalizes the section 3.2.2 sample to the section 3.2.3 text', () => {
    const parsed = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    ) as JsonValue
    expect(canonicalJson(parsed)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    )
  })

  it('emits the UTF-8 bytes listed in section 3.2.4', () => {
    const parsed = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
        '"literals":[null,true,false]}',
    ) as JsonValue
    const expected = (
      '7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72 ' +
      '75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a ' +
      '5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31 ' +
      '65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37 ' +
      '5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30 ' +
      '30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d'
    ).split(' ')
    const bytes = Array.from(new TextEncoder().encode(canonicalJson(parsed)), (b) =>
      b.toString(16).padStart(2, '0'),
    )
    expect(bytes).toEqual(expected)
  })

  it('sorts property names by UTF-16 code units (section 3.2.3 data)', () => {
    const value = JSON.parse(
      '{"\\u20ac":"Euro Sign","\\r":"Carriage Return","\\ufb33":"Hebrew Letter Dalet With Dagesh",' +
        '"1":"One","\\ud83d\\ude00":"Emoji: Grinning Face","\\u0080":"Control",' +
        '"\\u00f6":"Latin Small Letter O With Diaeresis"}',
    ) as Record<string, string>
    // Check the emitted text: re-parsing would reorder integer-like keys such as "1".
    const text = canonicalJson(value)
    const expected = [
      'Carriage Return',
      'One',
      'Control',
      'Latin Small Letter O With Diaeresis',
      'Euro Sign',
      'Emoji: Grinning Face',
      'Hebrew Letter Dalet With Dagesh',
    ]
    const positions = expected.map((name) => text.indexOf(name))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((x, y) => x - y))
  })

  it.each([
    ['0000000000000000', '0'],
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['7fefffffffffffff', '1.7976931348623157e+308'],
    ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ['4340000000000000', '9007199254740992'],
    ['c340000000000000', '-9007199254740992'],
    ['4430000000000000', '295147905179352830000'],
    ['44b52d02c7e14af5', '9.999999999999997e+22'],
    ['44b52d02c7e14af6', '1e+23'],
    ['44b52d02c7e14af7', '1.0000000000000001e+23'],
    ['444b1ae4d6e2ef4e', '999999999999999700000'],
    ['444b1ae4d6e2ef4f', '999999999999999900000'],
    ['444b1ae4d6e2ef50', '1e+21'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ])('serializes IEEE 754 %s as %s (Appendix B)', (hex, expected) => {
    expect(canonicalJson(fromHex(hex))).toBe(expected)
  })

  it('rejects NaN and Infinity (Appendix B rows 7fff... and 7ff0...)', () => {
    expectBadRequest(() => canonicalJson(fromHex('7fffffffffffffff')))
    expectBadRequest(() => canonicalJson(fromHex('7ff0000000000000')))
  })
})

describe('canonicalJson: key order independence', () => {
  it('hashes nested key reorderings to the same text', () => {
    const a = { z: 1, a: { y: [1, { b: 2, a: 1 }], x: null }, m: 'x' }
    const b = { m: 'x', a: { x: null, y: [1, { a: 1, b: 2 }] }, z: 1 }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(canonicalJson(a)).toBe('{"a":{"x":null,"y":[1,{"a":1,"b":2}]},"m":"x","z":1}')
  })

  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
  })

  it('survives JSON.parse(JSON.stringify())', () => {
    const value = { b: [1.5, 'é', { d: true, c: null }], a: 'x\ny' }
    const roundTripped = JSON.parse(JSON.stringify(value)) as JsonValue
    expect(canonicalJson(roundTripped)).toBe(canonicalJson(value))
  })

  it('serializes 1.0 and 1 identically and large and small exponents per ECMAScript', () => {
    expect(canonicalJson(JSON.parse('1.0') as JsonValue)).toBe('1')
    expect(canonicalJson(1)).toBe('1')
    expect(canonicalJson(1e21)).toBe('1e+21')
    expect(canonicalJson(1e-7)).toBe('1e-7')
    expect(canonicalJson(123456789012345680000)).toBe('123456789012345680000')
  })

  it('serializes primitives and empty containers', () => {
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson('')).toBe('""')
    expect(canonicalJson([])).toBe('[]')
    expect(canonicalJson({})).toBe('{}')
  })

  it('accepts null-prototype objects and the "__proto__" key as data', () => {
    const bare = Object.create(null) as Record<string, JsonValue>
    bare['a'] = 1
    expect(canonicalJson(bare)).toBe('{"a":1}')
    expect(canonicalJson(JSON.parse('{"__proto__":1,"a":2}') as JsonValue)).toBe(
      '{"__proto__":1,"a":2}',
    )
  })
})

describe('canonicalJson: rejected input (bad_request, with the path)', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative zero', -0],
  ])('rejects %s', (_label, value) => {
    expectBadRequest(() => canonicalJson(value))
  })

  it('rejects lone surrogates in strings and keys', () => {
    expectBadRequest(() => canonicalJson('\ud800'))
    expectBadRequest(() => canonicalJson('a\udc00b'))
    expectBadRequest(() => canonicalJson({ ['\ud800']: 1 }))
    expect(canonicalJson('😀')).toBe('"\u{1f600}"')
  })

  it.each([
    ['undefined', undefined],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
    ['a bigint', 1n],
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['a typed array', new Uint8Array(2)],
    ['a class instance', new (class Foo {})()],
  ])('rejects %s', (_label, value) => {
    expectBadRequest(() => canonicalJson(value as unknown as JsonValue))
  })

  it('rejects undefined property values and sparse arrays instead of dropping them', () => {
    expectBadRequest(() => canonicalJson({ a: undefined } as unknown as JsonValue))
    expectBadRequest(() => canonicalJson([1, , 3] as unknown as JsonValue))
  })

  it('rejects cycles', () => {
    const loop: { self?: unknown } = {}
    loop.self = loop
    expectBadRequest(() => canonicalJson(loop as JsonValue))
  })

  it('allows the same object twice (not a cycle)', () => {
    const shared = { a: 1 }
    expect(canonicalJson([shared, shared])).toBe('[{"a":1},{"a":1}]')
  })

  it('names the offending path', () => {
    const error = expectBadRequest(() =>
      canonicalJson({ args: { list: [1, Number.NaN] } } as JsonValue),
    )
    expect(error.issues).toEqual([
      { path: 'args.list[1]', message: 'is not a finite number' },
    ])
  })
})
