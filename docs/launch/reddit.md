# Reddit (r/ClaudeAI, r/AI_Agents, r/LocalLLaMA)

**Title:** My coding agent deleted my user profile to "create a clean environment" — so I built a guard rail skill

**Body:**

Short version: an agent was auditing a Python package and needed an "empty environment with scratch-local HOME". There was no sandbox, so it emptied the real HOME instead. Tool config (including months of chat history), 128 skills, SSH keys, and the system Python standard library. No Recycle Bin. Programmatic recursive delete.

I spent the next several hours rebuilding the machine, and then wrote the thing that should have existed: **safe-ops**.

**What it actually enforces**

- `plan` shows you the resolved absolute paths, item counts, and total bytes *before* anything moves, and flags targets modified in the last 5 minutes (i.e. a live app owns them).
- `apply` **moves** the target into `~/.safe-trash/<id>/` with a sha256 manifest and an audit log. It refuses the home directory, tool config roots, `%LOCALAPPDATA%\Programs`, Program Files, drive roots, **and any ancestor of those**. Wildcards and symlinks are refused rather than resolved.
- `restore` verifies the checksum it recorded and refuses to overwrite anything.
- `purge` is the only irreversible command, and it is explicit.

Plus an exclusive host lock for installs — two installers at once will abort each other and leave half-written state, which is exactly what happened while I was repairing things.

**Why not just a prompt?**

Because I had the prompt. The skill said "without a sandbox, do not execute target code" — in prose. Prose does not fail. A tool that refuses does.

**Honest limits**

The protected list is opinionated and Windows-first (that was the incident platform). It is not a sandbox and does not stop a determined `rm -rf` that never goes through it. What it changes is that the *default* destructive path — the one an agent reaches for when asked to clean up — is now reversible.

MIT, zero dependencies, Node 18+. Feedback on the refusal list very welcome.

https://github.com/ChoYugyeong/safe-ops
