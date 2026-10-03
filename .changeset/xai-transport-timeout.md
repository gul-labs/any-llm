---
'@gullabs/xai': minor
---

xAI calls take a host transport and a per-request SDK timeout, and transport timeouts stop retrying.

`xaiAdapter({ transport: { fetch, fetchOptions } })` (and `xaiProvider`) passes the host's `fetch` and `fetchOptions` to the SDK client. Every call now carries an SDK `timeout`: `config.timeoutMs + 5000` when `timeoutMs` is set, otherwise `XAI_DEFAULT_TIMEOUT_MS` (one hour). `XaiClientLike.responses.create` options widen to `{ signal?, timeout? }`, and `buildXaiClient(auth, transport?)` takes the transport. `XAI_DEFAULT_TIMEOUT_MS`, `XAI_TIMEOUT_BUFFER_MS`, `XaiTransport` and `XaiRequestOptions` are exported.

An undici header or body timeout, and the SDK's own deadline, are now `kind: 'timeout'`, `retryable: false`, `reason: 'transport_timeout'` (they were retryable, so one slow call was billed up to three times). A connect timeout stays retryable.

What hosts must change:

- If any xAI call can run longer than 300 s (reasoning `high`/`xhigh`, agentic search), pass a transport. The SDK timeout alone does not lift Node's 300 s header timer; undici's `fetch` with `new Agent({ headersTimeout, bodyTimeout })` in `fetchOptions.dispatcher` does. The package README has the setup. xAI calls now stream internally (see the streaming changeset), which removes the need for reasoning-only calls; a tool-using call that can run past 300 s without any streamed event still needs it.
- `transport` cannot be combined with an injected `client`, and `transport.fetchOptions` cannot carry `headers`, `signal`, `body` or `method`; both throw `bad_request`.
- If you supply your own `XaiClientLike`, its `create` now receives `timeout` in the options argument.
- If your retry policy relied on an xAI timeout being retryable, it no longer is. Decide in the host whether to resubmit.
