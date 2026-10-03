---
'@gullabs/xai': minor
---

xAI server-tool counters are classified by an explicit table instead of a `_calls` suffix guess. `mcp_calls` (Remote MCP) is token-only on xAI's pricing page, so a call that ran it stays `confidence: 'exact'` with no warning; before this change it was marked `estimated` with a false "understates" warning, which also dropped it from `cost_confidence = 'exact'` spend queries. Counters xAI bills per use with no rate here (`code_interpreter_calls`, `file_search_calls`, `document_search_calls`, `image_generation_calls`) and any counter the table does not know stay `estimated` with a warning. No host change is needed; read `cost.confidence` as before.
