# Proposal: Response Chaining Passthrough (`previous_response_id`)

## Status

Proposed — not yet triaged.

Attribution: proposed by the a host application pipeline team, from its pipeline's
revise/regen loop design (2026-07-10). Owner will triage with the any-llm team.

## Purpose

Some providers support server-side conversation-state chaining: xAI and
OpenAI's Responses API accept a `previous_response_id` that lets a follow-up
call resume a prior response's state — including its reasoning tokens —
without the caller re-sending the full prior context. `any-llm` has no surface
for this today. This proposes exposing it as an opt-in, per-request,
provider-specific passthrough option — not a new engine mechanism, and not a
default.

## Motivating use case

The a host application pipeline's revise/regen loop currently re-sends the full
assembled context (~19k tokens) on every round, plus a filtered copy of the
model's previous output, so the model can revise against reviewer feedback.
This mechanism is consumer-side and provider-neutral by design: it works
identically regardless of which provider is generating.

On a chaining-capable provider, the same round could instead send only the
reviewer feedback delta with `previous_response_id` set, letting the model
natively retain its prior output and reasoning state server-side. That would
cut input tokens substantially and may improve convergence, since the model
isn't reconstructing its own prior reasoning from a flattened text copy. The
ledger already has the handle this would need — `llm_calls.response_id` is
populated by the xai adapter today, unused for chaining.

## Proposed surface

- `providerOptions.xai.previousResponseId` — a pure passthrough field added to
  the xai adapter's request build. The adapter currently admits only
  `promptCacheKey` in this slot; this is an additive schema field alongside
  it, not a new mechanism.
- Later, `providerOptions.openai.*` if/when an OpenAI Responses API adapter
  lands, following the same pattern.
- No engine changes. No new `LlmRequest` field. Consumers are responsible for
  threading the prior call's `response_id` from their own ledger into the next
  request's `providerOptions`.

## Explicitly NOT proposed

- Making chaining the default behavior for any provider.
- Any engine-level conversation-state management (e.g. any-llm tracking or
  auto-threading response IDs on the caller's behalf).

Rationale, from the consumer side:

- **Portability.** a host application's Gemini production path has no equivalent to
  `previous_response_id`. Revision semantics must not diverge per provider —
  the consumer-side previous-output mechanism remains the baseline path for
  all providers; chaining would only ever be an opt-in optimization on top of
  it for providers that support it.
- **Durability.** Server-side state has a provider-controlled retention
  window, and it is invisible to Temporal replay/reset — a workflow that
  reconstructs its state by replaying activities has no way to recover a
  `previous_response_id` reference if it expired or the workflow resets.
  The consumer's artifact-based context, by contrast, is stored in Postgres
  and replayable indefinitely.
- **Debuggability.** A request whose effective context lives server-side at
  the provider can't be reconstructed offline for replay-harness bisection.
  Debugging a live pipeline incident this cycle depended on exactly that
  capability — replaying the full request context outside the provider.
  Chaining would remove that for any call that used it.

## Open questions

- What is xAI's actual retention window for chained response state, and what
  happens on expiry — a clean error, or silent loss of the prior turn?
- Interaction with structured outputs: does `text.format` need to be re-sent
  on every chained turn, or does it carry over from the prior response?
- Does usage/cost accounting under chaining report cumulative tokens (prior +
  current turn) or per-turn tokens? This matters for `llm_calls` ledger
  accuracy — a per-turn call ledgering cumulative usage would double-count
  cost across a chained sequence.

## Effort estimate

Roughly half a day: adapter schema field + passthrough + a fixture test.
Consumer-side wiring (a host application threading `response_id` between pipeline
rounds) is separate and not included in this estimate.
