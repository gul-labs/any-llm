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

if (failures.length > 0) {
  console.error(failures.map((f) => `  - ${f}`).join('\n'))
  throw new Error(`runtime smoke failed (${failures.length})`)
}
console.log('runtime smoke: ok')
