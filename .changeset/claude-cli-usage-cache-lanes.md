---
'@gullabs/claude-cli': minor
---

`claude-cli` usage counts both cache lanes as input and reports thinking tokens (ADR-039).

Anthropic's `input_tokens` excludes cache reads and cache writes, so the adapter recorded `inputTokens: 2` for a call that processed 4,013 tokens and clamped `cachedInputTokens` with a warning whenever the cache was read. Now `inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, `cachedInputTokens = cache_read_input_tokens`, `details.cacheWrite = cache_creation_input_tokens`, and `thinkingTokens = output_tokens_details.thinking_tokens`. `totalTokens` is the new input plus output.

What hosts must change: nothing, unless you summed `inputTokens` and the cache fields yourself; `inputTokens` is now the gross figure.
