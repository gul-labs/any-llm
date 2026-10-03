/**
 * examples/basic.ts — network-free runnable example for any-llm.
 *
 * Demonstrates all four v1 goals without touching the network:
 *   1. Gemini Flex call via geminiAdapter (injected fake client)
 *   2. Token usage capture (input / output / cached / thinking)
 *   3. Thinking text capture (reasoningText) via includeThoughts
 *   4. Cost tracking in micro-USD, frozen in the persisted record
 *
 * Run with:  pnpm example
 */

import { createClient, geminiPricingSource, defineCallSite } from '@gullabs/core'
import type { JsonValue } from '@gullabs/core'
import { geminiAdapter } from '@gullabs/google'
import {
  FakeClock,
  FakeIds,
  RecordingSink,
  fakeGeminiResponse,
  makeFakeGemini,
} from '@gullabs/testing'

// ---------------------------------------------------------------------------
// 1. Define the output JSON Schema
// ---------------------------------------------------------------------------

const ReviewJsonSchema: JsonValue = {
  type: 'object',
  properties: {
    rating: { type: 'number' },
    summary: { type: 'string' },
  },
  required: ['rating', 'summary'],
}

// ---------------------------------------------------------------------------
// 2. Build a fake Gemini client (no network — scripted response)
//    The response includes:
//      - a thought part (thought: true) → captured as reasoningText
//      - a JSON text part matching ReviewJsonSchema → parsed by the adapter
//      - usageMetadata with thoughtsTokenCount → captured as thinkingTokens
// ---------------------------------------------------------------------------

const fakeJson = JSON.stringify({
  rating: 4,
  summary: 'Clear and efficient implementation with good test coverage.',
})

const fakeClient = makeFakeGemini(
  fakeGeminiResponse({
    structuredJson: fakeJson,
    thoughtText:
      'The diff replaces a mutable `let` with a `const` — a valid, low-risk improvement. ' +
      'Rating: 4/5. No functional change; style only.',
    promptTokenCount: 512,
    candidatesTokenCount: 48,
    thoughtsTokenCount: 128,
    cachedContentTokenCount: 64,
    totalTokenCount: 688,
    finishReason: 'STOP',
    modelVersion: 'gemini-2.5-flash-002',
    responseId: 'resp-example-001',
  }),
)

// ---------------------------------------------------------------------------
// 3. Wire up the client with fakes for deterministic output
// ---------------------------------------------------------------------------

const sink = new RecordingSink()
const clock = new FakeClock(1_700_000_000_000) // fixed timestamp
const ids = new FakeIds()

const client = createClient({
  adapters: [geminiAdapter({ client: fakeClient })],
  pricingSources: { google: geminiPricingSource() },
  sink,
  clock,
  ids,
})

// ---------------------------------------------------------------------------
// 4. Define a call site — reusable prompt template with JSON Schema + reasoning
// ---------------------------------------------------------------------------

const codeReview = defineCallSite({
  id: 'code-review',
  provider: 'google',
  model: 'gemini-2.5-flash',
  jsonSchema: ReviewJsonSchema,
  system: 'You are a senior code reviewer. Be concise and fair.',
  userTemplate: 'Review this code change:\n\n```diff\n{{diff}}\n```',
  config: {
    reasoning: { includeThoughts: true, effort: 'medium' },
    temperature: 0.2,
  },
})

// ---------------------------------------------------------------------------
// 5. Run it — no await at top level needed in modern Node (>= 20)
// ---------------------------------------------------------------------------

const result = await client.runStructured(
  codeReview,
  { diff: '- let x = 1\n+ const x = 1' },
  {
    auth: { apiKey: 'fake-api-key' },
  },
)

console.log('\n========================================')
console.log('  any-llm  —  examples/basic.ts output')
console.log('========================================\n')

console.log('Structured output (JSON-parsed; caller validates):')
console.log(result.output)
console.log('outputParsed:', result.outputParsed)

console.log('\nToken usage (GROSS convention):')
console.log({
  inputTokens: result.usage.inputTokens, // 512  (gross; includes cached)
  outputTokens: result.usage.outputTokens, // 176  (gross; candidates 48 + thoughts 128)
  cachedInputTokens: result.usage.cachedInputTokens, // 64 (subset of input)
  thinkingTokens: result.usage.thinkingTokens, // 128 (subset of output; no extra cost lane)
})

console.log('\nCost (frozen micro-USD):')
console.log({
  microUsd: result.cost?.microUsd, // integer µUSD
  pricingVersion: result.cost?.pricingVersion,
  details: result.cost?.details, // { input, cached, output } — must sum to microUsd
})

console.log('\nReasoning text (thought summary):')
console.log(result.reasoningText)

const record = sink.last()
console.log('\nPersisted LlmCallRecord (subset):')
console.log({
  callId: record?.callId,
  attemptId: record?.attemptId,
  callSiteId: record?.callSiteId,
  status: record?.status,
  model: record?.model,
  modelVersion: record?.modelVersion,
  serviceTier: record?.serviceTier,
  inputTokens: record?.inputTokens,
  outputTokens: record?.outputTokens,
  thinkingTokens: record?.thinkingTokens,
  cachedInputTokens: record?.cachedInputTokens,
  costMicroUsd: record?.costMicroUsd,
  pricingVersion: record?.pricingVersion,
  reasoningText: record?.reasoningText,
  createdAt: record?.createdAt,
})

console.log('\n========================================\n')

// ---------------------------------------------------------------------------
// REAL GEMINI CALL — uncomment to use with a live API key and a Drizzle DB
// ---------------------------------------------------------------------------
//
// import { drizzleUsageSink, llmCalls } from '@gullabs/drizzle'
// import { drizzle } from 'drizzle-orm/node-postgres'
// import pg from 'pg'
//
// const db = drizzle(new pg.Pool({ connectionString: process.env.DATABASE_URL }))
//
// const realClient = createClient({
//   adapters: [geminiAdapter()],          // uses real @google/genai SDK
//   pricingSources: { google: geminiPricingSource() },
//   sink: drizzleUsageSink({ db }),       // writes to your llm_calls table
// })
//
// const realResult = await realClient.runStructured(codeReview, { diff: '- let x = 1\n+ const x = 1' }, {
//   auth: { apiKey: process.env.GEMINI_API_KEY! }, // pass per-call — never read from env internally
// })
// console.log('Real output:', realResult.output)
// console.log('Real cost (µUSD):', realResult.cost?.microUsd)
