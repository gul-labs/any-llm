/**
 * The environment the runner gives the `codex` child.
 *
 * `codex exec` accepts an API key from the environment (`CODEX_API_KEY`, "to use a
 * different API key for a single run", and the OpenAI SDK's `OPENAI_API_KEY`), which
 * would turn a call meant to run on the ChatGPT login into a billed API call that
 * the ledger records as unpriced. OpenAI does not document the precedence between
 * the key and the saved login, so this package does not rely on it: the child gets
 * an allowlisted copy of the host environment, never the whole of it, and credential
 * and provider-routing variables are not on the list. A host that wants a variable
 * passed on says so with the adapter's `env` option.
 *
 * @module
 */

import { LlmError } from '@gullabs/core'

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
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  // The CLI's own documented settings that keep the saved login usable: where
  // its login lives (`CODEX_HOME`, default `~/.codex`) and a custom CA bundle
  // (`CODEX_CA_CERTIFICATE`).
  'CODEX_HOME',
  'CODEX_CA_CERTIFICATE',
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
 * on top. `extra` wins, and is passed through unfiltered, because it is the
 * host's explicit choice.
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
  if (extra !== undefined) Object.assign(env, extra)
  return env
}

function badEnv(message: string): LlmError {
  return new LlmError(message, {
    kind: 'bad_request',
    retryable: false,
    provider: 'codex-cli',
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
    throw badEnv('codexCliAdapter: `env` must be an object of string values')
  }
  const copy: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (name === '' || name.includes('=') || name.includes('\0')) {
      throw badEnv(`codexCliAdapter: \`env\` has an invalid name "${name}"`)
    }
    if (typeof value !== 'string' || value.includes('\0')) {
      throw badEnv(
        `codexCliAdapter: \`env.${name}\` must be a string without NUL characters`,
      )
    }
    copy[name] = value
  }
  return Object.freeze(copy)
}
