---
'@gullabs/core': minor
'@gullabs/xai': minor
---

xAI's billed total is reported beside the snapshot price, and unpriced server tools fail closed (ADR-039).

`Cost.providerReported?: { microUsd }` carries the total a provider says it billed. For xAI it is `usage.cost_in_usd_ticks` (1 tick = 1e-10 USD) rounded to whole µUSD like each priced lane, and it is present even when the snapshot cannot price the call. `Cost.microUsd` stays the snapshot price. The engine compares totals and adds a `cost drift` warning when they differ by more than 1 µUSD per priced lane. A non-zero server-tool counter that xAI bills per use with no rate here (`code_interpreter_calls`, `file_search_calls`, `document_search_calls`, `image_generation_calls`) or that the pricing table does not know now makes the call `confidence: 'estimated'` with an adapter warning, where it used to price exact with a zero tool fee. New fixture `35-priority-warm-cache.json` (live probe, 2026-10-03) pins the priority tier on a warm cache for all three models, and fixture 33's five usages are now reconciled to billed ticks.

What hosts must change: a call that ran an unpriced server tool is now `'estimated'`; treat `cost.confidence` accordingly. A `cost drift` warning means xAI's prices changed or a billed lane is missing: re-snapshot the rates.
