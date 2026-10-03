---
'@gullabs/xai': minor
---

The config schema accepts exactly the `searchBudget` shapes the adapter accepts.

`providerOptions.xai.searchBudget` now needs at least one ceiling and the tool each ceiling counts (`maxWebSearchCalls` needs a `web_search` tool, `maxXItems` an `x_search` tool) at config validation, with a message naming the path, instead of failing inside the pipeline after a ledger row was started. The adapter keeps its own checks for direct callers. `maxTurns` and `toolChoice` are unchanged.

What hosts must change:

- Nothing is required; a budget that was refused before is refused earlier.
