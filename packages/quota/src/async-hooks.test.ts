/**
 * A quota hook typed `=> void` may be `async`: its rejection must never be an
 * unhandled rejection (Node's default ends the process), and it must not
 * change what the quota decides.
 */

import { describe, expect, it } from 'vitest'
import { LlmError } from '@gullabs/core'
import {
  enforceProviderQuota,
  quotaPolicyForGemini,
  type QuotaStore,
  type QuotaStoreCheckInput,
  type QuotaStoreCheckResult,
} from './index.js'

const asyncThrow = async (): Promise<never> => {
  await Promise.resolve()
  throw new Error('hook boom')
}

async function unhandledDuring(run: () => Promise<unknown>): Promise<unknown[]> {
  const seen: unknown[] = []
  const on = (reason: unknown): void => {
    seen.push(reason)
  }
  process.on('unhandledRejection', on)
  try {
    await run().catch(() => {})
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
  } finally {
    process.off('unhandledRejection', on)
  }
  return seen
}

const policy = quotaPolicyForGemini({
  models: { 'gemini-2.5-flash': { rpm: 60, rpd: 2_000, tpm: 1_000 } },
})
const NOW = Date.UTC(2026, 5, 30, 12, 0, 0)

function store(result: QuotaStoreCheckResult, adjust: () => Promise<void>): QuotaStore {
  return {
    adjustTokens: adjust,
    checkAndConsume: (_input: QuotaStoreCheckInput) => Promise.resolve(result),
  }
}

describe('async quota hooks', () => {
  it('onEvent that rejects: the decision is unchanged and nothing is unhandled', async () => {
    let error: unknown
    const seen = await unhandledDuring(async () => {
      error = await enforceProviderQuota({
        onStoreError: 'fail-closed',
        provider: 'google',
        model: 'gemini-2.5-flash',
        policy,
        store: store({ rpm: { allowed: false, retryAfterMs: 1_500 } }, async () => {}),
        onEvent: asyncThrow as never,
        nowMs: NOW,
      }).catch((e: unknown) => e)
    })
    expect(seen).toEqual([])
    expect(error).toBeInstanceOf(LlmError)
    expect(error).toMatchObject({ kind: 'rate_limited', retryable: true })
  })

  it('onWindowChecksSkipped and onReconcileError that reject', async () => {
    let admission: Awaited<ReturnType<typeof enforceProviderQuota>> | undefined
    const seen = await unhandledDuring(async () => {
      // No store: the windows are skipped and the hook fires.
      await enforceProviderQuota({
        onStoreError: 'fail-closed',
        provider: 'google',
        model: 'gemini-2.5-flash',
        policy,
        onWindowChecksSkipped: asyncThrow as never,
        nowMs: NOW,
      } as unknown as Parameters<typeof enforceProviderQuota>[0])
      // A store whose token correction fails: the reconcile hook fires.
      admission = await enforceProviderQuota({
        onStoreError: 'fail-closed',
        provider: 'google',
        model: 'gemini-2.5-flash',
        policy,
        store: store({}, () => Promise.reject(new Error('adjust failed'))),
        estimatedInputTokens: 100,
        onReconcileError: asyncThrow as never,
        onEvent: asyncThrow as never,
        nowMs: NOW,
      })
      await admission.reconcile({
        inputTokens: 500,
        outputTokens: 1,
        details: {},
        raw: null,
      })
    })
    expect(seen).toEqual([])
  })
})
