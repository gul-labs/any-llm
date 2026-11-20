---
'@gullabs/xai': minor
---

Breaking: the `grok-4.5`, `grok-4.6` and `grok-4.7` config schemas now admit `temperature` from 0 to 1 and `topP` from 0 to 0.95 (both inclusive); they were 0 to 2 and 0 to 1. xAI's Responses API reference (read 2026-11-20) says it samples a `temperature` above 1 as 1 and a `top_p` above 0.95 as 0.95 while echoing the value sent, so a higher value was silently clamped; the schema now rejects it with `bad_request` before dispatch, naming the path. A host that sends a `temperature` above 1 or a `topP` above 0.95 must lower it to the value xAI actually samples (1 or 0.95) or drop it.

An `incomplete` response whose `incomplete_details.reason` is `content_filter` now returns `finishReason: 'content_filter'` (it was `other`). `max_prompt_tokens`, `max_time_limit` and any reason xAI adds later stay `other` and now carry one `other` warning naming the reason. `max_output_tokens` is still `length`. The reasons come from xAI's published OpenAPI document and are documented, not live-verified. A host that treated `other` as the signal for an xAI content-filter stop must handle `content_filter`.

The `maxOutputTokens` description no longer says the cap includes reasoning tokens: xAI documents that it applies to visible output only (no behaviour change). The `maxTurns` description now records that xAI ignored the cap in a live call on 2026-10-02 and documents it as applied on 2026-11-20; enforcement is open until a live probe, and the option is unchanged. Token and tool rates were re-read on 2026-11-20 and are unchanged.
