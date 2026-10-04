/**
 * Tests for redact.ts — redactSecrets.
 *
 * Verifies each secret pattern is redacted and that benign text is untouched.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { redactJsonValue, redactSecrets } from './redact.js'

// Synthetic credentials are assembled from fragments so secret scanners do not flag the fixtures.
const AWS_KEY = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')
const GOOGLE_KEY = ['AIza', 'SyA1234567890abcdefghijklmnopqrstuv'].join('')

// ---------------------------------------------------------------------------
// 1. Google API keys
// ---------------------------------------------------------------------------

describe('redactSecrets — Google API keys', () => {
  it('redacts a standalone Google API key', () => {
    const text = 'Request failed with key AIzaSyAbc1234567890ABCDEFG in the URL'
    const out = redactSecrets(text)
    expect(out).toBe('Request failed with key AIza…REDACTED in the URL')
    expect(out).not.toContain('AIzaSyAbc1234567890ABCDEFG')
  })

  it('redacts a Google API key at the end of a string', () => {
    const key = 'AIzaSyXXXXXXXXXXXXXXXXXXXXXX'
    const out = redactSecrets(key)
    expect(out).toBe('AIza…REDACTED')
  })

  it('redacts multiple Google API keys in one string', () => {
    const text = 'key1=AIzaSyAAAAAAAAAAAAAAAAAAAAAA&key2=AIzaSyBBBBBBBBBBBBBBBBBBBBBB'
    const out = redactSecrets(text)
    expect(out).not.toContain('AIzaSyAAAAAAAAAAAAAAAAAAAA')
    expect(out).not.toContain('AIzaSyBBBBBBBBBBBBBBBBBBBB')
  })

  it('does NOT redact short AIza prefixes (under 20 suffix chars)', () => {
    // AIza = 4 chars, then [0-9A-Za-z_\-]{20,}.
    // The regex needs 20+, so this should NOT be redacted.
    const shortAIzaPrefix = 'AIzaShort'
    const out = redactSecrets(shortAIzaPrefix)
    expect(out).toBe(shortAIzaPrefix) // unchanged
  })

  it('redacts a key embedded in a full URL', () => {
    const url =
      'https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyTestKeyXXXXXXXXXXXXXX'
    const out = redactSecrets(url)
    expect(out).not.toContain('AIzaSyTestKeyXXXXXXXXXXXXXX')
  })
})

// ---------------------------------------------------------------------------
// 2. Bearer tokens
// ---------------------------------------------------------------------------

describe('redactSecrets — Bearer tokens', () => {
  it('redacts a Bearer token in an Authorization header value', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig'
    const out = redactSecrets(text)
    expect(out).toBe('Authorization: Bearer …REDACTED')
    expect(out).not.toContain('eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9')
  })

  it('redacts a Bearer token in an error message', () => {
    const text = 'Invalid credentials: Bearer my-secret-token-abc123'
    const out = redactSecrets(text)
    expect(out).toBe('Invalid credentials: Bearer …REDACTED')
  })

  it('handles Bearer with multiple spaces (tabs not included — standard)', () => {
    const text = 'Bearer  double-spaced-token-xyz'
    const out = redactSecrets(text)
    expect(out).toBe('Bearer …REDACTED')
  })

  it('does NOT redact Bearer followed by non-token characters', () => {
    // If there's nothing after 'Bearer ' (or only whitespace), no match.
    const text = 'Bearer '
    const out = redactSecrets(text)
    // No token chars follow — should be unchanged
    expect(out).toBe('Bearer ')
  })

  it('redacts a Bearer token containing ~ (tilde)', () => {
    const text = 'Authorization: Bearer abc~def~123'
    const out = redactSecrets(text)
    expect(out).toBe('Authorization: Bearer …REDACTED')
    expect(out).not.toContain('abc~def~123')
  })

  it('redacts a Bearer token containing + (plus)', () => {
    const text = 'Authorization: Bearer abc+def+xyz'
    const out = redactSecrets(text)
    expect(out).toBe('Authorization: Bearer …REDACTED')
    expect(out).not.toContain('abc+def+xyz')
  })

  it('redacts a Bearer token containing / (forward slash)', () => {
    const text = 'Authorization: Bearer abc/def/xyz'
    const out = redactSecrets(text)
    expect(out).toBe('Authorization: Bearer …REDACTED')
    expect(out).not.toContain('abc/def/xyz')
  })

  it('redacts a Bearer token containing = (equals, e.g. base64 padding)', () => {
    const text = 'Authorization: Bearer dGVzdA=='
    const out = redactSecrets(text)
    expect(out).toBe('Authorization: Bearer …REDACTED')
    expect(out).not.toContain('dGVzdA==')
  })

  it('redacts a standard base64-encoded Bearer token (contains +, /, =)', () => {
    // Standard base64 (not URL-safe) uses +, /, and = padding
    const token = 'SGVsbG8+V29ybGQ=/more+data=='
    const text = `Authorization: Bearer ${token}`
    const out = redactSecrets(text)
    expect(out).toBe('Authorization: Bearer …REDACTED')
    expect(out).not.toContain(token)
  })

  it('redacts a three-part JWT-style token with base64url segments', () => {
    // JWT format: header.payload.signature (base64url, no +/=/space)
    const jwt = 'aaaa.bbbb.cccc'
    const text = `Bearer ${jwt}`
    const out = redactSecrets(text)
    expect(out).toBe('Bearer …REDACTED')
    expect(out).not.toContain(jwt)
  })
})

// ---------------------------------------------------------------------------
// 3. Sensitive query-parameter values
// ---------------------------------------------------------------------------

describe('redactSecrets — sensitive query params', () => {
  it('redacts X-Goog-Signature value', () => {
    const url =
      'https://storage.googleapis.com/bucket/file.pdf?X-Goog-Signature=abc123XYZ'
    const out = redactSecrets(url)
    expect(out).toContain('X-Goog-Signature=REDACTED')
    expect(out).not.toContain('abc123XYZ')
  })

  it('redacts X-Goog-Credential value', () => {
    const url =
      'https://storage.googleapis.com/obj?X-Goog-Credential=serviceaccount%40project.iam.gserviceaccount.com'
    const out = redactSecrets(url)
    expect(out).toContain('X-Goog-Credential=REDACTED')
  })

  it('redacts key= param in query string', () => {
    const url = 'https://api.example.com/v1/endpoint?key=super-secret-key-123&other=ok'
    const out = redactSecrets(url)
    expect(out).toContain('key=REDACTED')
    expect(out).not.toContain('super-secret-key-123')
    expect(out).toContain('other=ok') // non-sensitive param preserved
  })

  it('redacts api_key= param', () => {
    const url = 'https://api.example.com/?api_key=very-secret-value'
    const out = redactSecrets(url)
    expect(out).toContain('api_key=REDACTED')
    expect(out).not.toContain('very-secret-value')
  })

  it('redacts access_token= param', () => {
    const text = 'access_token=ya29.secrettoken123'
    const out = redactSecrets(text)
    expect(out).toContain('access_token=REDACTED')
    expect(out).not.toContain('ya29.secrettoken123')
  })

  it('redacts token= param', () => {
    const text = 'https://api.example.com?token=my-bearer-token'
    const out = redactSecrets(text)
    expect(out).toContain('token=REDACTED')
    expect(out).not.toContain('my-bearer-token')
  })

  it('redacts signature= param', () => {
    const text =
      'https://files.example.com/download?signature=HMAC-SHA256-VALUE&expires=9999'
    const out = redactSecrets(text)
    expect(out).toContain('signature=REDACTED')
    expect(out).not.toContain('HMAC-SHA256-VALUE')
    expect(out).toContain('expires=9999')
  })

  it('redacts sig= param', () => {
    const text = 'sig=abc123def456&other=value'
    const out = redactSecrets(text)
    expect(out).toContain('sig=REDACTED')
    expect(out).not.toContain('abc123def456')
  })

  it('redacts multiple sensitive params in one URL', () => {
    const url =
      'https://storage.googleapis.com/bucket/file?' +
      'X-Goog-Algorithm=GOOG4-RSA-SHA256&' +
      'X-Goog-Credential=serviceacct%40project.iam&' +
      'X-Goog-Signature=abcdef123456&' +
      'X-Goog-SignedHeaders=host'
    const out = redactSecrets(url)
    expect(out).toContain('X-Goog-Credential=REDACTED')
    expect(out).toContain('X-Goog-Signature=REDACTED')
    expect(out).not.toContain('serviceacct%40project.iam')
    expect(out).not.toContain('abcdef123456')
  })
})

// ---------------------------------------------------------------------------
// 4. Benign text is untouched
// ---------------------------------------------------------------------------

describe('redactSecrets — benign text', () => {
  it('returns plain text unchanged', () => {
    const text = 'The quick brown fox jumps over the lazy dog.'
    expect(redactSecrets(text)).toBe(text)
  })

  it('returns empty string unchanged', () => {
    expect(redactSecrets('')).toBe('')
  })

  it('does not alter non-sensitive query params', () => {
    const url = 'https://api.example.com?model=gemini-2.5-pro&temperature=0.7'
    expect(redactSecrets(url)).toBe(url)
  })

  it('does not alter a normal error message', () => {
    const msg = 'HTTP 429: Too Many Requests — please retry after 60 seconds.'
    expect(redactSecrets(msg)).toBe(msg)
  })

  it('does not alter JSON that has no secrets', () => {
    const json = JSON.stringify({
      status: 400,
      message: 'Bad request',
      code: 'INVALID_ARGUMENT',
    })
    expect(redactSecrets(json)).toBe(json)
  })

  it('returns already-redacted text unchanged (idempotent)', () => {
    const redacted = 'key=REDACTED&api_key=REDACTED AIza…REDACTED Bearer …REDACTED'
    // Running redactSecrets again should not alter the placeholder text
    const out = redactSecrets(redacted)
    // The AIza…REDACTED might get re-processed — but the output should still be clean.
    // Key assertion: no double-redaction of the marker strings.
    expect(out).not.toContain('AIza…REDACTEDAIza') // no chained redaction
  })
})

// ---------------------------------------------------------------------------
// 5. Combined patterns in one string
// ---------------------------------------------------------------------------

describe('redactSecrets — combined patterns', () => {
  it('redacts API key inline (not in a key= param) alongside other patterns', () => {
    const text = 'Authenticated with AIzaSyABCD1234567890abcdefG and Bearer secret-token'
    const out = redactSecrets(text)
    expect(out).toContain('AIza…REDACTED')
    expect(out).toContain('Bearer …REDACTED')
    expect(out).not.toContain('AIzaSyABCD1234567890abcdefG')
    expect(out).not.toContain('secret-token')
  })

  it('redacts all patterns when they appear together', () => {
    // Note: the Google API key appears as the value of `key=`, so both the
    // Google-key pattern AND the `key=` param pattern fire. The final result
    // has `key=REDACTED` (not `key=AIza…REDACTED`) — still fully redacted.
    const text =
      'Auth error: Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig — ' +
      'URL was https://api.googleapis.com/?key=AIzaSyABCD1234567890abcdefG&sig=hmac-signature-value'

    const out = redactSecrets(text)

    // Secrets must be gone.
    expect(out).not.toContain('eyJhbGciOiJSUzI1NiJ9.payload.sig')
    expect(out).not.toContain('AIzaSyABCD1234567890abcdefG')
    expect(out).not.toContain('hmac-signature-value')
    // Each redaction pattern must have fired.
    expect(out).toContain('Bearer …REDACTED')
    // The key value (an API key) is redacted — either as `key=REDACTED` (param
    // pattern) or as `key=AIza…REDACTED` (Google key pattern fired first).
    // Both are acceptable; we only assert that the original value is gone.
    expect(out).toContain('key=')
    expect(out).toContain('sig=REDACTED')
  })
})

// ---------------------------------------------------------------------------
// 6. Linear time on hostile input (P1-1)
// ---------------------------------------------------------------------------

describe('redactSecrets — linear time on adversarial input', () => {
  const BUDGET_MS = 200
  function timed(input: string): number {
    const start = performance.now()
    redactSecrets(input)
    return performance.now() - start
  }

  it('280 KB of X-Goog- repeated (no =) finishes under the budget', () => {
    expect(timed('X-Goog-'.repeat(40_000))).toBeLessThan(BUDGET_MS)
  })

  it('1 MB of A finishes under the budget', () => {
    expect(timed('A'.repeat(1_000_000))).toBeLessThan(BUDGET_MS)
  })

  it.each([
    'AIza',
    'Bearer ',
    'Bearer\t',
    'Basic ',
    'Authorization: ',
    'authorization:Basic ',
    'X-Goog-',
    'X-Amz-',
    'X-Amz-Signature',
    'key',
    'key=',
    'sig',
    'sig=',
    'token=',
    'sk-',
    'sk-aaaaaaaa',
    'ghp_',
    'github_pat_',
    'xai-',
    'ya29.',
    'AKIA',
    '\u0000',
    ' ',
    '=',
    '-',
  ])('a long run of %j finishes under the budget', (prefix) => {
    const input = prefix.repeat(Math.ceil(300_000 / prefix.length))
    expect(timed(input)).toBeLessThan(BUDGET_MS)
  })

  it('long runs with a near-miss tail (the shape that backtracks) finish under the budget', () => {
    for (const unit of ['Bearer ', 'AIza', 'sk-', 'X-Goog-', 'key=']) {
      const input = `${unit.repeat(40_000)}!`
      expect(timed(input)).toBeLessThan(BUDGET_MS)
    }
  })
})

// ---------------------------------------------------------------------------
// 7. Wider coverage (P1-3)
// ---------------------------------------------------------------------------

describe('redactSecrets — signed URLs and header forms', () => {
  it('S3 presigned URL parameters', () => {
    const url = `https://b.s3.amazonaws.com/o?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${AWS_KEY}%2F20261003%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Security-Token=FwoGZXIvYXdzEJr&X-Amz-Signature=deadbeef0123&X-Amz-Date=20261003T000000Z`
    const out = redactSecrets(url)
    expect(out).not.toContain(AWS_KEY)
    expect(out).not.toContain('FwoGZXIvYXdzEJr')
    expect(out).not.toContain('deadbeef0123')
    expect(out).toContain('X-Amz-Signature=REDACTED')
    expect(out).toContain('X-Amz-Credential=REDACTED')
    expect(out).toContain('X-Amz-Security-Token=REDACTED')
  })

  it('Azure SAS sig= and GCS X-Goog-Signature', () => {
    const out = redactSecrets(
      'https://a.blob.core.windows.net/c/b?sv=2024-01-01&sig=Zm9vYmFy%2Bbaz&se=2026',
    )
    expect(out).not.toContain('Zm9vYmFy')
    expect(out).toContain('sv=2024-01-01')
    expect(redactSecrets('?X-Goog-Signature=0a1b2c')).toBe('?X-Goog-Signature=REDACTED')
  })

  it('is case-insensitive for bearer and parameter names', () => {
    expect(redactSecrets('authorization: bearer abc.def')).toBe(
      'authorization: Bearer …REDACTED',
    )
    expect(redactSecrets('BEARER abcdef123456')).toBe('Bearer …REDACTED')
    expect(redactSecrets('?Token=abc&Signature=zzz&SIG=q')).toBe(
      '?Token=REDACTED&Signature=REDACTED&SIG=REDACTED',
    )
    expect(redactSecrets('?Password=hunter2&Secret=s3')).toBe(
      '?Password=REDACTED&Secret=REDACTED',
    )
  })

  it('Authorization: Basic and other schemes', () => {
    const out = redactSecrets('Authorization: Basic dXNlcjpwYXNzd29yZA== next')
    expect(out).not.toContain('dXNlcjpwYXNzd29yZA')
    expect(out).toContain('Authorization: Basic …REDACTED')
    expect(redactSecrets('authorization=Digest abc')).not.toContain('abc')
  })

  it('does not treat prose containing Basic as a credential', () => {
    const text = 'Basic understanding of the problem is required.'
    expect(redactSecrets(text)).toBe(text)
  })

  it.each([
    ['sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
    ['sk-proj-abcdefghijklmnopqrstuvwxyz012345'],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['gho_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz'],
    ['xai-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH'],
    [GOOGLE_KEY],
    ['ya29.a0AfH6SMBabcdefghijklmnopqrstuvwxyz'],
    [AWS_KEY],
  ])('redacts the provider key %s wherever it appears', (key) => {
    const out = redactSecrets(`prefix ${key} suffix`)
    expect(out).not.toContain(key.slice(4, 24))
    expect(out.startsWith('prefix ')).toBe(true)
    expect(out.endsWith(' suffix')).toBe(true)
  })

  it('leaves look-alikes inside ordinary words alone', () => {
    const text = 'the task-management-system uses desk-lamp-assembly and a monkey=banana'
    expect(redactSecrets(text)).toBe(text)
  })

  it('is idempotent', () => {
    const text = `Bearer abc.def key=${GOOGLE_KEY} Authorization: Basic Zm9vOmJhcg== ?X-Amz-Signature=ab sk-ant-api03-AbCdEfGhIjKlMnOp`
    const once = redactSecrets(text)
    expect(redactSecrets(once)).toBe(once)
  })
})

describe('redactJsonValue', () => {
  it('replaces the value of a key named like a secret, in any case, at any depth', () => {
    const out = redactJsonValue({
      Password: 'p',
      nested: {
        API_KEY: 'k',
        apiKey: 'k2',
        'api-key': 'k3',
        list: [{ authorization: 'x' }],
      },
      client_secret: { a: 1 },
      accessToken: 12345,
      credentials: ['a'],
      privateKey: 'pk',
      private_key: 'pk',
      keep: 'visible',
      count: 3,
    })
    expect(out).toEqual({
      Password: '[REDACTED]',
      nested: {
        API_KEY: '[REDACTED]',
        apiKey: '[REDACTED]',
        'api-key': '[REDACTED]',
        list: [{ authorization: '[REDACTED]' }],
      },
      client_secret: '[REDACTED]',
      accessToken: '[REDACTED]',
      credentials: '[REDACTED]',
      privateKey: '[REDACTED]',
      private_key: '[REDACTED]',
      keep: 'visible',
      count: 3,
    })
  })

  it('redacts string values by pattern and a secret used as a key name', () => {
    const out = redactJsonValue({
      'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv': 1,
      url: 'https://x.test?X-Amz-Signature=abc',
    }) as Record<string, unknown>
    expect(JSON.stringify(out)).not.toContain('AbCdEfGhIjKlMnOp')
    expect(out['url']).toBe('https://x.test?X-Amz-Signature=REDACTED')
  })

  it('keeps a __proto__ key as data and does not touch the prototype', () => {
    const input = JSON.parse('{"__proto__":{"polluted":true},"a":1}') as unknown
    const out = redactJsonValue(input) as Record<string, unknown>
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.keys(out)).toEqual(['__proto__', 'a'])
    expect(JSON.stringify(out)).toBe('{"__proto__":{"polluted":true},"a":1}')
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })

  it('does not mutate its input and passes null, booleans and numbers through', () => {
    const input = { a: [1, true, null], password: 'x' }
    const copy = structuredClone(input)
    expect(redactJsonValue(input)).toEqual({ a: [1, true, null], password: '[REDACTED]' })
    expect(input).toEqual(copy)
  })
})
