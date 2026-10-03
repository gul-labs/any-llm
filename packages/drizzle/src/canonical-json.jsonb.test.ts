/**
 * canonicalJson over a real Postgres `jsonb` column (PGlite).
 *
 * `jsonb` does not keep key order (it stores shorter keys first, then
 * bytewise), so a history a host stores and reloads comes back with its keys
 * reordered. RFC 8785 canonical JSON is what keeps a hash taken before storing
 * equal to the one taken after loading.
 */
import { PGlite } from '@electric-sql/pglite'
import { canonicalJson } from '@gullabs/core'
import type { JsonValue } from '@gullabs/core'
import { describe, expect, it } from 'vitest'

describe('canonicalJson across a Postgres jsonb round trip', () => {
  it('is identical before and after jsonb reorders object keys', async () => {
    const history: JsonValue = [
      {
        role: 'assistant',
        parts: [
          {
            kind: 'tool-call',
            toolCallId: 'call_get_weather_1',
            toolName: 'get_weather',
            args: {
              units: 'metric',
              city: 'Lisbon',
              'a-longer-key': [1, 2.5, { z: 1, a: 0 }],
            },
          },
          { kind: 'text', text: 'café \u{1f600} €' },
        ],
      },
    ]
    const overlay: JsonValue = {
      google: {
        signatures: [
          {
            messageIndex: 0,
            partIndex: 0,
            model: 'gemini-3.1-flash-lite',
            partSha256: 'a'.repeat(64),
            signature: 'c2lnbmF0dXJl',
          },
        ],
      },
    }

    const db = new PGlite()
    await db.exec('CREATE TABLE t (id int PRIMARY KEY, history jsonb, state jsonb)')
    await db.query('INSERT INTO t VALUES (1, $1::jsonb, $2::jsonb)', [
      JSON.stringify(history),
      JSON.stringify(overlay),
    ])
    const { rows } = await db.query<{ history: JsonValue; state: JsonValue }>(
      'SELECT history, state FROM t WHERE id = 1',
    )
    const loaded = rows[0]!

    // jsonb really did reorder the keys, so plain stringification is not stable...
    expect(JSON.stringify(loaded.history)).not.toBe(JSON.stringify(history))
    // ...and canonical JSON is.
    expect(canonicalJson(loaded.history)).toBe(canonicalJson(history))
    expect(canonicalJson(loaded.state)).toBe(canonicalJson(overlay))
  })
})
