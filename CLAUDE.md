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
