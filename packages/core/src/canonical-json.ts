/**
 * RFC 8785 JSON Canonicalization Scheme (JCS), dependency-free.
 *
 * Hosts and adapters use it to hash JSON values so the hash does not depend on
 * key order: a history stored in a database that reorders keys (Postgres
 * `jsonb`) or rebuilt from storage still hashes to the same bytes.
 *
 * Output is a string; encode it as UTF-8 (`new TextEncoder().encode(...)`) for
 * hashing.
 *
 * Accepted domain: {@link JsonValue} only. Anything JSON cannot represent is
 * rejected with `LlmError('bad_request')` naming the path, never coerced:
 * `undefined`, functions, symbols, bigint, non-finite numbers, `-0`, lone
 * surrogates (in strings and in keys), cycles, and non-plain objects (class
 * instances, `Date`, `Map`, typed arrays, ...).
 *
 * @module
 */

import { LlmError } from './errors.js'
import type { JsonValue } from './types.js'

function reject(path: string, why: string): never {
  throw new LlmError(`canonicalJson: ${path === '' ? 'value' : path} ${why}.`, {
    kind: 'bad_request',
    retryable: false,
    issues: [{ path, message: why }],
  })
}

function assertWellFormed(text: string, path: string): void {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++
        continue
      }
      reject(path, 'contains a lone surrogate')
    }
    if (c >= 0xdc00 && c <= 0xdfff) reject(path, 'contains a lone surrogate')
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

function serialize(value: unknown, path: string, ancestors: object[]): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'string':
      assertWellFormed(value, path)
      // ES JSON.stringify string serialization is the JCS string form (RFC 8785 §3.2.2.2).
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) reject(path, 'is not a finite number')
      if (Object.is(value, -0)) reject(path, 'is negative zero')
      // ES Number::toString is the JCS number form (RFC 8785 §3.2.2.3).
      return JSON.stringify(value)
    case 'object':
      break
    default:
      return reject(path, `is not JSON (${typeof value})`)
  }

  const obj = value
  if (ancestors.includes(obj)) reject(path, 'is a cycle')
  ancestors.push(obj)
  try {
    if (Array.isArray(obj)) {
      const items: string[] = []
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) reject(`${path}[${i}]`, 'is a hole in a sparse array')
        items.push(serialize(obj[i], `${path}[${i}]`, ancestors))
      }
      return `[${items.join(',')}]`
    }
    if (!isPlainObject(obj)) reject(path, 'is not a plain object')
    // Default sort compares UTF-16 code units, which is what RFC 8785 §3.2.3 requires.
    const keys = Object.keys(obj).sort()
    const members: string[] = []
    for (const key of keys) {
      const childPath = path === '' ? key : `${path}.${key}`
      assertWellFormed(key, `${childPath} (key)`)
      members.push(`${JSON.stringify(key)}:${serialize(obj[key], childPath, ancestors)}`)
    }
    return `{${members.join(',')}}`
  } finally {
    ancestors.pop()
  }
}

/**
 * Serialize `value` with the RFC 8785 JSON Canonicalization Scheme: object keys
 * sorted by UTF-16 code units, ECMAScript number serialization, no insignificant
 * whitespace. Throws `LlmError('bad_request')` for anything outside the JSON
 * domain (see the module doc).
 */
export function canonicalJson(value: JsonValue): string {
  return serialize(value, '', [])
}
