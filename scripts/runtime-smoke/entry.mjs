/**
 * Runs with every Node built-in blocked (see hooks.mjs) and, once the entry points are
 * loaded, with `Buffer` and `process` removed as well: the globals a runtime without
 * Node's built-ins does not have. It must not import anything from `node:`.
 */
const dist = (name) =>
  new URL(`../../packages/${name}/dist/index.js`, import.meta.url).href
const failures = []
const check = (ok, what) => {
  if (!ok) failures.push(what)
}

// Control: the hook really blocks built-ins.
let blocked = false
try {
  await import('node:crypto')
} catch {
  blocked = true
}
check(blocked, 'control: importing node:crypto must fail under the hook')

// Every runtime-agnostic entry point loads without a built-in.
const entries = {}
for (const name of ['core', 'google', 'xai', 'quota', 'drizzle', 'any-llm']) {
  try {
    entries[name] = await import(dist(name))
  } catch (error) {
    failures.push(
      `@gullabs/${name} did not load: ${String(error.message).split('\n')[0]}`,
    )
  }
}

delete globalThis.Buffer
delete globalThis.process

const core = entries.core
if (core !== undefined) {
  // A hash that agrees with the FIPS 180-4 vector, with no node:crypto and no Buffer.
  check(
    core.sha256Hex('abc') ===
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'sha256Hex("abc")',
  )
  check(core.canonicalJson({ b: 1, a: [2] }) === '{"a":[2],"b":1}', 'canonicalJson')

  // A whole call: default id generator (globalThis.crypto.randomUUID), the engine, and a
  // payload that hashes an inline media part.
  const { z } = await import(
    new URL('../../packages/core/node_modules/zod/index.js', import.meta.url).href
  )
  const schema = z.strictObject({})
  const descriptor = {
    provider: 'smoke',
    model: 'smoke-1',
    limits: { contextWindow: 1000, maxOutputTokens: 100 },
    configSchema: schema,
    configKeys: core.toConfigKeys(schema),
    configJsonSchema: core.toConfigJsonSchema(schema),
    validateConfig: core.zodToStandardSchema(schema),
  }
  const adapter = {
    id: 'smoke',
    async run() {
      return {
        message: { role: 'assistant', parts: [{ kind: 'text', text: 'ok' }] },
        text: 'ok',
        model: 'smoke-1',
        usage: { inputTokens: 1, outputTokens: 1, details: {}, raw: null },
        warnings: [],
      }
    },
  }
  const records = []
  const client = core.createClient({
    adapters: [adapter],
    modelRegistry: core.createModelRegistry([descriptor]),
    sink: {
      acceptsPayloads: true,
      async record(record, extra) {
        records.push({ record, payload: extra?.payload })
      },
    },
    payloads: {},
  })
  const result = await client.generate(
    {
      provider: 'smoke',
      model: 'smoke-1',
      messages: [
        {
          role: 'user',
          parts: [
            { kind: 'text', text: 'hi' },
            { kind: 'inline-media', mimeType: 'image/png', data: 'YWJj' },
          ],
        },
      ],
    },
    { auth: { apiKey: 'test' } },
  )
  check(result.text === 'ok', 'generate() returned the adapter text')
  const row = records[0]
  check(row !== undefined, 'the sink received the record')
  check(
    /^[0-9a-f-]{36}$/.test(row?.record.callId ?? ''),
    'the default id generator produced a UUID',
  )
  const media = row?.payload?.request.messages[0]?.parts[1]
  check(
    media?.sha256 === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'the payload hashed the inline media ("abc")',
  )
}

// One fake-backed call per provider adapter, quota store and sink, with no built-ins and
// no `Buffer` or `process`: the adapters' own code runs (base64 size checks, UTF-8 sizing,
// thought-signature hashing, the drizzle row mapping), not just their import.
const PNG_PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const userMessage = {
  role: 'user',
  parts: [
    { kind: 'text', text: 'Describe this \u{1F600} image.' },
    { kind: 'inline-media', mimeType: 'image/png', data: PNG_PIXEL },
  ],
}

