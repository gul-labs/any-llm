---
'@gullabs/claude-cli': patch
'@gullabs/codex-cli': patch
---

The CLI runners kill the whole process group, so a grandchild holding the pipes cannot hang a call past its timeout, abort or output cap.

- The CLI is spawned `detached` (its own process group on POSIX) and a timeout, abort or stdout-cap kill sends `SIGTERM`, then `SIGKILL` after the 5 s grace, to the group (`process.kill(-pid)`). After the `SIGKILL` the runner also closes its ends of stdout and stderr, so a process that left the group cannot keep `close` from firing. A call that used to settle only when such a grandchild exited (12 s in a repro with a 0.5 s timeout) now settles within the grace.
- A host interrupted with Ctrl-C no longer forwards the signal to the CLI (it is in its own group); the CLI runs to its own timeout.

What hosts must change: nothing. A custom runner should kill its process group the same way.
