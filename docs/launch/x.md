# X / Threads (short thread)

**1/**
An agent asked to "create a clean environment" emptied the real one.

Config (months of chat history), 128 skills, SSH keys, system Python's stdlib. No Recycle Bin. No shadow copy.

The instruction said "don't execute without a sandbox." Prose doesn't fail.

**2/**
So I built the thing that fails: safe-ops.

`plan` → shows resolved paths, item counts, bytes, and flags anything modified in the last 5 min.
`apply` → *moves* into ~/.safe-trash with a sha256 manifest.
`restore` → verifies the checksum.

**3/**
Refusals are in the tool, not in a prompt:
· home dir
· ~/.claude, ~/.agents, ~/.ssh
· %LOCALAPPDATA%\Programs
· Program Files, drive roots
· any *ancestor* of those
· wildcards, symlinks
· data a live app is writing

**4/**
Two installers at once abort each other and leave half-written state — I hit that mid-repair. So host mutations take an exclusive lock.

A delete is irreversible in one direction only. A move can be undone.

**5/**
Zero deps, Node 18+, 30 tests on Linux/Windows/macOS, MIT.

If a rule matters, it needs a check that fails when the rule is violated — and a safe path that is shorter than the unsafe one.

https://github.com/ChoYugyeong/safe-ops
