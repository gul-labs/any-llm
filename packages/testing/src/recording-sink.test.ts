import { describe, it, expect } from 'vitest'
import { RecordingSink } from './recording-sink.js'
import type { LlmCallRecord } from '@gullabs/core'

function makeRecord(overrides: Partial<LlmCallRecord> = {}): LlmCallRecord {
  return {
    recordSchemaVersion: 2,
    callId: 'call_1',
    attemptId: 'attempt_1',
    attemptNumber: 1,
    provider: 'google',
    model: 'gemini-2.5-pro',
    status: 'ok',
    latencyMs: 123,
    tokenDetails: {},
    rawUsage: {},
    generationConfig: {},
    metadata: {},
    createdAt: new Date(0).toISOString(),
    inputTokens: 10,
    outputTokens: 5,
    ...overrides,
  }
}

describe('RecordingSink', () => {
  it('starts with an empty records array', () => {
    const sink = new RecordingSink()
    expect(sink.records).toEqual([])
  })

  it('captures a record on record()', async () => {
    const sink = new RecordingSink()
    const r = makeRecord()
    await sink.record(r)
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toBe(r)
  })

  it('accumulates multiple records in insertion order', async () => {
    const sink = new RecordingSink()
    const r1 = makeRecord({ callId: 'call_1' })
    const r2 = makeRecord({ callId: 'call_2' })
    const r3 = makeRecord({ callId: 'call_3' })
    await sink.record(r1)
    await sink.record(r2)
    await sink.record(r3)
    expect(sink.records.map((r) => r.callId)).toEqual(['call_1', 'call_2', 'call_3'])
  })

  it('last() returns undefined when no records have been captured', () => {
    const sink = new RecordingSink()
    expect(sink.last()).toBeUndefined()
  })

  it('last() returns the most recently captured record', async () => {
    const sink = new RecordingSink()
    await sink.record(makeRecord({ callId: 'call_1' }))
    await sink.record(makeRecord({ callId: 'call_2' }))
    expect(sink.last()?.callId).toBe('call_2')
  })

  describe('failOnRecord: true', () => {
    it('throws a generic Error and does NOT store the record', async () => {
      const sink = new RecordingSink({ failOnRecord: true })
      await expect(sink.record(makeRecord())).rejects.toThrow('RecordingSink')
      expect(sink.records).toHaveLength(0)
    })
  })

  describe('failOnRecord: Error instance', () => {
    it('throws the exact provided Error', async () => {
      const err = new Error('sink boom')
      const sink = new RecordingSink({ failOnRecord: err })
      await expect(sink.record(makeRecord())).rejects.toThrow('sink boom')
      expect(sink.records).toHaveLength(0)
    })

    it('throws the same Error instance (not a copy)', async () => {
      const err = new TypeError('exact error')
      const sink = new RecordingSink({ failOnRecord: err })
      let caught: unknown
      try {
        await sink.record(makeRecord())
      } catch (e) {
        caught = e
      }
      expect(caught).toBe(err)
    })
  })

  it('satisfies the UsageSink interface structurally', () => {
    const sink: import('@gullabs/core').UsageSink = new RecordingSink()
    expect(typeof sink.record).toBe('function')
  })
})
