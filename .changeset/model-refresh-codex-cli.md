---
'@gullabs/codex-cli': minor
---

Replace the Codex CLI catalog with `gpt-6-astra`, `gpt-6-sol`, and `gpt-6-luna`. Efforts are `low` through `max`. Every exec passes `--strict-config`.

Host migration: `gemini-3-flash-preview` → `gemini-3.6-flash`; `gemini-3.5-flash` → `gemini-3.6-flash`; `gpt-5.x` → `gpt-6-*`; `claude-fable-5` → `claude-fable-5-1`; `claude-opus-4-8` → `claude-opus-5-5`. Deleted ids do not resolve and are not aliased.
