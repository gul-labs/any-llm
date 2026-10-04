import { describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'
import { buildChildEnv, parseExtraEnv } from './env.js'

describe('buildChildEnv', () => {
  const parent = {
    PATH: '/bin',
    HOME: '/home/u',
    LC_CTYPE: 'en_US.UTF-8',
    XDG_STATE_HOME: '/state',
    https_proxy: 'http://p',
    CLAUDE_CONFIG_DIR: '/own',
    ANTHROPIC_API_KEY: 'secret',
    OPENAI_API_KEY: 'secret',
    UNRELATED: '1',
  }

  it('copies only the allowlist, then the extra variables over it', () => {
    const env = buildChildEnv(
      parent,
      { CLAUDE_CONFIG_DIR: '/explicit', EXTRA: 'e' },
      false,
    )
    expect(env).toEqual({
      PATH: '/bin',
      HOME: '/home/u',
      LC_CTYPE: 'en_US.UTF-8',
      XDG_STATE_HOME: '/state',
      https_proxy: 'http://p',
      CLAUDE_CONFIG_DIR: '/explicit',
      EXTRA: 'e',
    })
  })

  it('matches names case-insensitively on Windows only', () => {
    const windows = buildChildEnv(
      { Path: 'C:\\bin', SystemRoot: 'C:\\Windows' },
      undefined,
      true,
    )
    expect(windows).toEqual({ Path: 'C:\\bin', SystemRoot: 'C:\\Windows' })
    expect(buildChildEnv({ Path: 'x' }, undefined, false)).toEqual({})
  })

  it('a host name replaces the inherited one whatever its case on Windows, and only there', () => {
    // The OS passes the child the first match, so a leftover `PATH` would win over `Path`.
    expect(
      buildChildEnv(
        { PATH: 'C:\\inherited', SystemRoot: 'C:\\Windows' },
        { Path: 'C:\\host' },
        true,
      ),
    ).toEqual({ SystemRoot: 'C:\\Windows', Path: 'C:\\host' })
    expect(
      buildChildEnv(
        { Path: 'C:\\inherited', PATH: 'C:\\other' },
        { pAtH: 'C:\\host' },
        true,
      ),
    ).toEqual({ pAtH: 'C:\\host' })
    // Elsewhere names are case-sensitive: both spellings stay.
    expect(buildChildEnv({ PATH: '/inherited' }, { Path: '/host' }, false)).toEqual({
      PATH: '/inherited',
      Path: '/host',
    })
  })

  it('does not read undefined entries', () => {
    expect(buildChildEnv({ PATH: undefined }, undefined, false)).toEqual({})
  })
})

describe('parseExtraEnv', () => {
  it('is undefined for undefined, a frozen copy otherwise', () => {
    expect(parseExtraEnv(undefined)).toBeUndefined()
    const copy = parseExtraEnv({ A: '1' })
    expect(copy).toEqual({ A: '1' })
    expect(Object.isFrozen(copy)).toBe(true)
  })

  it('rejects anything the OS would not accept as bad_request', () => {
    for (const bad of [
      null,
      [],
      'x',
      { A: 1 },
      { 'A=B': 'x' },
      { '': 'x' },
      { A: '\0' },
    ]) {
      expect(() => parseExtraEnv(bad)).toThrow(LlmError)
    }
  })
})
