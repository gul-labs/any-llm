import { describe, expect, it } from 'vitest'
import {
  nextFallbackToolCallId,
  reserveProviderToolCallIds,
  resolveToolCallId,
} from './tool-call-id.js'

describe('reserveProviderToolCallIds', () => {
  it('keeps only non-empty strings', () => {
    expect(
      reserveProviderToolCallIds([undefined, '', 'fc_1', 'anyllm_call_lookup_1']),
    ).toEqual(new Set(['fc_1', 'anyllm_call_lookup_1']))
  })
})

describe('nextFallbackToolCallId', () => {
  it('skips reserved provider ids', () => {
    const counters = new Map<string, number>()
    const reserved = new Set(['anyllm_call_lookup_1'])
    expect(nextFallbackToolCallId('lookup', counters, reserved)).toBe(
      'anyllm_call_lookup_2',
    )
  })
})

describe('resolveToolCallId', () => {
  it('uses the provider id when present', () => {
    const counters = new Map<string, number>()
    expect(resolveToolCallId('fc_1', 'lookup', counters, new Set())).toBe('fc_1')
    expect(counters.size).toBe(0)
  })

  it('does not reuse a reserved provider-shaped fallback', () => {
    const counters = new Map<string, number>()
    const reserved = reserveProviderToolCallIds(['anyllm_call_lookup_1'])
    expect(resolveToolCallId('anyllm_call_lookup_1', 'lookup', counters, reserved)).toBe(
      'anyllm_call_lookup_1',
    )
    expect(resolveToolCallId(undefined, 'lookup', counters, reserved)).toBe(
      'anyllm_call_lookup_2',
    )
  })
})
