---
'@gullabs/xai': minor
---

An xAI function call that did not complete is no longer returned as a tool call, a refusal is a result, and reasoning summaries are separated.

A response that is not `completed` (a call cut by `max_output_tokens`, or any abnormal end) can hold a `function_call` item whose arguments stop mid-string. It used to become a tool call whose `args` was the raw half-string, and `finishReason` was rewritten from `length` to `tool_calls`. Now every function call of a non-completed response, and any call whose own `status` is not `completed`, is dropped from `toolCalls`, from `message` and from the replayed `transientProviderState`; `finishReason` keeps the response's own reason (`length` for the output cap, `other` otherwise) and a warning names the dropped call. A completed call whose `arguments` are not JSON now throws a non-retryable `server` error that carries the billed usage, instead of returning the string.

A message content part without `text` no longer fails the call with a `TypeError` after it was billed. A `refusal` part (`{ type: 'refusal', refusal }`) gives a result with no text, `finishReason: 'content_filter'` (the output cap keeps `length`) and a warning quoting the refusal; a part of any other type is ignored with a warning naming the type.

`reasoningText` joins reasoning summary parts, within an item and across items, with a blank line instead of running sentences together.

What hosts must change: a loop that ran tool calls on `finishReason: 'tool_calls'` needs nothing; one that handled a string `args` can delete that branch. Treat `length` with no tool call as "raise `maxOutputTokens` and retry the turn", and `content_filter` from xAI as a possible refusal (see the warning).
