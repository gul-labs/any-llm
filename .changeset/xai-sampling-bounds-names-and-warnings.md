---
'@gullabs/xai': minor
---

xAI sampling is bounded, the structured-output name is validated, the unknown-counter warning stops claiming "understates" for token-priced tools, and the adapter's test seams are out of the shipped types.

`temperature` must be 0 to 2 (the range xAI documents) and `topP` 0 to 1; a value outside is rejected by the config schema of `grok-4.5`, `grok-4.6` and `grok-4.7`, never clamped.

The structured-output `name` is the schema `title`. xAI documents no rule for it; the Responses API's `^[a-zA-Z0-9_-]{1,64}$` is enforced, so a title such as "Weather Report" is now `bad_request` before dispatch (the adapter never rewrites a title). A schema with no `title` is still sent as `structured_output`.

Image understanding and X video understanding are token-priced by xAI (no invocation fee) and the pricing page names no counter for them, so none is added to the pricing table. A non-zero counter the table does not know still prices the call `'estimated'`, but when the request enabled image or video understanding the warning now says the priced token cost may be complete instead of claiming the call understates; a known per-use counter (code execution) still understates, and a file attachment gets one warning for `document_search_calls`, not two.

`XaiAdapterOptions._clientFactory` and `_fetch` are deleted. The seams are an unexported `xaiAdapterWithSeams`, as in `@gullabs/google`, so no test seam is in a shipped type. Also deleted: the unused `file_url` on `XaiInputFilePart` (`file_id` is required now), the `{ type: 'text' }` variant of `XaiTextFormat` (it is an interface of the one `json_schema` shape), stale comments, and the README's "Explicitly deferred" list of features that were built.

What hosts must change: drop `_clientFactory` / `_fetch` (use `client`, `transport`); rename a structured-output schema `title` that contains anything outside letters, digits, `_` and `-`, or remove it; pass `temperature` within 0 to 2 and `topP` within 0 to 1.
