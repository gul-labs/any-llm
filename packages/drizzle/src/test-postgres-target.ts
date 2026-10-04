/**
 * The one place the Postgres integration suites read `ANY_LLM_TEST_POSTGRES_URL`.
 *
 * Those suites create a database, install the schema, write rows and drop the
 * database, so the URL must name a throwaway server on this machine. A URL whose
 * effective target is anywhere else is refused before any driver opens a
 * connection: the suites throw while they are loaded, and nothing connects.
 *
 * "Effective target" follows libpq, not just the URL's host: a `host` or
 * `hostaddr` query parameter replaces the host, `PGHOST` / `PGHOSTADDR` supply
 * one when the URL has none, and a comma-separated list names several (every
 * entry must be local). Local means 127.0.0.0/8, `::1`, `localhost` or a unix
 * socket directory (a path). An unrecognised spelling of an address (`127.1`,
 * `0x7f.1`, an IPv4-mapped IPv6) is refused rather than guessed at, and so is a
 * `service` parameter, which can name a host outside the URL. There is no
 * override switch.
 *
 * @module
 */

const URL_ENV_NAME = 'ANY_LLM_TEST_POSTGRES_URL'

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

function isLoopbackHost(raw: string): boolean {
  const host = raw.trim().replace(/^\[(.*)\]$/, '$1')
  if (host === '') return false
  // A unix socket directory.
  if (host.startsWith('/')) return true
  if (host.toLowerCase() === 'localhost') return true
  if (host === '::1') return true
  const match = IPV4.exec(host)
  if (match === null) return false
  const octets = match.slice(1).map(Number)
  return octets.every((n) => n <= 255) && octets[0] === 127
}

/** Every entry of a libpq host list (comma-separated) must be local; an empty list is not. */
function allLoopback(list: string): boolean {
  const entries = list.split(',')
  return entries.length > 0 && entries.every(isLoopbackHost)
}

/** Why `url` is refused, or undefined when every effective host is local. */
export function postgresTestTargetProblem(
  url: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'it is not a valid URL'
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return 'it is not a postgres:// or postgresql:// URL'
  }
  const params = new Map<string, string[]>()
  for (const [key, value] of parsed.searchParams) {
    const lower = key.toLowerCase()
    params.set(lower, [...(params.get(lower) ?? []), value])
  }
  if (params.has('service')) {
    return 'it has a service parameter, which can name a host outside the URL'
  }

  // The hosts libpq would connect to, in precedence order: `host` parameter, URL host,
  // PGHOST. An absent host everywhere means libpq's default, the local unix socket.
  const hostParams = params.get('host') ?? []
  let urlHost: string
  try {
    urlHost = decodeURIComponent(parsed.hostname)
  } catch {
    return 'its host is not validly encoded'
  }
  const hosts: string[] = [...hostParams]
  if (hostParams.length === 0) {
    if (urlHost !== '') hosts.push(urlHost)
    else if (env['PGHOST'] !== undefined && env['PGHOST'] !== '') {
      hosts.push(env['PGHOST'])
    }
  }
  for (const host of hosts) {
    if (!allLoopback(host)) {
      return `the host ${JSON.stringify(host)} is not loopback (127.0.0.0/8, ::1, localhost or a unix socket path)`
    }
  }

  // `hostaddr` is the address actually dialled, whatever the host says.
  const hostAddrs: string[] = [...(params.get('hostaddr') ?? [])]
  if (
    hostAddrs.length === 0 &&
    env['PGHOSTADDR'] !== undefined &&
    env['PGHOSTADDR'] !== ''
  ) {
    hostAddrs.push(env['PGHOSTADDR'])
  }
  for (const addr of hostAddrs) {
    if (!allLoopback(addr)) {
      return `the hostaddr ${JSON.stringify(addr)} is not loopback`
    }
  }
  return undefined
}

/**
 * The validated `ANY_LLM_TEST_POSTGRES_URL`, or `undefined` when it is not set
 * (the server-backed suites then skip). The suites pass `process.env`; this
 * file takes it as an argument because the package source is runtime-agnostic.
 *
 * @throws Error when the URL's effective target is not local; the message names
 *   the offending host and never prints the URL (it can hold a password).
 */
export function resolvePostgresTestUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const url = env[URL_ENV_NAME]
  if (url === undefined || url === '') return undefined
  const problem = postgresTestTargetProblem(url, env)
  if (problem !== undefined) {
    throw new Error(
      `${URL_ENV_NAME} refused: ${problem}. These suites create and drop databases and write rows, so the URL must name a throwaway Postgres on this machine (a host of 127.0.0.1, ::1, localhost or a unix socket path); there is no override.`,
    )
  }
  return url
}
