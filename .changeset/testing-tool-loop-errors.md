---
'@gullabs/testing': minor
---

`runToolLoop` turns a throwing tool into an `isError` tool result.

A tool implementation that throws no longer aborts the loop: its error message goes back to the model as a `tool-result` with `isError: true`, so a host test can exercise the model's error-recovery turn. A call to a tool with no implementation throws `LlmError('bad_request')` instead of a plain `Error`.

What hosts must change: tests that expected `runToolLoop` to reject when a tool throws must assert on the `isError` result in the next request instead.
