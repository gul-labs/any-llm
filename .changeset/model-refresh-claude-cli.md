---
'@gullabs/claude-cli': minor
---

Replace `claude-fable-5` with `claude-fable-5-1` and `claude-opus-4-8` with `claude-opus-5-5`. Disable silent model switching. Direct adapter calls now require a matching model descriptor. Haiku 4.5 has no reasoning key. A successful `stop_reason: refusal` response returns `finishReason: 'content_filter'` with billed usage.

Host migration: use `claude-fable-5-1` and `claude-opus-5-5` in place of the deleted ids. No aliases are provided.
