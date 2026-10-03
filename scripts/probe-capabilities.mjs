/**
 * probe-capabilities.mjs — MANUAL dev tool, NOT part of CI.
 *
 * Probes live Gemini API capabilities for all registered descriptors and
 * compares results against declared descriptor fields, flagging mismatches.
 *
 * IMPORTANT: This script costs real API tokens. Use a FREE-TIER key.
 * Paid-only models (e.g. gemini-2.5-pro) are skipped by default unless
 * PROBE_INCLUDE_PAID=1 is set.
 *
 * HOW TO RUN (from repo root):
 *   GEMINI_API_KEY=<your-key> pnpm --filter @gullabs/any-llm exec node ../../scripts/probe-capabilities.mjs
 *
 * Or from packages/any-llm:
 *   GEMINI_API_KEY=<your-key> node ../../scripts/probe-capabilities.mjs
 *
 * ENV FLAGS:
 *   GEMINI_API_KEY     — required
 *   PROBE_INCLUDE_PAID — set to 1 to probe paid-only models (extra cost)
 */

import { GoogleGenAI } from '@google/genai'
import { geminiModelDescriptors, gemmaModelDescriptors } from '@gullabs/google'

// ---------------------------------------------------------------------------
// Cost guard: models with NO free-tier quota
// ---------------------------------------------------------------------------
const FREE_TIER_UNAVAILABLE = new Set(['gemini-2.5-pro'])

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const TINY_PROMPT = 'Reply with: ok'
const MAX_OUTPUT_TOKENS = 8
const PACE_MS = 1500

if (process.env['CI'] || process.env['GITHUB_ACTIONS']) {
  console.error('ERROR: this script makes billed live calls and never runs in CI.')
  process.exit(2)
}

const apiKey = process.env['GEMINI_API_KEY']
if (!apiKey) {
  console.error('ERROR: GEMINI_API_KEY is not set.')
  process.exit(1)
}

const includePaid = process.env['PROBE_INCLUDE_PAID'] === '1'
const ai = new GoogleGenAI({ apiKey })

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function withRetry(fn, label) {
  const delays = [2000, 5000, 12000]
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const status = err?.status ?? err?.httpErrorCode ?? 0
      const retryable = status === 429 || status === 503 || status === 500
      if (retryable && attempt < delays.length) {
        const wait = delays[attempt]
        console.log(`  [${label}] transient ${status}, retrying in ${wait}ms…`)
        await sleep(wait)
      } else {
        throw err
      }
    }
  }
}

async function call(modelId, config, contents) {
  return ai.models.generateContent({
    model: modelId,
    config,
    contents: contents ?? [{ role: 'user', parts: [{ text: TINY_PROMPT }] }],
  })
}

// ---------------------------------------------------------------------------
// Individual probes — each returns { ok: boolean, detail?: string }
// ---------------------------------------------------------------------------
async function probeBaseline(modelId) {
  try {
    await withRetry(
      () => call(modelId, { maxOutputTokens: MAX_OUTPUT_TOKENS }),
      'baseline',
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err) }
  }
}

async function probeTemperature(modelId, sampling) {
  if (sampling !== 'tunable') return { ok: false, detail: 'fixed sampling — skipped' }
  try {
    await withRetry(
      () => call(modelId, { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.5 }),
      'temperature',
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err) }
  }
}

async function probeReasoningBudget(modelId) {
  try {
    await withRetry(
      () =>
        call(modelId, {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          thinkingConfig: { thinkingBudget: 512, includeThoughts: false },
        }),
      'reasoning-budget',
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err) }
  }
}

async function probeReasoningLevel(modelId) {
  const levels = ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']
  const results = {}
  for (const level of levels) {
    await sleep(PACE_MS)
    try {
      await withRetry(
        () =>
          call(modelId, {
            maxOutputTokens: MAX_OUTPUT_TOKENS,
            thinkingConfig: { thinkingLevel: level },
          }),
        `level-${level}`,
      )
      results[level] = 'ok'
    } catch (err) {
      const status = err?.status ?? err?.httpErrorCode ?? 0
      results[level] = `err-${status}`
    }
  }
  return {
    ok: results['LOW'] === 'ok' || results['HIGH'] === 'ok',
    detail: JSON.stringify(results),
  }
}

