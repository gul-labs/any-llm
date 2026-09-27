---
'@gullabs/xai': minor
---

Register `grok-4.7` and admit the live-verified `priority` tier on `grok-4.5` at 2×. Bill x_search from `x_posts_fetched` and `x_users_fetched`. If required tool counters are absent, leave the snapshot cost unpriced and retain xAI's billed `cost_in_usd_ticks` in raw usage for reconciliation. Long-context rates start at 200,000 input tokens.

For stateless grok-4.7 conversations, pass the unchanged `result.transientProviderState` as `request.transientProviderState` with only new user or tool-result messages. The state preserves full response output order, including encrypted reasoning, messages, and server-tool items. It is excluded from ledger records. The adapter rejects assistant history alongside state, unknown tool-result ids, a mismatched model, and function-call history without state. Requests without state start fresh and can contain text-only assistant examples. File attachments carried in replay state keep tool cost estimated until attachment billing is live-pinned.

Structured output with built-in search is descriptor-gated; the live fixture admits it on `grok-4.6`. Direct `grok-4.7` calls require a descriptor that retains the stateless replay capability.

Breaking change for `grok-4.5`: a request combining `output.jsonSchema` with built-in `web_search` or `x_search` now fails locally. Move grounded structured extraction to `grok-4.6`, or perform search and structured extraction in separate calls. `grok-4.7` does not admit the combination without live evidence.
