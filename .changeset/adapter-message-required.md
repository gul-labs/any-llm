---
'@gullabs/core': minor
'@gullabs/google': minor
'@gullabs/xai': minor
'@gullabs/testing': minor
'@gullabs/claude-cli': minor
'@gullabs/codex-cli': minor
---

`AdapterResult.message` is required, an empty assistant message is rejected, and `countTokens` can report `accuracy: 'estimated'`.

The engine no longer builds the ordered assistant message from `text` and `toolCalls` when an adapter omits it (only the adapter knows the provider's interleaving, and a guessed order would be replayed). `AdapterResult.message` is now required; the Google, xAI, Claude CLI and Codex CLI adapters set it, and `@gullabs/testing` `FakeAdapter` and `SignalAwareFakeAdapter` throw a `TypeError` for a scripted result that lacks it. A result with nothing representable (a thought-only response, for example when the output cap was spent on reasoning) has `message.parts === []`; do not append it to history. An assistant message with no parts is now `bad_request` before dispatch, on every provider. `result.toolCalls` is a copy: editing a tool call's `args` no longer changes the arguments in `result.message`, which is what a Gemini 3 signature hashes.

`TokenCount.accuracy` gains `'estimated'`: the provider counted the history, but the real call sends parts the count cannot include. `@gullabs/google` reports it for a Gemini 3 history that holds function calls (each replayed thought signature bills about 110 prompt tokens and `countTokens` carries none). `AdapterCtx.modelDescriptor` carries the resolved descriptor to `countTokens`.

What hosts must change:

- A custom `ProviderAdapter` (and any scripted `FakeAdapter` result) must return `message: { role: 'assistant', parts }`.
- Do not append a result whose `message.parts` is empty to your history; retry the call.
- Code that switches on `TokenCount.accuracy` must handle `'estimated'`.