async function probeServiceTierFlex(modelId) {
  try {
    await withRetry(
      () =>
        call(modelId, {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          // @ts-ignore — JS probe, not typed
          serviceTier: 'flex',
        }),
      'flex-tier',
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err) }
  }
}

async function probeNativeStructuredOutput(modelId) {
  try {
    await withRetry(
      () =>
        call(modelId, {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseMimeType: 'application/json',
          responseJsonSchema: {
            type: 'object',
            properties: { answer: { type: 'string' } },
            required: ['answer'],
          },
        }),
      'native-json',
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err) }
  }
}

async function probeGrounding(modelId) {
  try {
    await withRetry(
      () =>
        call(modelId, {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          tools: [{ googleSearch: {} }],
        }),
      'grounding',
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err) }
  }
}

async function probeVision(modelId) {
  // 1×1 transparent PNG, base64-encoded
  const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  try {
    await withRetry(
      () =>
        call(modelId, { maxOutputTokens: MAX_OUTPUT_TOKENS }, [
          {
            role: 'user',
            parts: [
              { text: 'What color is this image?' },
              { inlineData: { mimeType: 'image/png', data: TINY_PNG_B64 } },
            ],
          },
        ]),
      'vision',
    )
    return { ok: true }
  } catch (err) {
    return { ok: false, detail: String(err?.message ?? err) }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const allDescriptors = [...geminiModelDescriptors, ...gemmaModelDescriptors]

console.log('='.repeat(70))
console.log('  Gemini capability probe — manual tool, NOT CI')
console.log('='.repeat(70))

const skipped = []
const probeQueue = []

for (const d of allDescriptors) {
  if (FREE_TIER_UNAVAILABLE.has(d.model) && !includePaid) {
    skipped.push(d.model)
  } else {
    probeQueue.push(d)
  }
}

if (skipped.length > 0) {
  console.log(`\nSKIPPED (no free-tier quota): ${skipped.join(', ')}`)
  console.log('  → set PROBE_INCLUDE_PAID=1 to include\n')
}

const allResults = []

for (const d of probeQueue) {
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`MODEL: ${d.model}`)
  console.log(`${'─'.repeat(60)}`)

  const cap = d.capabilities ?? {}

  // Baseline
  console.log('  probe: baseline…')
  const baseline = await withRetry(() => probeBaseline(d.model), 'baseline').catch(
    (e) => ({
      ok: false,
      detail: String(e),
    }),
  )
  if (!baseline.ok) {
    console.log(`  BASELINE FAIL: ${baseline.detail ?? ''}`)
    allResults.push({ id: d.model, skipped: false, baselineFailed: true })
    await sleep(PACE_MS)
    continue
  }
  console.log('  baseline: ok')

  await sleep(PACE_MS)

  const modelResults = { id: d.model, skipped: false, baselineFailed: false, probes: {} }

  // Temperature
  console.log('  probe: temperature…')
  const tempResult = await probeTemperature(d.model, cap.sampling)
  modelResults.probes.temperature = tempResult
  console.log(
    `  temperature: ${tempResult.ok ? 'ok' : `skip/fail — ${tempResult.detail ?? ''}`}`,
  )
  await sleep(PACE_MS)

  // Reasoning
  if (cap.reasoningApi === 'budget') {
    console.log('  probe: reasoning (budget)…')
    const rr = await probeReasoningBudget(d.model)
    modelResults.probes.reasoningBudget = rr
    console.log(`  reasoning-budget: ${rr.ok ? 'ok' : `fail — ${rr.detail ?? ''}`}`)
    await sleep(PACE_MS)
  } else if (cap.reasoningApi === 'level') {
    console.log('  probe: reasoning (level)…')
    const rr = await probeReasoningLevel(d.model)
    modelResults.probes.reasoningLevel = rr
    console.log(`  reasoning-level: ${rr.detail ?? ''}`)
    await sleep(PACE_MS)
  }

  // Flex tier
  if (cap.serviceTiers?.includes('flex')) {
    console.log('  probe: flex tier…')
    const fr = await probeServiceTierFlex(d.model)
    modelResults.probes.flexTier = fr
    console.log(`  flex-tier: ${fr.ok ? 'ok' : `fail — ${fr.detail ?? ''}`}`)
    await sleep(PACE_MS)
  }

  // Native structured output
  console.log('  probe: native structured output…')
  const nso = await probeNativeStructuredOutput(d.model)
  modelResults.probes.nativeStructuredOutput = nso
  console.log(`  native-json: ${nso.ok ? 'ok' : `fail — ${nso.detail ?? ''}`}`)
  await sleep(PACE_MS)

  // Grounding
  console.log('  probe: grounding…')
  const gr = await probeGrounding(d.model)
  modelResults.probes.grounding = gr
  console.log(`  grounding: ${gr.ok ? 'ok' : `fail — ${gr.detail ?? ''}`}`)
  await sleep(PACE_MS)

  // Vision
  console.log('  probe: vision…')
  const vis = await probeVision(d.model)
  modelResults.probes.vision = vis
  console.log(`  vision: ${vis.ok ? 'ok' : `fail — ${vis.detail ?? ''}`}`)

  allResults.push(modelResults)
  await sleep(PACE_MS)
}

// ---------------------------------------------------------------------------
// Summary + mismatch detection
// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(70))
console.log('  SUMMARY + MISMATCH REPORT')
console.log('='.repeat(70))

for (const r of allResults) {
  if (r.skipped) continue
  console.log(`\nMODEL: ${r.id}`)

  if (r.baselineFailed) {
    console.log('  MISMATCH: baseline call FAILED — model may be unavailable')
    continue
  }

  const d = allDescriptors.find((x) => x.model === r.id)
  const cap = d?.capabilities ?? {}
  const p = r.probes ?? {}

  // Sampling
  if (cap.sampling === 'tunable') {
    const got = p.temperature?.ok ?? false
    if (!got)
      console.log('  MISMATCH: declared sampling=tunable but temperature was rejected')
    else console.log('  sampling=tunable: ok')
  }

  // Reasoning
  if (cap.reasoningApi === 'budget') {
    const got = p.reasoningBudget?.ok ?? false
    if (!got)
      console.log(
        `  MISMATCH: declared reasoningApi=budget but thinkingBudget failed — ${
          p.reasoningBudget?.detail ?? ''
        }`,
      )
    else console.log('  reasoningApi=budget: ok')
  } else if (cap.reasoningApi === 'level') {
    const det = p.reasoningLevel?.detail ?? '{}'
    console.log(`  reasoningApi=level results: ${det}`)
  }

  // Flex tier
  if (cap.serviceTiers?.includes('flex')) {
    const got = p.flexTier?.ok ?? false
    if (!got)
      console.log(
        `  MISMATCH: declared serviceTiers includes flex but flex probe failed — ${
          p.flexTier?.detail ?? ''
        }`,
      )
    else console.log('  flex tier: ok')
  }

  // Native structured output
  if (cap.nativeStructuredOutput) {
    const got = p.nativeStructuredOutput?.ok ?? false
    if (!got)
      console.log(
        `  MISMATCH: declared nativeStructuredOutput=true but native JSON probe failed — ${
          p.nativeStructuredOutput?.detail ?? ''
        }`,
      )
    else console.log('  nativeStructuredOutput: ok')
  } else {
    if (p.nativeStructuredOutput?.ok)
      console.log(
        '  MISMATCH: native structured output succeeded but not declared in descriptor',
      )
  }

  // Grounding
  if (cap.grounding) {
    const got = p.grounding?.ok ?? false
    if (!got)
      console.log(
        `  MISMATCH: declared grounding=true but grounding probe failed — ${
          p.grounding?.detail ?? ''
        }`,
      )
    else console.log('  grounding: ok')
  } else {
    if (p.grounding?.ok)
      console.log('  MISMATCH: grounding succeeded but not declared in descriptor')
  }

  // Vision: `capabilities.inputMimeTypes` is the one statement of media support
  // (there is no `vision` flag).
  const declaresImages = (cap.inputMimeTypes ?? []).some(
    (t) => t === 'image/*' || t === 'image/png',
  )
  if (declaresImages) {
    const got = p.vision?.ok ?? false
    if (!got)
      console.log(
        `  MISMATCH: inputMimeTypes admits image/png but the vision probe failed — ${
          p.vision?.detail ?? ''
        }`,
      )
    else console.log('  vision: ok')
  } else {
    if (p.vision?.ok)
      console.log(
        '  MISMATCH: vision succeeded but inputMimeTypes does not admit image/png',
      )
  }
}

console.log('\n' + '='.repeat(70))
console.log('  Probe complete.')
console.log('='.repeat(70))
