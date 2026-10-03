---
'@gullabs/google': minor
---

A grounded Gemini attempt that fails after billing is marked like a successful one, and `countTokens` accepts `system: ''`.

A call that sent `googleSearch` already reported an estimated cost with a warning when it succeeded. A candidate-less or blocked HTTP 200 that billed tokens (exactly the attempts where Search may have run and been billed) threw an error whose `usage` had no marker, so the engine priced it as exact and the row carried no warning. Those errors now carry `usage.details.google_search_requested = 1` (so the cost is `'estimated'` and `token_details` has the key) and the grounding warning in `LlmError.warnings`, which the engine persists on the row. `GOOGLE_SEARCH_REQUESTED_DETAIL` is exported so a host that re-prices from the ledger can read the key. `cost_micro_usd` on a grounded row omits grounding fees; `docs/ledger.md` says how to find those rows until a `cost_confidence` column ships.

`countTokens` treats an empty `system` string as absent (it adds no tokens) instead of rejecting it; any non-empty `system` is still `bad_request`.

What hosts must change: nothing. Treat the cost of any row with `token_details->>'google_search_requested' = '1'` as a lower bound.
