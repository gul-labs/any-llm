---
'@gullabs/xai': minor
---

xAI: `providerOptions.xai.toolChoice` forces or disables the server-side search tools (`tool_choice` was only sent alongside function tools).

- `toolChoice: 'auto' | 'required' | 'none'` applies to `web_search` / `x_search` only. It needs a non-empty `providerOptions.xai.tools` and is rejected together with function tools, file attachments or the request-level `toolChoice`. Resend it on every request. Live on 2026-10-02: `required` ran 3 / 2 / 2 searches on grok-4.5 / 4.6 / 4.7 and `none` ran 0.
- `maxTurns` (integer ≥ 1, needs search tools) forwards xAI's documented `max_turns`. It caps agentic turns, not searches, and xAI did not enforce it on 2026-10-02 (`max_turns: 1` still ran 10–17 searches). Budget searches in the prompt and assert on `usage.details.web_search_calls`.
- A response where no server tool ran (`num_server_side_tools_used: 0`) now prices exactly with no tool fee. Before, `none` calls and `auto` calls that skipped the search were recorded as unpriced.
- Search tools plus `output.jsonSchema` is admitted on `grok-4.5` and `grok-4.7` as well as `grok-4.6` (live-verified). This reverses the 0.8.0 rejection on `grok-4.5`.
- Tool pricing is unchanged: web search is $5 per 1,000 calls, reconciled against billed ticks on all three models.

Breaking: an `output.jsonSchema` that uses the OpenAPI `nullable` keyword or uppercase type names (`STRING`, `OBJECT`) now fails locally with `bad_request` naming the path. xAI ignores `nullable`, so the model could not return `null` and wrote `""`, `0` or the string `"null"`. Write nullable fields as `type: ['string', 'null']`. The adapter never rewrites a schema.

Migration for hosts on 0.6.x:

- Node ≥ 22.12, `openai ^7` peer; `@google/genai ^2` peer if you upgrade `@gullabs/google` in the same move. Bump every `@gullabs/*` package together.
- Model identity is provider-qualified since 0.7.0: every request, registry lookup and pricing call takes an explicit `(provider, model)`; bare model ids no longer resolve.
- `gemini-3-flash-preview` and `gemini-3.5-flash` were removed in `@gullabs/google` 0.13.0; move to `gemini-3.6-flash`.
- Delete any local patch that added `toolChoice`; the option has the same name and values here.
- Convert Gemini-dialect schemas at the call site before routing to xAI, then delete any lowering helper.
