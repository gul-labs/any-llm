---
'@gullabs/core': minor
---

Middleware cannot change the provider or model (ADR-037, amends ADR-007).

The engine used to let a middleware change `provider` or `model` on the request while it validated, priced and authenticated with the original call's descriptor and auth: a Google to xAI switch sent Gemini's `serviceTier: 'flex'` to xAI and recorded `microUsd: null`, and a same-provider switch was priced at the original model's rates. Now the `next` handed to every middleware refuses a request whose `provider` or `model` differs from the call's, with `bad_request` and a pre-attempt refusal row (`attemptNumber: 0`), before anything inside the offender runs. The engine records `{ provider, requestedModel, descriptor }` at call start and dispatches, validates config, prices and authenticates with those values; it never reads them from the request a middleware passes on.

What hosts must change:

- Middleware that rerouted or built provider fallback must move that logic into the host: catch the error and call `generate` again with the other target's config and auth. That is a separate call with its own `callId`, priced and recorded for its own model. Give both calls the same `externalId` to link them. The README "Fallback" section shows the pattern.
- Treat the request as immutable once passed to `next`; to change config, messages or metadata, pass a new object to `next`.
