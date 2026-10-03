/**
 * Best-effort secret redaction for persisted/logged text.
 *
 * **Not a full DLP solution.** This module provides a lightweight, regex-based
 * scrubber intended to reduce accidental secret exposure in audit records,
 * stored payloads and log lines. It covers the credential shapes listed on
 * {@link redactSecrets}. It will not catch every possible credential format, and
 * it knows nothing about personal data.
 *
 * Linear time. It runs on text a prompt or a model reply controls, so every
 * pattern is written so that no input can make it backtrack quadratically: key
 * names are bounded, an unbounded run is a single character class that is
 * consumed once (never `[^x]+` followed by something that can fail), and no
 * alternation has overlapping unbounded arms. `redact.test.ts` holds a timing
 * regression test over hostile inputs; keep new patterns inside the same rules.
 *
 * Pure functions; no dependencies. Safe to call in hot paths.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Characters that may end a credential value in a URL or a header. */
const VALUE_END = '&\\s#"\'<>'

/**
 * Provider-key prefixes, matched wherever they appear. The lookbehind keeps a
 * prefix inside an ordinary word (`task-…`, `desk-…`) from matching.
 *
 * - `AIza` Google API key, 20+ more characters
 * - `ya29.` Google OAuth access token
 * - `sk-` OpenAI / Anthropic style secret keys (`sk-proj-…`, `sk-ant-api03-…`)
 * - `ghp_` `gho_` `ghu_` `ghs_` `ghr_` GitHub tokens, and `github_pat_`
 * - `xai-` xAI keys
 * - `AKIA` AWS access key ids
 */
const KEY_PREFIX_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{20,}/g, 'AIza…REDACTED'],
  [/(?<![A-Za-z0-9])ya29\.[0-9A-Za-z_-]{20,}/g, 'ya29.…REDACTED'],
  [/(?<![A-Za-z0-9])sk-[0-9A-Za-z_-]{10,}/g, 'sk-…REDACTED'],
  [/(?<![A-Za-z0-9])gh[pousr]_[0-9A-Za-z]{20,}/g, 'gh…REDACTED'],
  [/(?<![A-Za-z0-9])github_pat_[0-9A-Za-z_]{20,}/g, 'github_pat_…REDACTED'],
  [/(?<![A-Za-z0-9])xai-[0-9A-Za-z_-]{20,}/g, 'xai-…REDACTED'],
  [/(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Za-z])/g, 'AKIA…REDACTED'],
]

/**
 * HTTP Bearer token value in an `Authorization` header or error message, any
 * case. `Bearer` then the token characters.
 */
const BEARER_TOKEN_RE = /\bbearer\s+[A-Za-z0-9._~+/=-]+/gi

/**
 * Any other `Authorization` scheme (`Basic`, `Digest`, `Token`, ...): the
 * header name, a scheme word, and the one credential token after it. Scoped to
 * the header name so the word "Basic" in prose is left alone.
 */
