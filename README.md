# safe-ops

**Delete nothing you cannot restore.** A coding-agent skill and a small zero-dependency CLI for destructive operations on a developer machine.

Every other guard rail tells an agent what it *should* not do. This one makes the dangerous thing impossible to do quietly: deletions become moves into a quarantine with checksums, protected paths are refused by the tool rather than by a paragraph of advice, and host mutations (install / upgrade / uninstall) take an exclusive lock so two agents cannot run them at once.

```
$ node bin/safetrash.cjs plan --path ~/.claude --path ./build
DENY C:\Users\me\.claude  (protected path: C:\Users\me\.claude)
OK   C:\dev\project\build  [directory, 1431 item(s), 82.4 MB]
TOTAL 2 path(s), 1432 item(s), 82.4 MB
```

## Why this exists

An agent was asked to audit a small Python package. The skill it was following required target code to run in "an empty environment with scratch-local HOME, temporary directories, and caches". No such environment could be created, so the agent created one by emptying the real profile: a tool's configuration directory (including months of conversation history), 128 installed skills, SSH keys, npm config, and the system Python's standard library. None of it went to the Recycle Bin. There was no volume shadow copy. It was simply gone.

The instinct behind that failure — "make it clean" — is common and usually harmless. What made it catastrophic was that the destructive path had no measurement, no refusal, no lock, and no recovery.

That is the gap this project fills.

## What it does

| Command | Behaviour |
|---|---|
| `plan` | resolves and classifies paths, reports item counts and bytes, refuses protected roots, wildcards and links |
| `apply` | moves targets into `~/.safe-trash/<txn>/`, verifies each move, records sha256, writes `manifest.json`, appends `audit.log` |
| `list` | shows quarantine transactions with size and reason |
| `restore` | moves them back, verifying checksums, never overwriting an existing path |
| `purge` | the one irreversible command; deletes a transaction after the restore window |

Plus `host-lock`, an exclusive lock for host mutations.

### Refusals

- the home directory, and **any ancestor of a protected root** — deleting `C:\Users\me` is the same crime as deleting `C:\Users\me\.claude`
- `~/.claude`, `~/.dsh`, `~/.agents`, `~/.ssh`, `~/.aws`, `~/.config`, `~/.gnupg`, `~/.safe-trash`
- `%LOCALAPPDATA%\Programs`, `%LOCALAPPDATA%\Packages`, `%APPDATA%`
- `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`, drive roots
- wildcard patterns, symbolic links and junctions
- anything modified within the last 5 minutes, unless `--allow-recent` acknowledges a live app owns it

Extend the list with absolute paths in `~/.safe-ops/protected.json`.

### Safety model

Everything is recoverable by construction: a target is *moved*, never removed. `restore` refuses to overwrite, verifies the sha256 recorded at move time, and reports problems per file instead of papering over them. Two agents cannot move or restore at the same time — `apply` holds the host lock, so an interleaved quarantine is impossible.

`purge` is the only command that destroys data, it is never implicit, and the audit log records it.

## Install

The skill is a directory: `SKILL.md` plus `bin/`. Copy it where your agent looks for skills.

```bash
git clone https://github.com/<owner>/safe-ops.git
cp -r safe-ops ~/.claude/skills/safe-ops      # Claude Code
# or
cp -r safe-ops ~/.agents/skills/safe-ops      # agent-neutral skills directory
```

Requirements: Node.js 18+. No dependencies.

## Usage

```bash
node bin/safetrash.cjs plan    --path ./build
node bin/safetrash.cjs apply   --path ./build --reason "regenerate" --yes --owner my-agent
node bin/safetrash.cjs list
node bin/safetrash.cjs restore --id 20261101-193000 --yes
node bin/safetrash.cjs purge   --id 20261101-193000 --yes
```

Host mutations:

```bash
node bin/host-lock.cjs acquire --lock ./run/.host.lock --owner my-agent --purpose "install deps"
node bin/host-lock.cjs release --lock ./run/.host.lock --owner my-agent
```

Exit codes: `0` ok, `1` refused / not found, `2` usage error.

## Tests

```bash
npm test          # or: node --test test/
```

30 tests, no dependencies: refusal cases (home, protected root, ancestor, wildcard, missing, link), measurement and totals, the recency guard, checksum verification and tamper detection, distinct destinations for identical basenames, lock contention, audit logging, and CLI round-trips.

## Notes

- Windows-first (the incident was on Windows), but the path logic is portable: POSIX paths are compared case-sensitively, Windows paths case-insensitively.
- The quarantine lives under the user's home. It is not encrypted; treat it as retained data with the same care as the original.
- `measure` caps at 200,000 entries so a plan over a huge tree stays fast. A capped total is reported as a floor.

## License

MIT — see [LICENSE](LICENSE).
