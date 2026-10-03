---
'@gullabs/core': minor
'@gullabs/xai': minor
'@gullabs/testing': minor
---

Every result carries the ordered assistant `message` and a `continuation` rule; xAI state is provider-scoped; `@gullabs/testing` adds `runToolLoop` (ADR-029 addendum).

`LlmResult.message` is the assistant output as an ordered `Message` on every provider: text parts and tool calls in provider order, thought, reasoning and server-tool items omitted (indices are over `message.parts`). `text` and `toolCalls` stay as conveniences. `AdapterResult.message` is optional; without it the engine builds `[text, ...tool calls]`.

`LlmResult.continuation` (`'history' | 'state'`) repeats the descriptor's new `capabilities.continuation`, so a host needs no registry lookup. `'history'` (the default, and grok-4.5/4.6): append `result.message`, send the full history. `'state'` (grok-4.7): send only the new messages plus `result.transientProviderState`, and do not replay `result.message`. `capabilities.statelessReasoningReplay` is deleted; `capabilities.providerState: true` is what lets the engine forward `transientProviderState` (`createModelRegistry` rejects `continuation: 'state'` without it).

State is provider-scoped and bound to the model string the host sent. The xAI state is now `{ xai: { model, input } }` (it was `{ model, input }`), and `XaiReplayState` has that shape. Another provider's state, or state bound to another model string (an alias is a different string from its canonical id), is `bad_request`. The next turn must use the same `provider` and `model` string as the previous one; `result.model` is the id the provider returned and is not for routing.

What hosts must change:

- Read `result.continuation` (or follow the README loops) instead of assuming one replay rule. Persist grok-4.7 state exactly as returned; state stored by an earlier version in the old `{ model, input }` shape is rejected, so restart those conversations.
- A custom `ModelDescriptor` that declared `statelessReasoningReplay: true` declares `continuation: 'state', providerState: true` instead. A custom `ProviderAdapter` should set `AdapterResult.message` when its output can interleave text and tool calls.
- Test code can use `runToolLoop(client, req, tools, { auth })` from `@gullabs/testing`, which follows `result.continuation` after every turn.