const AUTHORIZATION_SCHEME_RE =
  /\b(authorization\s{0,8}[:=]\s{0,8})([A-Za-z][A-Za-z0-9-]{0,32})\s+[^\s"'<>&,;]+/gi

/**
 * Sensitive query-parameter or inline `key=value` pairs, any case.
 *
 * - `X-Goog-*` and `X-Amz-*` signed-URL parameters (`Signature`, `Credential`,
 *   `Security-Token`, ...). The name after the prefix is bounded to 64
 *   characters, which keeps the scan linear.
 * - `sig` (Azure SAS), `signature`, `token`, `key`, `api_key`, `access_token`,
 *   `refresh_token`, `id_token`, `client_secret`, `password`, `passwd`,
 *   `secret`, `authorization`, `credential`.
 *
 * The value is the run of non-delimiter characters after `=`; the delimiters
 * are `&`, whitespace, `#`, `"`, `'`, `<`, `>`. `\b` before the key keeps a
 * longer word from matching (`token_type` is not `token`).
 */
const SENSITIVE_PARAM_RE = new RegExp(
  '\\b(X-Goog-[A-Za-z0-9-]{1,64}|X-Amz-[A-Za-z0-9-]{1,64}|api[_-]?key|' +
    'access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|' +
    'signature|sig|token|key|password|passwd|secret|authorization|credential)' +
    `=([^${VALUE_END}]+)`,
  'gi',
)

/**
 * A JSON object key whose value is a secret: `password`, `secret`, `token`,
 * `api_key` / `apiKey` / `api-key`, `authorization`, `credential(s)`,
 * `private_key`, in any case, as a substring (`client_secret`, `accessToken`).
 * A substring match is deliberate: it over-redacts (`max_tokens`) rather than
 * leak.
 */
const SENSITIVE_KEY_RE =
  /password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key/i

/** The value that replaces a secret JSON value. */
const REDACTED_VALUE = '[REDACTED]'

/** Deepest JSON nesting {@link redactJsonValue} walks; deeper is replaced. */
const MAX_JSON_DEPTH = 1000

/** Longest object key kept by {@link redactJsonValue}; the rest is cut. */
const MAX_KEY_CHARS = 1024

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Redacts known secret patterns from a string, in time linear in its length.
 *
 * **Best-effort, not full DLP.** Covers, in any case where one applies:
 * - provider keys by prefix: Google (`AIza…`, `ya29.…`), `sk-…` (OpenAI,
 *   Anthropic), GitHub (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`),
 *   xAI (`xai-…`), AWS access key ids (`AKIA…`)
 * - HTTP `Bearer` tokens, and the credential after any scheme in an
 *   `Authorization: <scheme> <credential>` header (`Basic`, `Digest`, ...)
 * - sensitive `name=value` pairs in URLs and text: `X-Goog-*`, `X-Amz-*`
 *   (S3 presigned `Signature`, `Credential`, `Security-Token`), `sig`
 *   (Azure SAS), `signature`, `token`, `key`, `api_key`, `access_token`,
 *   `refresh_token`, `id_token`, `client_secret`, `password`, `passwd`,
 *   `secret`, `authorization`, `credential`
 *
 * Benign text is returned unchanged. The function is idempotent: calling it
 * twice on already-redacted text produces the same output.
 *
 * Text containing U+0000 is redacted as it is; a caller that strips U+0000
 * (Postgres cannot store it) must strip it first, or a secret split by NUL
 * reassembles after redaction.
 *
 * @param text - The string to redact secrets from.
 * @returns A new string with secrets replaced by placeholder values.
 */
export function redactSecrets(text: string): string {
  let out = text
  // 1. Provider keys first (they may also sit inside URLs, before param redaction)
  for (const [re, replacement] of KEY_PREFIX_RULES) out = out.replace(re, replacement)
  // 2. Bearer tokens, then any other Authorization scheme
  out = out.replace(BEARER_TOKEN_RE, 'Bearer …REDACTED')
  out = out.replace(
    AUTHORIZATION_SCHEME_RE,
    (_match, header: string, scheme: string) => `${header}${scheme} …REDACTED`,
  )
  // 3. Sensitive name=value pairs in URLs and inline text
  return out.replace(
    SENSITIVE_PARAM_RE,
    (_match, key: string, _value: string) => `${key}=REDACTED`,
  )
}

/**
 * Postgres `text` cannot hold U+0000 and `jsonb` rejects it, and `jsonb` also
 * rejects an unpaired surrogate (`JSON.stringify` writes one as a `\ud800`-style
 * escape). Provider-controlled text can carry either, and a row that fails to
 * insert is a billed row lost (the sink is fail-open). `cleanText` removes
 * U+0000 and replaces each unpaired surrogate with U+FFFD.
 */
export function cleanText(text: string): string {
  let out: string | undefined
  let from = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    let replacement: string | undefined
    if (c === 0) {
      replacement = ''
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        i += 1
        continue
      }
      replacement = '\ufffd'
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      replacement = '\ufffd'
    }
    if (replacement === undefined) continue
    out = (out ?? '') + text.slice(from, i) + replacement
    from = i + 1
  }
  return out === undefined ? text : out + text.slice(from)
}

/**
 * Sets `key` on `target` as an own data property. A plain `target[key] = v`
 * with the key `__proto__` sets the prototype instead and drops the data.
 */
export function setOwn(target: Record<string, unknown>, key: string, value: unknown) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/**
 * Copies a JSON value with secrets removed: every string goes through
 * `mapString` (default {@link redactSecrets}), every object key is cleaned of
 * U+0000 and then, when it looks like a secret name (`password`, `secret`,
 * `token`, `api_key`, `authorization`, `credential`, `private_key`, any case, as
 * a substring), has its value replaced with `[REDACTED]` (null and booleans
 * excepted); a key that is itself a secret is redacted like a string. Always
 * builds new containers; the input is not touched. A `__proto__` key stays
 * data. Nesting deeper than 1000 levels is replaced with `[REDACTED]`.
 *
 * Best-effort, like {@link redactSecrets}.
 */
export function redactJsonValue(
  value: unknown,
  mapString: (text: string) => string = redactSecrets,
): unknown {
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === 'string') return mapString(node)
    if (typeof node !== 'object' || node === null) return node
    if (depth > MAX_JSON_DEPTH) return REDACTED_VALUE
    if (Array.isArray(node)) {
      return (node as unknown[]).map((item) => walk(item, depth + 1))
    }
    const out: Record<string, unknown> = {}
    for (const [rawKey, item] of Object.entries(node as Record<string, unknown>)) {
      const cleanKey = cleanText(rawKey.slice(0, MAX_KEY_CHARS))
      const secret =
        SENSITIVE_KEY_RE.test(cleanKey) && item !== null && typeof item !== 'boolean'
      setOwn(
        out,
        redactSecrets(cleanKey),
        secret ? REDACTED_VALUE : walk(item, depth + 1),
      )
    }
    return out
  }
  return walk(value, 0)
}