async function attempt(what, body) {
  try {
    await body()
  } catch (error) {
    failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const calls = []
// A structural stand-in for a Drizzle Postgres database: it records the rows.
const fakeDb = (() => {
  const handle = () => ({
    insert(table) {
      return {
        values(values) {
          return {
            async onConflictDoNothing() {
              calls.push({ table, values })
            },
          }
        },
      }
    },
    async execute() {},
  })
  return {
    ...handle(),
    async transaction(fn) {
      return fn(handle())
    },
  }
})()

if (core !== undefined) {
  const { geminiAdapter, geminiModelDescriptors, geminiPricingSource } =
    entries.google ?? {}
  await attempt('google: a fake-backed generate()', async () => {
    check(geminiAdapter !== undefined, '@gullabs/google exports geminiAdapter')
    const requests = []
    const adapter = geminiAdapter({
      client: {
        models: {
          async generateContent(params) {
            requests.push(params)
            return {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [{ text: 'a pixel', thoughtSignature: 'c2lnbmF0dXJl' }],
                  },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: {
                promptTokenCount: 12,
                candidatesTokenCount: 3,
                totalTokenCount: 15,
              },
              modelVersion: 'gemini-3.8-flash',
            }
          },
          async countTokens() {
            return { totalTokens: 12 }
          },
        },
      },
    })
    const descriptor = geminiModelDescriptors.find((d) => d.model === 'gemini-3.8-flash')
    const client = core.createClient({
      adapters: [adapter],
      modelRegistry: core.createModelRegistry([descriptor]),
      pricingSources: [geminiPricingSource()],
      sink: entries.drizzle.drizzleUsageSink({ db: fakeDb }),
      payloads: {},
    })
    const result = await client.generate(
      {
        provider: 'google',
        model: 'gemini-3.8-flash',
        system: 'Be brief é.',
        messages: [userMessage],
      },
      { auth: { apiKey: 'test' } },
    )
    check(result.text === 'a pixel', 'google: the adapter returned the text')
    check(requests.length === 1, 'google: the fake client saw one request')
    check(
      result.transientProviderState?.google?.signatures?.[0]?.partSha256?.length === 64,
      'google: the thought signature was pinned with a sha256',
    )
    check(
      calls.some((c) => c.values.provider === 'google'),
      'drizzle: the ledger row reached the fake database',
    )
    check(
      calls.some((c) => c.values.request !== undefined),
      'drizzle: the payload row reached the fake database',
    )
  })

  const { xaiAdapter, xaiModelDescriptors, xaiPricingSource } = entries.xai ?? {}
  await attempt('xai: a fake-backed generate()', async () => {
    check(xaiAdapter !== undefined, '@gullabs/xai exports xaiAdapter')
    const requests = []
    const adapter = xaiAdapter({
      client: {
        responses: {
          async create(params) {
            requests.push(params)
            return {
              id: 'resp_smoke',
              model: 'grok-4.5',
              status: 'completed',
              incomplete_details: null,
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'a pixel' }],
                },
              ],
              usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
            }
          },
        },
      },
    })
    const descriptor = xaiModelDescriptors.find((d) => d.model === 'grok-4.5')
    const client = core.createClient({
      adapters: [adapter],
      modelRegistry: core.createModelRegistry([descriptor]),
      pricingSources: [xaiPricingSource()],
    })
    const result = await client.generate(
      { provider: 'xai', model: 'grok-4.5', messages: [userMessage] },
      { auth: { apiKey: 'test' } },
    )
    check(result.text === 'a pixel', 'xai: the adapter returned the text')
    check(requests.length === 1, 'xai: the fake client saw one request')
    // The image-size check ran on the real decoder: an over-20-MiB image is rejected.
    const huge = 'A'.repeat(Math.ceil(((20 * 1024 * 1024 + 3) * 4) / 3 / 4) * 4)
    let rejected = false
    try {
      await client.generate(
        {
          provider: 'xai',
          model: 'grok-4.5',
          messages: [
            {
              role: 'user',
              parts: [{ kind: 'inline-media', mimeType: 'image/png', data: huge }],
            },
          ],
        },
        { auth: { apiKey: 'test' } },
      )
    } catch (error) {
      rejected = error?.kind === 'bad_request'
    }
    check(rejected, 'xai: an inline image over 20 MiB is rejected as bad_request')
  })
}

const quota = entries.quota
if (quota !== undefined) {
  await attempt('quota: a store check', async () => {
    const store = quota.inMemoryQuotaStore()
    const nowMs = Date.now()
    const first = await store.checkAndConsume({
      scope: 'smoke',
      nowMs,
      rpm: 1,
      rpd: 5,
      dayBoundary: { timeZone: 'America/Los_Angeles' },
    })
    const second = await store.checkAndConsume({ scope: 'smoke', nowMs, rpm: 1 })
    check(first.rpm?.allowed === true, 'quota: the first call is admitted')
    check(
      second.rpm?.allowed === false,
      'quota: the second call in the minute is refused',
    )
  })
}

if (failures.length > 0) {
  console.error(failures.map((f) => `  - ${f}`).join('\n'))
  throw new Error(`runtime smoke failed (${failures.length})`)
}
console.log('runtime smoke: ok')
