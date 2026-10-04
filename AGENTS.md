# Project Instructions

## P0 Engineering Rule: No Legacy Compatibility

This codebase is greenfield until this rule is explicitly revised by the owner.

- Backward compatibility is not a design constraint.
- Do not add compatibility shims, deprecated aliases, legacy adapters, migration
  helpers, feature flags, or fallback code paths to preserve old behavior.
- Delete legacy, dead, transitional, and compatibility code instead of wrapping
  it.
- Prefer the cleanest current contract even when it is breaking.
- If a plan or review proposes keeping old behavior "for compatibility," treat
  that as a P0 blocker and revise the design.
- Migration documentation may explain the new contract, but it must not introduce
  legacy APIs or compatibility layers.

## Private working files

This repository is public. Plans, probe output, and notes that name a host
project, a customer, production data, or local paths go in `.private/`
(gitignored), never under `docs/`. Public design records (`DECISIONS.md`,
`SPEC.md`, `docs/`) describe hosts generically.

## No live Gemini / Google API calls

Do not make live calls to the Gemini / Google generative-AI API from this repository's scripts, tests, probes or agents. The only exception is a call made with a free-tier API key on a model the free tier allows (check Google's pricing and rate-limits pages first); never use a key attached to a billing account. Use pinned fixtures, stubbed-`fetch` tests and public documentation instead. When briefing a subagent, include this rule.
