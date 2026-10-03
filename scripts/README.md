# Scripts

Run from the repository root. `pnpm quality` runs the offline checks; the live tools are
manual and never run in CI.

## Offline checks (part of `pnpm quality`)

| Script                        | pnpm script                        | What it checks                                                                                                    |
| ----------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `check-doc-snippets.mjs`      | `check:docs`                       | Every `ts` code fence in the READMEs and live docs typechecks against the built packages (`ts no-check` opts out) |
| `runtime-smoke/`              | `test:runtime`                     | Built ESM entries load with `node:` blocked; fake-backed calls run without `Buffer` or `process`                  |
| `audit.mjs`                   | `audit:gate` / `test:audit-gate`   | Dependency advisories, distinguishing "vulnerable" from "the advisory service is down"                            |
| `packed-install.mjs`          | `test:packed-install` (own CI job) | The packed tarballs install under pnpm and npm, resolve one core, and mixed versions are rejected                 |
| `recapture-fixtures.test.mjs` | `test:scripts`                     | The re-capture tool's refusals, redaction, diff and failure handling (stubbed `fetch`), offline                   |

## Live tools (manual, spend real money, never in CI)

Both refuse to run when `CI` or `GITHUB_ACTIONS` is set and without their key variable. Use a
key you are happy to spend on, and read the cost note at the top of each script.

### `recapture-fixtures.mjs`: refresh the xAI fixtures and see the drift

`packages/xai/src/__fixtures__/*.json` are live captures: they prove the adapter handled the API
as of the capture date. This script repeats the captures listed in it and diffs them against the
recorded files.

```bash
pnpm -r build                                       # it reuses core's secret redaction
node scripts/recapture-fixtures.mjs --list          # the probes; no key, no request
node scripts/recapture-fixtures.mjs --dry-run       # what would run; no key, no request
XAI_API_KEY=... node scripts/recapture-fixtures.mjs --only 02,14
XAI_API_KEY=... node scripts/recapture-fixtures.mjs --write   # also overwrite the fixtures
```

- **Needs `XAI_API_KEY`** in the environment. It is read from there only; it is never printed or
  written. A run costs well under one US cent (a one-line prompt, three error requests, one free
  model listing).
- **Redaction.** Every captured string passes through core's secret patterns, the exact key value
  is replaced, response headers are an allow-list (`content-type`, `retry-after`,
  `x-ratelimit-*`, `x-request-id`), and a capture that still contains the key aborts the run.
- **Output.** Without `--write` the captures go to `.recapture/` (gitignored) and the fixtures are
  untouched. With `--write` the fixtures that drifted are overwritten, so `git diff` shows the drift.
- **A failed probe is never a fixture.** A response that is not what the probe expects stops the run
  at once: a rate limit (429, 408), a 5xx, a rejected key on a request that carries the real one, an
  error body where a success is expected, a thrown `fetch`, or no answer within 60 s. Nothing is
  written to a fixture in that case (every probe is staged first; `--write` writes only after all of
  them succeeded, each file through a temporary name and a rename). Exit codes: `0` no drift (or
  the drift was written), `1` a probe failed, `2` refused or bad arguments, `3` drift found and
  `--write` not given.
- **Diff.** `+` a new path, `-` a removed one, `~` a changed type, status or stable value. Ids,
  timestamps, answer text and token counts change on every call and are compared by type only.
- **Which fixtures.** Only those whose request is known: 02 (minimal call), 09 (error taxonomy),
  13 (`effort: none` on grok-4.6) and 14 (`/v1/models` prices, for the model ids the fixture already records). Most older fixtures do not record
  their request and cannot be replayed; a new fixture should record its request and get a probe
  in `PROBES`. After a re-capture that moves a fixture, update the test that reads it in the same
  change, and the `capturedOn`/date notes that cite it.

### `probe-capabilities.mjs`: check Gemini descriptors against the live API

Probes every registered Gemini and Gemma descriptor (temperature, reasoning, flex, native JSON,
Search, an image) and prints each place a declared capability disagrees with the response. Needs
`GEMINI_API_KEY`; use a free-tier key (`PROBE_INCLUDE_PAID=1` adds paid-only models). It resolves
`@google/genai` and `@gullabs/google` from a package that depends on them:

```bash
cd packages/any-llm && GEMINI_API_KEY=... node ../../scripts/probe-capabilities.mjs
```
