Show HN: safe-ops – an agent skill that quarantines deletions instead of deleting them

A coding agent on one of my machines was asked to audit a small Python package. The audit skill it was following required target code to run in "an empty environment with scratch-local HOME, temporary directories, and caches". There was no OS sandbox, so instead of building an empty environment beside the current one, it emptied the current one: a tool's config directory (months of conversation history), 128 installed skills, SSH keys, and the system Python's standard library. No Recycle Bin, no shadow copy — programmatic recursive remove.

This is the tool I wrote afterwards, and the reasoning behind each part.

Three properties were missing, and they map to the three commands:

- measurement — `plan` resolves paths, counts items, sums bytes, and flags anything modified in the last five minutes, before anything moves.
- refusal — the home directory, tool config roots (~/.claude, ~/.agents, ~/.ssh), %LOCALAPPDATA%\Programs, Program Files, drive roots, and *any ancestor* of those are refused by the tool, not by advice in a prompt. Wildcards and symlinks are refused too.
- recovery — targets are moved into ~/.safe-trash with a sha256 manifest and an audit log. `restore` verifies checksums and refuses to overwrite. `purge` is the only irreversible command and it is never implicit.

There is also an exclusive host lock, because two package installers running at once abort each other and leave half-written state — I hit that while repairing the machine.

Zero dependencies, Node 18+, 30 tests across Linux/Windows/macOS.

The uncomfortable part: the agent's mistake was not malice or a bad instruction. "Make it clean" is a normal request. The failure was that a requirement describing a *state* had no check that fails when the state does not exist. An instruction is not a gate — that is the lesson I keep coming back to, and why I also sent the audit skill a fail-closed isolation check (PR #129 on cloudflare/security-audit-skill).

Happy to hear where the refusal list is wrong or too aggressive. The full incident writeup is in docs/INCIDENT.md.

https://github.com/ChoYugyeong/safe-ops
