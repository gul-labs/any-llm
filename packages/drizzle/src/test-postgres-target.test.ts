import { describe, expect, it } from 'vitest'
import {
  postgresTestTargetProblem,
  resolvePostgresTestUrl,
} from './test-postgres-target.js'

const refused = (url: string, env: Record<string, string> = {}) =>
  expect(postgresTestTargetProblem(url, env)).toBeTypeOf('string')
const accepted = (url: string, env: Record<string, string> = {}) =>
  expect(postgresTestTargetProblem(url, env)).toBeUndefined()

describe('the Postgres integration suites refuse any non-loopback target', () => {
  it.each([
    'postgres://postgres@127.0.0.1:54417/postgres',
    'postgres://postgres:pw@localhost/postgres',
    'postgresql://postgres@LOCALHOST:5432/postgres',
    'postgres://postgres@127.9.8.7/postgres',
    'postgres://postgres@[::1]:5432/postgres',
    'postgres:///postgres?host=/tmp/pgsock',
    'postgres://postgres@%2Ftmp%2Fpgsock/postgres',
    'postgres://postgres@127.0.0.1/postgres?hostaddr=127.0.0.1',
    'postgres://postgres@127.0.0.1,localhost/postgres',
    'postgres:///postgres',
  ])('accepts %s', (url) => {
    accepted(url)
  })

  it.each([
    'postgres://postgres@db.example.com/postgres',
    'postgres://postgres@10.0.0.5:5432/postgres',
    'postgres://postgres@192.168.1.10/postgres',
    'postgres://postgres@128.0.0.1/postgres',
    'postgres://postgres@[2001:db8::1]/postgres',
    'postgres://postgres@127.0.0.1.example.com/postgres',
    'postgres://postgres@localhost.example.com/postgres',
    'postgres://127.0.0.1@db.example.com/postgres',
    'postgres://postgres@127.0.0.1@db.example.com/postgres',
    'postgres://postgres@0.0.0.0/postgres',
    'postgres://postgres@[::ffff:127.0.0.1]/postgres',
    'postgres://postgres@127.0.0.1,db.example.com/postgres',
    'http://127.0.0.1/postgres',
    'not a url',
  ])('refuses the remote or malformed target %s', (url) => {
    refused(url)
  })

  it('refuses a host override even when the URL host is local', () => {
    refused('postgres://postgres@127.0.0.1/postgres?host=db.example.com')
    refused('postgres://postgres@localhost/postgres?HOST=db.example.com')
    refused('postgres://postgres@127.0.0.1/postgres?host=127.0.0.1&host=db.example.com')
  })

  it('refuses a hostaddr override even when the host is local', () => {
    refused('postgres://postgres@localhost/postgres?hostaddr=203.0.113.9')
    refused('postgres://postgres@localhost/postgres?hostaddr=127.0.0.1,203.0.113.9')
  })

  it('refuses a service parameter, which can name a host outside the URL', () => {
    refused('postgres://postgres@127.0.0.1/postgres?service=prod')
  })

  it('an alternate spelling of a loopback address is refused, not guessed at', () => {
    refused('postgres://postgres@localhost/postgres?host=127.1')
    refused('postgres://postgres@localhost/postgres?host=0x7f.1')
    refused('postgres://postgres@localhost/postgres?hostaddr=2130706433')
  })

  it('a URL without a host takes PGHOST, which must be local too', () => {
    refused('postgres:///postgres', { PGHOST: 'db.example.com' })
    accepted('postgres:///postgres', { PGHOST: '/var/run/postgresql' })
    accepted('postgres:///postgres', { PGHOST: '127.0.0.1' })
    // A host in the URL wins over PGHOST, as in libpq.
    accepted('postgres://postgres@127.0.0.1/postgres', { PGHOST: 'db.example.com' })
  })

  it('PGHOSTADDR applies when the URL has no hostaddr', () => {
    refused('postgres://postgres@localhost/postgres', { PGHOSTADDR: '203.0.113.9' })
    accepted('postgres://postgres@localhost/postgres', { PGHOSTADDR: '127.0.0.1' })
    accepted('postgres://postgres@localhost/postgres?hostaddr=127.0.0.1', {
      PGHOSTADDR: '203.0.113.9',
    })
  })
})

describe('resolvePostgresTestUrl', () => {
  it('is undefined when the variable is unset or empty (the server suites skip)', () => {
    expect(resolvePostgresTestUrl({})).toBeUndefined()
    expect(resolvePostgresTestUrl({ ANY_LLM_TEST_POSTGRES_URL: '' })).toBeUndefined()
  })

  it('returns a local URL unchanged', () => {
    const url = 'postgres://postgres@127.0.0.1:54417/postgres'
    expect(resolvePostgresTestUrl({ ANY_LLM_TEST_POSTGRES_URL: url })).toBe(url)
  })

  it('throws for a remote URL without printing the URL or its password', () => {
    const url = 'postgres://admin:hunter2-secret@db.example.com:5432/prod'
    let message = ''
    try {
      resolvePostgresTestUrl({ ANY_LLM_TEST_POSTGRES_URL: url })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toContain('ANY_LLM_TEST_POSTGRES_URL refused')
    expect(message).toContain('db.example.com')
    expect(message).not.toContain('hunter2-secret')
    expect(message).toContain('no override')
  })

  it('throws for a host override', () => {
    expect(() =>
      resolvePostgresTestUrl({
        ANY_LLM_TEST_POSTGRES_URL: 'postgres://postgres@127.0.0.1/p?host=db.example.com',
      }),
    ).toThrow(/refused/)
  })
})
