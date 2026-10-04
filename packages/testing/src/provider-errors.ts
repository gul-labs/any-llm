/**
 * Routes provider-shaped errors through the real provider classifier.
 *
 * `fakeProviderError` marks the error it builds with the provider it belongs
 * to. A fake that stands in for a whole adapter (`FakeAdapter`,
 * `SignalAwareFakeAdapter`) or a whole client (`FakeClient`) throws what the
 * real one throws: the real adapter runs `classifyGoogleError` /
 * `classifyXaiError` on the SDK's error, so the fake does too, with the same
 * function from `@gullabs/google` / `@gullabs/xai` (optional peer dependencies,
 * loaded the first time a marked error is thrown). The SDK-level fakes
 * (`makeFakeGemini`, `makeFakeXai`, the store clients) keep throwing the raw SDK
 * error, because there the real adapter or store is the one that classifies it.
 *
 * @module
 */

import { LlmError, llmErrorOptionsOf } from '@gullabs/core'
import type { LlmErrorOptions } from '@gullabs/core'

/** The providers `fakeProviderError` builds errors for. */
type ErrorProvider = 'google' | 'xai'

const PROVIDER_MARK = Symbol.for('@gullabs/testing.provider-error')

const PACKAGES: Record<ErrorProvider, string> = {
  google: '@gullabs/google',
  xai: '@gullabs/xai',
}

const CLASSIFIERS: Record<ErrorProvider, string> = {
  google: 'classifyGoogleError',
  xai: 'classifyXaiError',
}

/** Marks `error` as the SDK error of `provider`'s scenario factory. Not enumerable. */
export function markProviderError<T extends Error>(error: T, provider: ErrorProvider): T {
  Object.defineProperty(error, PROVIDER_MARK, { value: provider })
  return error
}

function providerOf(error: unknown): ErrorProvider | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const mark = (error as Record<symbol, unknown>)[PROVIDER_MARK]
  return mark === 'google' || mark === 'xai' ? mark : undefined
}

const modules = new Map<string, Promise<Record<string, unknown>>>()

/**
 * Loads an optional peer package of this one. The specifier is not a literal,
 * so neither a bundler nor the type checker pulls the package in.
 */
export function loadPeer(id: string, forWhat: string): Promise<Record<string, unknown>> {
  let loaded = modules.get(id)
  if (loaded === undefined) {
    loaded = (import(/* @vite-ignore */ id) as Promise<Record<string, unknown>>).catch(
      (cause: unknown) => {
        modules.delete(id)
        throw new Error(
          `${forWhat} needs "${id}" (an optional peer dependency of @gullabs/testing): install it.`,
          { cause },
        )
      },
    )
    modules.set(id, loaded)
  }
  return loaded
}

/**
 * The provider's `LlmError` as this package's copy of core knows it. A
 * classifier loaded from a CommonJS build brings its own copy of `LlmError`,
 * and an `instanceof` against the host's copy would fail, so the fields are
 * carried over to this package's class (the peer `@gullabs/core` the host
 * shares).
 */
export function adopt(value: unknown): unknown {
  if (value instanceof LlmError) return value
  if (typeof value !== 'object' || value === null) return value
  const e = value as Partial<LlmError> & { message?: string }
  if (typeof e.kind !== 'string' || typeof e.retryable !== 'boolean') return value
  return new LlmError(e.message ?? '', llmErrorOptionsOf(e as LlmErrorOptions))
}

/** Whether `error` came from `fakeProviderError` (so it needs the provider's classifier). */
export function isProviderShaped(error: unknown): boolean {
  return providerOf(error) !== undefined
}

/**
 * What the real provider adapter throws for `error`: the provider's classifier
 * applied to an error `fakeProviderError` built, anything else unchanged (the
 * engine's own classification still applies to it, as it does to any adapter).
 */
export function classifyAsAdapter(error: unknown): Promise<unknown> {
  const provider = providerOf(error)
  return provider === undefined ? Promise.resolve(error) : classifyAs(provider, error)
}

/**
 * `error` through `provider`'s classifier, whatever it is: what a real
 * provider store (which classifies every SDK failure) throws for it.
 */
export async function classifyAs(
  provider: ErrorProvider,
  error: unknown,
): Promise<unknown> {
  const module = await loadPeer(
    PACKAGES[provider],
    `A "${provider}" error from fakeProviderError thrown by a fake adapter or client`,
  )
  const classify = module[CLASSIFIERS[provider]]
  if (typeof classify !== 'function') {
    throw new Error(
      `"${PACKAGES[provider]}" does not export ${CLASSIFIERS[provider]}: its version does not match @gullabs/testing.`,
    )
  }
  return adopt((classify as (raw: unknown) => unknown)(error))
}
