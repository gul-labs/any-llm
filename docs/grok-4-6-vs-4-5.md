# Grok 4.6 vs Grok 4.5

Status: research snapshot, not an implementation plan and not a host-product
decision. Captured **2026-08-12**, the day xAI announced Grok 4.6.

This note is for `@gullabs/xai` maintainers. It records what changed in the
provider surface so a later model-descriptor / pricing / config-schema change
can be live-verified instead of guessed. **Whether any host application
should flip production traffic is out of scope here** — that is a host
decision.

## Current library fact (landed 2026-08-12)

`@gullabs/xai` registers two canonical models: `grok-4.5` and `grok-4.6`.
No aliases. Adding 4.6 was a new `ModelDescriptor` + pricing key + live
verification, not a rename of 4.5.

- Canonical ids only. Aliases (`grok-4.5-latest`, `grok-build-latest`) are
  rejected (reject-don't-map).
- `grok-4.5` schema admits `reasoning.effort` `'low' | 'medium' | 'high'`
  (live-verified 2026-08-24). `'none'` and `'xhigh'` stay rejected.
- `grok-4.6` admits `low|medium|high|xhigh` and `serviceTier: 'priority'`
  only. `'none'` and `'flex'` are rejected.
- Pricing snapshot `xai-2026-08-24`: 4.5 $2 / $0.30 cached / $6 (<200k)
  and $4 / $0.60 / $12 (≥200k); 4.6 $2 / $0.50 / $6 and $4 / $1 / $12.
  `grok-4.5` admits `serviceTier: 'priority'` at 2×.
  Priority is 2×, confirmed by live `cost_in_usd_ticks` on fixture 12.
  List rates pinned to `__fixtures__/14-v1-models-pricing.json`.

### Library fact as of launch-day research (pre-implementation)

These bullets are the day-of-launch snapshot this note originally recorded.
They are **not** current library behavior.

- Config schema admits `reasoning.effort` of `'low' | 'high'` only —
  live-verified 2026-07-09. `'none'`, `'medium'`, and `'xhigh'` were
  rejected by the live 4.5 API.
- `serviceTier` is rejected (`bad_request`). Pricing snapshot
  `xai-2026-07-09` prices `grok-4.5` at $2 / $0.50 cached / $6 (≤200k
  gross input) and $4 / $1 / $12 (>200k).
- Passing `model: 'grok-4.6'` resolves to **model not found**. There is
  no silent alias and there must not be one.

## Sources

Primary (own the numbers):

| Source                                              | URL                                                            |
| --------------------------------------------------- | -------------------------------------------------------------- |
| Grok 4.6 announcement (2026-08-12)                  | https://x.ai/news/grok-4-6                                     |
| Grok 4.5 announcement (2026-07-16; API ~2026-07-08) | https://x.ai/news/grok-4-5                                     |
| Models overview                                     | https://docs.x.ai/developers/models                            |
| Grok 4.6 model page                                 | https://docs.x.ai/developers/models/grok-4.6                   |
| Grok 4.5 model page                                 | https://docs.x.ai/developers/models/grok-4.5                   |
| Pricing                                             | https://docs.x.ai/developers/pricing                           |
| Reasoning                                           | https://docs.x.ai/developers/model-capabilities/text/reasoning |
| Release notes                                       | https://docs.x.ai/developers/release-notes                     |
| Consumer plans                                      | https://x.ai/pricing                                           |

Secondary (speed only; methodologies differ; do not mix with the official
eval table):

- Artificial Analysis Grok 4.5 provider page
- OpenRouter `x-ai/grok-4.6` listing (early post-launch)

Library-local facts (this repo, live-verified 2026-07-09 unless noted):

- `packages/xai/src/models.ts`, `packages/xai/src/pricing.ts`,
  `packages/xai/src/model-config/grok-4-5.ts`
- `packages/xai/README.md`
- `docs/openai-strict-output-schema-plan.md` (14 live `json_schema` probes
  on 4.5)

## Headline

4.6 is a **post-training upgrade of the 4.5 stack**, not a documented
parameter jump. Same 500k context, same Feb 1 2026 knowledge cutoff, same
text+image → text modalities, same $2 / $6 list rates. Official story:
longer supplemental run, SFT trajectories regenerated with 4.5, broader
agentic RL (knowledge work, coding, kernel opt, web, CAD).

Product focus shifts from “coding / agents / knowledge work” (4.5) to
**long-running agents** and **ambitious interactive / visual first
passes**, with more self-testing / verification called out in the
announcement.

## Specs

|                                 | Grok 4.5                                                                                                                | Grok 4.6                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Released                        | API ~2026-07-08; news 2026-07-16                                                                                        | **2026-08-12**                                     |
| Model id                        | `grok-4.5`                                                                                                              | `grok-4.6`                                         |
| Aliases (provider `/v1/models`) | `grok-4.5-latest`, `grok-build-latest`                                                                                  | none (`aliases: []` in fixture 14, 2026-08-12)     |
| Context                         | 500k                                                                                                                    | 500k                                               |
| Knowledge cutoff                | 2026-02-01                                                                                                              | 2026-02-01                                         |
| Modalities                      | text + image in → text out                                                                                              | same                                               |
| Reasoning                       | always on; schema admits `low` / `medium` / `high` (live-verified 2026-08-24). `xhigh` stays rejected (D2, 2026-09-25). | same + native **`xhigh`** (live 200 on fixture 12) |
| Default effort (vendor)         | `high`                                                                                                                  | `high`                                             |
| Structured output               | Responses `text.format` `json_schema`                                                                                   | claimed same family; **not live-probed here**      |
| Tools                           | function calling; server tools extra                                                                                    | same                                               |
| Vision                          | jpg/png ≤20 MiB                                                                                                         | same (docs)                                        |
| Caching                         | automatic; `prompt_cache_key`                                                                                           | same                                               |
| Regions                         | us-east-1, us-west-2; no EU                                                                                             | same                                               |
| Rate limits (docs base)         | 150 RPS / 50M TPM                                                                                                       | same                                               |
| Batch                           | not listed                                                                                                              | not listed                                         |
| Vendor speed claim              | **80 TPS**                                                                                                              | “most intelligent **and fastest**” — no TPS number |

Launch promo (product, not API list price): 2× included usage in Grok Build
and Cursor for the first week after 2026-08-12.

## Pricing (API, USD / 1M tokens)

Long-context rates apply to **the entire request** once prompt tokens
reach ≥ 200k. This library selects `gt200k` when **gross** `inputTokens`
(including cached) is **at or above** 200,000.

### Official docs table (crawled 2026-08-12)

|              | 4.5 short | 4.6 short |  4.5 long |  4.6 long |
| ------------ | --------: | --------: | --------: | --------: |
| Input        |     $2.00 |     $2.00 |     $4.00 |     $4.00 |
| Cached input | **$0.30** | **$0.50** | **$0.60** | **$1.00** |
| Output       |     $6.00 |     $6.00 |    $12.00 |    $12.00 |

The **only published list-price delta** is cached input: 4.6 is 67% more
expensive on cache than the current official 4.5 row.

### This library’s frozen 4.5 snapshot (`xai-2026-07-09`, superseded)

The launch-day research snapshot recorded `XAI_PRICING['grok-4.5']` as
**$2 / $0.50 / $6** and **$4 / $1 / $12** — matching the **4.6** official
cache row, not the $0.30 / $0.60 row then shown for 4.5. That snapshot
was live-verified against `/v1/models` on 2026-07-09.

**Resolved 2026-08-12:** re-fetched `/v1/models` (fixture
`14-v1-models-pricing.json`). 4.5 cache was later lowered:
`cached_prompt_text_token_price: 3000` / long-context `6000` ($0.30 /
$0.60). 4.6 is `5000` / `10000` ($0.50 / $1.00). Snapshot is now
`xai-2026-08-12`. July 4.5 fixtures still carry `cost_in_usd_ticks` at
the old $0.50 cache rate — those ticks are contemporaneous with
`xai-2026-07-09`, not a contradiction of the new listing.

Other billing (both models, official):

- Reasoning tokens bill as usage (this library folds them into output).
- Reasoning cannot be disabled.
- Cached tokens still count toward TPM.
- Neither model has a listed Batch discount.
- **Priority processing** = 2× all token types after the cache discount.
  The 4.6 announcement’s “fast variant at twice the price” is **not** a
  documented `grok-4.6-fast` slug in the models list as of this snapshot;
  treat it as the 2× priority / Fast SKU until live-verified. Fixture 12
  later confirmed uncached standard-list 2× via `cost_in_usd_ticks`.
- Server-side tools (web search, X search, code execution) are typically
  ~$5 / 1k calls plus tokens. File attachments still implicitly enable
  `attachment_search` (see `packages/xai/README.md`).
- As of 2026-09-25 the adapter admits `serviceTier: 'priority'` on
  `grok-4.5`, `grok-4.6`, and `grok-4.7`.

### Consumer (not this library)

[x.ai/pricing](https://x.ai/pricing) lists SuperGrok **$30 / mo**
(explicitly includes Grok 4.6) and SuperGrok Plus **$100 / mo**. Irrelevant
to `@gullabs/xai` token accounting.

## Official 4.6 evals (“High” effort)

From https://x.ai/news/grok-4-6. Best score in **bold**. Competitor
figures are vendor cards / public leaderboards as cited by xAI. **Do not
mix these with 4.5’s own launch benches** (DeepSWE 1.0, Terminal Bench
2.1, SWE Marathon, SWE-Bench Pro) — different harnesses.

| Benchmark                |  4.6 High | 4.5 High |        Δ | GPT-5.6 Sol Max | Fable 5 Max |
| ------------------------ | --------: | -------: | -------: | --------------: | ----------: |
| AA Intelligence Index    |    **61** |       56 |       +5 |          **61** |      **62** |
| GDPVal-AA v2             |  **1753** |     1526 |     +227 |            1728 |        1741 |
| CursorBench v3.2         |     69.9% |    66.7% |  +3.2 pp |           67.2% |   **70.5%** |
| DeepSWE v1.1             |     65.9% |      54% | +11.9 pp |         **73%** |         70% |
| FrontierCode v1.1 (Ext.) |     61.3% |    56.6% |  +4.7 pp |           60.6% |   **63.6%** |
| APEX-Agents              |     57.5% |    47.1% | +10.4 pp |           56.7% |   **59.2%** |
| Terminal-Bench v3.0      |       26% |    15.7% | +10.3 pp |       **34.6%** |       34.1% |
| APEX-SWE                 |     56.4% |    53.6% |  +2.8 pp |               — |   **58.8%** |
| AA-Briefcase             |  **1577** |     1313 |     +264 |            1502 |        1574 |
| Harvey LAB (Vals)        | **15.8%** |    12.9% |  +2.9 pp |            2.5% |       11.3% |

Largest published jumps are **agentic / long-horizon** (DeepSWE, APEX-Agents,
Terminal-Bench v3.0) and **knowledge-work composites** (GDPVal-AA,
AA-Briefcase). 4.6 still trails GPT-5.6 / Fable on hard terminal / SWE
agents in this table.

4.5 launch claims **not republished for 4.6**: ~2× token efficiency vs
peers; SWE-Bench Pro ~16k output tokens/task; 80 TPS. Independent early
speed reads put both models in the mid-50s TPS range under load. Vendor
80 TPS is a peak, not a typical reasoning trace.

## Capability delta (vendor claims)

| Area                      | 4.5                                                           | 4.6                                                                            |
| ------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Long-horizon agents       | strong tool / coding focus                                    | primary announcement focus                                                     |
| Self-check                | not highlighted                                               | more self-testing / verification                                               |
| Visual / interactive apps | image-in                                                      | stronger first pass (claim)                                                    |
| Reasoning ceiling         | `high` max in this library; `xhigh` → `high` per current docs | native `xhigh` (live-probed fixture 12)                                        |
| Hallucinations            | not quantified on the 4.6 page                                | docs stress “minimal hallucinations”; **no new official hallucination number** |
| Safety                    | standard stack                                                | recalibrated; widest pre-deploy suite xAI cites                                |

Unchanged per docs: 500k context, image-in / text-out, function calling,
structured outputs, web / X search, code execution.

## What this means for `@gullabs/xai` (library only)

Landed 2026-08-12 on the 4.5 precedent:

1. **New canonical id** `grok-4.6`. No alias from `grok-4.5`,
   `grok-4.5-latest`, or `grok-build-latest`.
2. **Live-verified before coding the schema**:
   - `reasoning.effort` `low|medium|high|xhigh` (none 400).
   - `/v1/models` raw token prices → `XAI_PRICING['grok-4.6']` +
     `xai-2026-08-12`.
   - Fast / priority is `service_tier: "priority"` on `grok-4.6`, not a
     second model id.
   - Files + `file-ref` + implicit `attachment_search` unchanged.
   - 4.6 `text.format` `json_schema` + vision are family claims from
     docs; only the reasoning/tier axis has a 4.6 live fixture.
3. Keep `store: false`. Do not add Chat Completions. Do not invent tool
   billing lanes without a separate plan.
4. Hosts that hard-pin `grok-4.5` will not see 4.6 until they change the
   pin. That is correct.

## Caveats

- All 4.6 vs 4.5 scores above are **xAI’s own High-effort table**.
- Parameter counts and a teased 4.7 are **not** on the official 4.6 page.
- Product defaults (Grok Build now 4.6) can diverge from API aliases
  still pointing at 4.5. This library never follows aliases.
- This snapshot is day-of-launch. Re-check pricing and `/v1/models`
  immediately before any implementation commit.
