---
'@gullabs/claude-cli': minor
'@gullabs/codex-cli': minor
---

Refresh the dev-only CLI model registries, state their limits honestly, and read the documented structured-output field.

**Removed ids (no alias).** `claude-cli`: `claude-fable-5-1`, `claude-sonnet-5` and `claude-haiku-4-5-20251001`. `codex-cli`: `gpt-6-sol` and `gpt-6-astra`. The config schema exports `ClaudeFable51ConfigSchema`, `ClaudeSonnet5ConfigSchema`, `ClaudeHaiku45ConfigSchema`, `Gpt6SolConfigSchema` and `Gpt6AstraConfigSchema` are deleted.

**Added ids.** `claude-cli` now registers `claude-fable-5-2`, `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5`, with the exports `ClaudeFable52ConfigSchema`, `ClaudeOpus55ConfigSchema`, `ClaudeSonnet55ConfigSchema` and `ClaudeHaiku55ConfigSchema`. `codex-cli` now registers `gpt-6.2-sol`, `gpt-6.2-astra`, `gpt-6.1-terra` and `gpt-6-luna`, with `Gpt62SolConfigSchema`, `Gpt62AstraConfigSchema`, `Gpt61TerraConfigSchema` and `Gpt6LunaConfigSchema`. `gpt-6.1-sol` is not registered.

**Efforts.** All four Claude models admit `low`, `medium`, `high`, `xhigh` and `max`, so Haiku now takes `reasoning.effort` (the Haiku-specific no-reasoning schema is gone). `ultracode` (Claude Code) and `ultra` (Codex) stay rejected: they are CLI workflow and delegation switches, not model levels.

**Limits.** `claude-cli` states 1,000,000 context and 128,000 output for every model, the documented API figures (Anthropic models overview, read 2026-11-20). The CLI itself reported the same figures for `claude-opus-5-5` in the existing capture (Claude Code 2.1.282); for `claude-fable-5-2`, `claude-sonnet-5-5` and `claude-haiku-5-5` no `modelUsage` has been captured. `codex-cli` states the context window Codex CLI runs each model with by default (500,000 for `gpt-6.2-sol` and `gpt-6.1-terra`, 272,000 for `gpt-6.2-astra` and `gpt-6-luna`, from the model catalog bundled with Codex CLI 0.171.0) instead of the API's 1,050,000, and 128,000 output from the OpenAI model pages.

**Structured output.** `claude-cli` now reads the `structured_output` field of the `--output-format json` result for structured calls and no longer parses the `result` text. A run whose result has no `structured_output` field returns no structured output (the call reports an unparsed output) and a warning; there is no fallback to parsing `result`.

**Silent model switches.** `claude-cli` also sets `CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK=1` on the `claude` child (documented since Claude Code 2.1.312; an older CLI ignores it), beside the unchanged `--settings` argument and served-model check. It is adapter-owned: it is not inherited from the host environment, and naming it in the adapter's `env` option is `bad_request`.

**What a host must change.** Replace every removed model id with its successor (`claude-fable-5-1` with `claude-fable-5-2`, `claude-sonnet-5` with `claude-sonnet-5-5`, `claude-haiku-4-5-20251001` with `claude-haiku-5-5`, `gpt-6-sol` or `gpt-6-astra` with `gpt-6.2-sol` or `gpt-6.2-astra`), including persisted model configs and any import of a deleted schema export. Upgrade the local CLIs: Claude Code 2.1.284 or later for Sonnet 5.5, 2.1.293 for Haiku 5.5 and 2.1.321 for Fable 5.2; Codex CLI 0.171.0 or later for the 6.2 ids. A host that relied on `limits.contextWindow` of 1,050,000 for a Codex model sees the smaller CLI window.
