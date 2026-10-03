---
'@gullabs/claude-cli': patch
'@gullabs/codex-cli': patch
---

The CLI runners no longer crash on an early-exiting CLI, corrupt multibyte output, or buffer without bound; `codex exec` gets the prompt on stdin.

- A `stdin` `error` handler: a CLI that exits before reading its input (a bad flag, expired auth) no longer raises an unhandled `EPIPE` that crashes the host process; the exit code and stderr report the failure.
- stdout and stderr are decoded with a `StringDecoder`, so a multibyte character split across chunks is intact.
- stdout is capped at 32 MiB: past it the process is killed and the call rejects with an `OutputLimitError`. stderr keeps its last 1 MiB.
- `@gullabs/codex-cli` sends the rendered prompt on stdin with `-` as the positional argument, so a large history no longer fails with `E2BIG`. A custom `CodexCliRunner` receives the prompt as `input` (it used to receive `''`) and must write it to the child's stdin.

What hosts must change: a custom `CodexCliRunner` must write `input` to stdin and run `codex exec ... -`.
