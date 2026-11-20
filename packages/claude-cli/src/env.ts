/**
 * The environment the runner gives the `claude` child.
 *
 * `claude -p` uses `ANTHROPIC_API_KEY` whenever it is present, instead of the
 * subscription login (https://code.claude.com/docs/en/env-vars: "In
 * non-interactive mode (`-p`), the key is always used when present"). A host that
 * also uses an Anthropic API key would therefore bill every call made through this
 * package to that key while the ledger records an unpriced call. So the child gets
 * an allowlisted copy of the host environment, never the whole of it: credential
 * and provider-routing variables are not on the list. A host that wants a variable
 * passed on says so with the adapter's `env` option.
 *
 * @module
 */

import { LlmError } from '@gullabs/core'

/**
 * The variable the adapter itself sets on every child, with this value. It is
 * adapter-owned, never inherited from the host environment (it is not on the list
 * below) and never accepted from the host's `env` option, which rejects it.
 *
 * `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` turns off the automatic model switch
 * Claude Code makes after a flagged message, so a refusal ends as an error instead
 * of being answered by another model. It is documented since Claude Code 2.1.312 (the
 * Claude Code changelog,
 * `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`, read
 * 2026-11-20: "set `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` to turn them off") and an
 * older CLI ignores it. It is a second protection beside the `--settings
 * {"switchModelsOnFlag":false}` argument; the served-model check on `modelUsage`
 * stays the one that enforces. Documented, not live-verified.
 */
export const REFUSAL_FALLBACK_ENV = {
  name: 'CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK',
  value: '1',
} as const

/** Exact names the child inherits (matched case-insensitively on Windows only). */
const INHERITED_NAMES: ReadonlySet<string> = new Set([
  // Process basics.
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'TZ',
  // Windows equivalents of the above.
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  // Network: proxies and trust roots.
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // The CLI's own documented settings that keep the subscription login usable:
  // where its login lives, the long-lived subscription token from
  // `claude setup-token`, and client certificates for an mTLS proxy.
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
])

/** Prefixes the child inherits (`LC_*` locale, `XDG_*` base directories). */
const INHERITED_PREFIXES: readonly string[] = ['LC_', 'XDG_']

function isInherited(name: string, windows: boolean): boolean {
  // Windows environment names are case-insensitive; elsewhere only the exact
  // spellings above (and the lower-case proxy ones) count.
  const key = windows ? name.toUpperCase() : name
  if (INHERITED_NAMES.has(key)) return true
  return INHERITED_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/**
 * Build the child's environment: the allowlisted part of `parent`, then `extra`
 * on top. `extra` wins (on Windows whatever the spelling of the name), and is passed
 * through unfiltered, because it is the host's explicit choice.
 */
export function buildChildEnv(
  parent: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> | undefined,
  windows: boolean,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && isInherited(name, windows)) env[name] = value
  }
  if (extra !== undefined) {
    if (windows) {
      // Windows names are case-insensitive and the OS hands the child only the
      // first match: an inherited `PATH` would beat the host's `Path`. Drop the
      // inherited spelling of every name the host sets.
      const overridden = new Set(Object.keys(extra).map((name) => name.toUpperCase()))
      for (const name of Object.keys(env)) {
        if (overridden.has(name.toUpperCase())) delete env[name]
      }
    }
    Object.assign(env, extra)
  }
  return env
}

function badEnv(message: string): LlmError {
  return new LlmError(message, {
    kind: 'bad_request',
    retryable: false,
    provider: 'claude-cli',
  })
}

/**
 * Check a host-supplied `env` option and return a frozen copy. Names and values
 * must be strings the OS accepts: a non-string, an empty name, `=` in a name or a
 * NUL anywhere is a `bad_request` here instead of a spawn failure on the first call.
 */
export function parseExtraEnv(
  env: unknown,
): Readonly<Record<string, string>> | undefined {
  if (env === undefined) return undefined
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    throw badEnv('claudeCliAdapter: `env` must be an object of string values')
  }
  const copy: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (name === '' || name.includes('=') || name.includes('\0')) {
      throw badEnv(`claudeCliAdapter: \`env\` has an invalid name "${name}"`)
    }
    if (name.toUpperCase() === REFUSAL_FALLBACK_ENV.name) {
      throw badEnv(
        `claudeCliAdapter: \`env.${name}\` is set by the adapter and cannot be passed`,
      )
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw badEnv(
        `claudeCliAdapter: \`env.${name}\` must be a string without NUL characters`,
      )
    }
    copy[name] = value
  }
  return Object.freeze(copy)
}
