---
'@gullabs/google': minor
---

Transport timeouts that cannot work are rejected, one endpoint serves every call, provider metadata is bounded, and dead code is removed.

- `providerOptions.google.httpOptions.timeout` above 2147483647 ms (the longest delay a Node timer holds; the SDK's timer fired after 1 ms and the call aborted at once) is `bad_request` in the adapter and every model schema. With `timeoutMs` set it must be at least `timeoutMs + 5000`, because a shorter SDK timer ended the call before the engine's deadline with a raw SDK abort.
- The SDK client is built with the Developer API base URL pinned, which the REST `countTokens` (system or tools) already used, so one endpoint serves every call and the SDK's `GOOGLE_GEMINI_BASE_URL` environment override is no longer read. The `countTokens` README now says the count covers `messages`, `system` and `tools` only, not the response schema, thinking config, `toolConfig`, safety settings or Search tool.
- A flex call the adapter sends again at the standard tier (HTTP 503) carries a warning saying so, naming the 300 s client-side ceiling when no `timeoutMs` is set.
- The inline PDF cap (50 MB) matches the media type as admission does: `Application/PDF` and `application/pdf; x=y` are capped too.
- `providerMetadata.groundingMetadata` and `promptFeedback` are bounded like `providerMetadata.google.candidate` (50 list entries, 2048 characters per string, 8 levels, a warning when cut); citations are built from the full response.
- `GEMINI_PRICING` is deep-frozen (a rate object, `gt200k` band or `audio` rate can no longer be changed in process). Stale pricing comments (the free allowance) and the tool-use token note are corrected.
- Deleted: `GeminiAdapterOptions._clientFactory` (the test seam is an unexported function now, so it is in no shipped type), the unreachable second and third "no candidate" checks, the `httpOptions.headers` field of the request type, the reserved-key filter after reserved keys already threw, and exports used only in their own file (`nextFallbackToolCallId`, `GoogleErrorBody`, `parseGoogleErrorBody`, `ResolvedSignatures`).

What hosts must change: pass `httpOptions.timeout` of at most 2147483647 and, with `timeoutMs`, at least `timeoutMs + 5000`; drop `_clientFactory` (use `client`); set a proxy through your own `client`, not `GOOGLE_GEMINI_BASE_URL`.
