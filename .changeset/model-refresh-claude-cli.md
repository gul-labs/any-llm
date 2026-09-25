---
'@gullabs/claude-cli': minor
---

Replace `claude-fable-5` with `claude-fable-5-1` and `claude-opus-4-8` with `claude-opus-5-5`. Disable silent model switching. Haiku 4.5 has no reasoning key. `stop_reason: refusal` is `content_filter`.

Host migration: `gemini-3-flash-preview` → `gemini-3.6-flash`; `gemini-3.5-flash` → `gemini-3.6-flash`; `gpt-5.x` → `gpt-6-*`; `claude-fable-5` → `claude-fable-5-1`; `claude-opus-4-8` → `claude-opus-5-5`. Deleted ids do not resolve and are not aliased.
