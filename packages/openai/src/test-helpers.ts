/**
 * Shared test fixtures for `@gullabs/openai` tests: a context, a request
 * builder and the adapter wired to the real SDK over a stubbed `fetch`.
 * Documentation-derived (see `test-sse.ts`); nothing here is a capture.
 *
 * @module
 */

import type {
  AdapterCtx,
  Message,
  ModelDescriptor,
  ProviderAdapter,
  ResolvedRequest,
} from '@gullabs/core'

import { openaiAdapterWithSeams } from './adapter.js'
import { openaiRegistry } from './models.js'
import { stubFetch } from './test-sse.js'
import type { FetchCall } from './test-sse.js'

export const CTX: AdapterCtx = {
  auth: { apiKey: 'sk-test-doc-derived' },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
}

export const userText = (text: string): Message => ({
  role: 'user',
  parts: [{ kind: 'text', text }],
})

/** A request for `model` with its registered descriptor. */
export function request(
  model = 'gpt-6.2-sol',
  overrides: Partial<ResolvedRequest> = {},
): ResolvedRequest {
  return {
    provider: 'openai',
    model,
    messages: [userText('hello')],
    config: {},
    modelDescriptor: openaiRegistry.resolve('openai', model) as ModelDescriptor,
    ...overrides,
  }
}

/** The adapter over the real `openai` SDK whose `fetch` answers with `responders`. */
export function wiredAdapter(
  ...responders: Array<(call: FetchCall) => Response | Promise<Response>>
): { adapter: ProviderAdapter; calls: FetchCall[] } {
  const stub = stubFetch(...responders)
  return {
    adapter: openaiAdapterWithSeams(undefined, { fetch: stub.fetch }),
    calls: stub.calls,
  }
}
