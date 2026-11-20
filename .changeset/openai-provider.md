---
'@gullabs/openai': minor
---

New package `@gullabs/openai`: an OpenAI provider over the `openai` SDK's Responses API (ADR-047), for
`gpt-6.2-astra`, `gpt-6.2-sol`, `gpt-6.1-terra` and `gpt-6-luna`. Every model fact, rate and wire shape is
taken from OpenAI's documentation (read 2026-11-20); nothing is live-verified yet.

- One strict config schema per model: `maxOutputTokens` (up to 128,000), `reasoning.effort` (GPT-6.2:
  `low | medium`; Terra and Luna: `none` to `max`), `serviceTier` (GPT-6.2: `fast`; Terra and Luna:
  `flex | fast`) and `timeoutMs`. No sampling keys and no `providerOptions` lane.
- Text and image input (PNG, JPEG, WebP, GIF as base64 or an `http(s)` URL), strict structured output,
  strict client-side function tools with `'state'` continuation, usage and cost. Anything else is
  `bad_request` before dispatch.
- Calls stream internally over a small transport of their own (`fetch` plus the SDK's environment-free
  `openai/streaming` decoder and `openai/error` classes); no SDK client is constructed, so no ambient
  `OPENAI_*` setting can change the destination or the headers, and a terminal event is required.
- Pricing snapshot `openai-2026-11-20` prices the tier the response echoes; a response that echoes no tier
  is unpriced. Cache writes and long context are priced; costs that rest on undocumented accounting are
  `estimated`.

What a host does: `pnpm add @gullabs/openai openai` (peer `openai ^7.60.0`, `@gullabs/core` at the same
version), add `openaiProvider()` to `composeProviders`, and pass `{ auth: { apiKey } }` on every call.
Nothing changes for hosts that do not install it.
