---
'@gullabs/any-llm': patch
'@gullabs/claude-cli': patch
'@gullabs/codex-cli': patch
'@gullabs/core': patch
'@gullabs/google': patch
'@gullabs/xai': patch
---

Raise runtime dependency floors: `zod` `^4.5.4` (was `^4.4.3`) in core, google, xai,
claude-cli and codex-cli, and `@google/genai` `^2.20.0` (was `^2.19.0`) in any-llm. No API
changes.
