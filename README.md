# safe-ops

[![test](https://github.com/ChoYugyeong/safe-ops/actions/workflows/test.yml/badge.svg)](https://github.com/ChoYugyeong/safe-ops/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

**Delete nothing you cannot restore.**

A coding-agent skill, and a zero-dependency CLI underneath it, for the operations that destroy data: `rm -rf`, `Remove-Item -Recurse`, `del /s`, `rmdir`, `git clean`, cache wipes, uninstalls, and "just make it clean".

Instead of deleting, it moves. Instead of trusting a prompt, it refuses. Instead of running concurrently, it locks.

```
$ node bin/safetrash.cjs plan --path ~/.claude --path ./build
DENY C:\Users\me\.claude  (protected path: C:\Users\me\.claude)
OK   C:\dev\project\build  [directory, 1431 item(s), 82.4 MB]
TOTAL 2 path(s), 1432 item(s), 82.4 MB
```

---

## Contents

- [The failure this answers](#the-failure-this-answers)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Install](#install)
- [Usage](#usage)
- [Protected paths](#protected-paths)
- [Safety model](#safety-model)
- [What it does not protect](#what-it-does-not-protect)
- [Design decisions](#design-decisions)
- [Tests and CI](#tests-and-ci)
- [FAQ](#faq)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## The failure this answers

An agent was asked to audit a small Python package. The audit skill it was following required target code to run inside "an empty environment with scratch-local `HOME`, temporary directories, and caches". There was no OS sandbox on the machine. The skill's documentation *said* that without one the workflow must not execute target code — but that was prose, and prose does not fail.

So the agent satisfied the requirement itself: instead of building an empty environment beside the current one, it emptied the current one.

Gone, permanently: a tool's configuration directory including months of conversation history, 128 installed skills, SSH keys, npm configuration, and the system Python standard library. No Recycle Bin (programmatic recursive remove), no volume shadow copies, and the session transcript lived inside the deleted directory — so the evidence of what ran went with it.

The instinct was not malicious. "Make it clean" is a normal request. What made it catastrophic is that the destructive path had **no measurement, no refusal, and no recovery**.

The full account is in [docs/INCIDENT.md](docs/INCIDENT.md). The fail-closed check for that audit skill is [cloudflare/security-audit-skill#129](https://github.com/cloudflare/security-audit-skill/pull/129).

## What it does

| Command | What happens |
|---|---|
| `plan` | Resolves every path, classifies it, measures it (items + bytes), and prints a total. Changes nothing. |
| `apply` | Takes the host lock, moves each target into `~/.safe-trash/<id>/`, verifies the move landed, records a sha256 per file, writes `manifest.json`, appends `audit.log`. |
| `list` | Shows quarantine transactions with size, reason, and owner. |
| `restore` | Moves targets back, verifying the recorded checksums. Refuses to overwrite an existing path. |
| `purge` | The only irreversible command. Deletes a transaction after the restore window. |
| `host-lock` | An exclusive lock for install / upgrade / uninstall so two agents cannot mutate the machine at once. |

Plus one rule the tool enforces rather than describes:

- **Refusals** — the home directory, tool config roots, `%LOCALAPPDATA%\Programs`, Program Files, drive roots, **and any ancestor of those**. Wildcards, symlinks and junctions. Anything modified in the last five minutes, unless `--allow-recent` acknowledges a live application owns it.

## How it works

```
plan ──► resolve ──► classify ──► measure ──► report
                        │
                        ├─ protected root?        → DENY (and any ancestor of one)
                        ├─ wildcard / link?       → DENY
                        ├─ missing?               → DENY
                        └─ changed < 5 min?       → OK, but flagged

apply ──► host lock ──► rename into ~/.safe-trash/<id>/ ──► verify ──► sha256 ──► manifest ──► audit
                              │
                              └─ any DENY in the plan, lock held, or unacknowledged recent change → refuse whole transaction

restore ──► manifest ──► checksum verify ──► refuse if destination exists ──► rename back ──► audit
```

A transaction directory looks like this:

```
~/.safe-trash/20261101-193000/
  manifest.json           # id, reason, owner, host, totals, per-entry path/hash/verified
  audit.log               # JSONL, append-only
  00-build/               # the moved target, prefixed by index
  01-notes.txt
```

The manifest is the contract: it is what `restore` reads, what the checksum is verified against, and what tells you weeks later why something is sitting in quarantine.

## Install

### As a Claude Code plugin

```
/plugin marketplace add ChoYugyeong/safe-ops
/plugin install safe-ops@cho-yugyeong
```

### As a skill directory

```bash
git clone https://github.com/ChoYugyeong/safe-ops.git
cd safe-ops
./install.sh                                     # -> ~/.claude/skills/safe-ops
./install.sh "$HOME/.agents/skills/safe-ops"     # agent-neutral location
```

```powershell
.\install.ps1                                    # -> %USERPROFILE%\.claude\skills\safe-ops
.\install.ps1 -Destination "$env:USERPROFILE\.agents\skills\safe-ops"
```

### Requirements

Node.js 18 or newer. No dependencies. No network access. Windows, macOS and Linux (Windows-first — that is where the incident happened).

## Usage

### Plan before you move anything

```bash
node bin/safetrash.cjs plan --path ./build --path ./dist
```

```
OK   C:\dev\app\build  [directory, 1431 item(s), 82.4 MB]
OK   C:\dev\app\dist   [directory, 12 item(s), 1.1 MB]
TOTAL 2 path(s), 1443 item(s), 83.5 MB
```

`plan` exits `1` if any entry is refused, so it can be used as a gate in a script.

### Apply

```bash
node bin/safetrash.cjs apply \
  --path ./build --path ./dist \
  --reason "regenerate after dependency bump" \
  --yes --owner ci-agent
```

```json
{"applied":true,"id":"20261101-193000","dir":".../20261101-193000","moved":2,"bytes":87552000}
```

`apply` refuses the whole transaction when any path is denied, when the lock is held, or when a target changed inside the recency window. It does not do partial work.

| Flag | Meaning |
|---|---|
| `--path <p>` | repeatable; the targets |
| `--reason "<why>"` | required; recorded in the manifest and audit log |
| `--yes` | required; the operator's acknowledgement |
| `--allow-recent` | acknowledge that a live application owns a recently modified target |
| `--owner <id>` | who took the lock and holds the transaction |

### Recover

```bash
node bin/safetrash.cjs list
# 20261101-193000  2 item(s)  83.5 MB  regenerate after dependency bump

node bin/safetrash.cjs restore --id 20261101-193000 --yes
# {"restored":["...build","...dist"],"problems":[],"id":"20261101-193000"}
```

A `problems` entry — `checksum mismatch`, `missing in quarantine` — is reported per file and never silently dropped. Restore will not overwrite a path that exists again.

### Purge

```bash
node bin/safetrash.cjs purge --id 20261101-193000 --yes
```

Only after the restore window has passed. This is the one command that destroys data, and it is recorded.

### Host mutations

```bash
node bin/host-lock.cjs acquire --lock ./run/.host.lock --owner ci-agent --purpose "install deps"
# exactly one mutation
node bin/host-lock.cjs release --lock ./run/.host.lock --owner ci-agent
```

If the lock is held, stop and report the holder. A stale lock can be reclaimed with `--force` after its TTL.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | success |
| `1` | refused / not found (a `DENY`, a held lock, a bad plan) |
| `2` | usage error |

## Protected paths

Built in, refused, and their ancestors refused too:

- the home directory itself
- `~/.claude`, `~/.dsh`, `~/.agents`, `~/.ssh`, `~/.aws`, `~/.config`, `~/.gnupg`, `~/.memdex`, `~/.reason`, `~/.safe-trash`
- `%LOCALAPPDATA%\Programs`, `%LOCALAPPDATA%\Packages`, `%LOCALAPPDATA%\Temp\claude`
- `%APPDATA%`
- `C:\Windows`, `C:\Program Files`, `C:\Program Files (x86)`, `C:\ProgramData`
- any filesystem root

The ancestor rule matters more than the list: deleting `C:\Users\me` destroys `C:\Users\me\.claude` just as thoroughly as naming it directly, so the tool refuses both.

Extend the list with absolute paths:

```json
["C:\\Users\\me\\AppData\\Local\\SomeTool", "D:\\work\\shared-config"]
```

```bash
cat > ~/.safe-ops/protected.json <<'JSON'
["C:\\Users\\me\\AppData\\Local\\SomeTool"]
JSON
```

Use this for paths that must *never* be deleted — not for paths you merely want to be careful with.

## Safety model

**Recoverable by construction.** A target is moved, not removed. Until `purge`, the data exists in the quarantine with a manifest that names its origin.

**Verified, not assumed.** `apply` checks that each target arrived at its destination before writing the manifest. `restore` re-hashes every file it recorded. A tampered or truncated file is reported, not restored.

**Serialized.** `apply` holds the host lock for the duration of the move. Two agents cannot quarantine or restore at the same time, and one cannot restore a transaction the other is creating.

**Audited.** Every `apply`, `restore`, `purge` (and failed apply) appends a JSONL line with time, owner, reason, paths, and bytes. The audit log never blocks the operation it records.

**Fail-closed.** Missing evidence is a refusal: an unset `HOME`, an unreadable manifest, an unresolvable path, a wildcard — all refuse rather than guess.

## What it does not protect

Honest limits, because a safety tool that overstates itself is worse than none:

- **It is not a sandbox.** Code that calls `rm -rf` directly, or a hostile process, bypasses it entirely. It changes the *default* path an agent takes when asked to clean up.
- **`purge` is irreversible.** Nothing can undo it, by design.
- **The quarantine is not encrypted.** Treat it with the same care as the original data.
- **Measurement is capped** at 200,000 entries per target; a capped total is a floor, not a promise.
- **Windows-first.** The protected list is opinionated toward Windows developer machines. POSIX paths are compared case-sensitively, Windows paths case-insensitively, but the default list is not a complete POSIX policy.
- **A live app can still lose its data** if you pass `--allow-recent` and you are wrong about which app owns the files.

## Design decisions

**Move, never delete.** A delete is irreversible in one direction only. A move costs one rename and keeps every escape hatch open.

**Measure before acting.** People do not delete 80 MB they can see; they delete it when it is an abstract glob. Numbers make the target concrete.

**Refuse in the tool, not the prompt.** The incident's original guard rail was a paragraph an agent could reason its way past. A refusal is something the agent must actively work around, and the workaround is visible in the transcript.

**Ancestors count.** Most protected-path lists check equality and miss `C:\Users\me`.

**Recency is a signal.** A directory modified 30 seconds ago has an owner. Treating "modified recently" as "probably live" catches the case where an agent cleans a cache that an application is currently writing.

**No wildcards.** `--path build/*` means something different in every shell. The tool requires explicit paths and refuses patterns, so the blast radius is always something a human named.

**Checksums, not sizes.** A restore that silently brings back a truncated file is worse than one that refuses.

## Tests and CI

```bash
npm test        # node --test
```

30 dependency-free tests:

- refusals — home, protected root, ancestor of a protected root, wildcard, missing path, symlink
- measurement — nested counts, byte sums, capped totals
- recency guard — refusal without acknowledgement, success with it
- integrity — checksum recorded, tamper detected, no overwrite on restore
- concurrency — a held lock refuses the transaction
- audit — apply/restore/purge lines, ids and actions
- CLI — exit codes, `--json`, apply → list → restore round-trip

CI runs the matrix on Linux, Windows and macOS against Node 18, 20 and 22.

## FAQ

**Does this replace backups?**
No. It replaces `rm -rf` with something reversible. Backups protect against disk loss; this protects against a command you regret for ten minutes.

**What if the move fails halfway?**
The transaction stops and is recorded as `apply-failed` in the audit log. Entries already moved stay in the quarantine and are restorable from the manifest.

**Why not just use the OS trash?**
On Windows, programmatic recursive deletes do not go to the Recycle Bin, and the Recycle Bin is routinely emptied by cleanup tooling. A quarantine the agent controls and the manifest that describes it are the point.

**Why does `restore` refuse to overwrite?**
Because "restore" that silently clobbers a newer file is another data-loss event. Resolve the conflict by hand, then restore.

**Can I run it inside CI?**
Yes — `plan` exits non-zero on any refusal, so it works as a gate, and `apply --owner ci` records who did what.

## Roadmap

- [ ] `status --json` for the quarantine as a whole (age, size, restore window)
- [ ] Optional compression of large quarantined trees
- [ ] A `safetrash check` that scans shell history and agent transcripts for unguarded destructive commands
- [ ] POSIX policy profile alongside the Windows default

Ideas and disagreement are welcome in issues — especially about what belongs on the refusal list.

## Contributing

- Bug reports: the platform, the exact `plan`/`apply` invocation, and the resolved path the tool accepted.
- A refusal that is too aggressive is a bug; a refusal that is too narrow is a security issue. See [SECURITY.md](SECURITY.md).
- Run `npm test` before opening a PR. Keep dependencies at zero — that is a feature, not a coincidence.

## License

MIT — see [LICENSE](LICENSE).
