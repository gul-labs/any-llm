---
'@gullabs/xai': minor
---

`providerOptions.xai.searchBudget` reports a search budget exceeded after the call (ADR-030 amendment).

`searchBudget: { maxWebSearchCalls?, maxXItems? }` (integers >= 1, at least one, needs `tools`; `maxWebSearchCalls` needs `web_search`, `maxXItems` needs `x_search`) is never sent to xAI, which has no per-call search ceiling. After the response the adapter compares `web_search_calls` with `maxWebSearchCalls` and `x_posts_fetched` plus `x_users_fetched` with `maxXItems`. Over budget: a warning and `usage.details.search_budget_exceeded = 1`. The result is still returned and priced, because the call is already billed. A counter xAI did not report is never counted as exceeded. `maxTurns` is unchanged.

What hosts must change:

- Nothing is required. Read `usage.details.search_budget_exceeded` (or the warning) to learn that a call spent more searches than expected; this is a report, not a ceiling.
