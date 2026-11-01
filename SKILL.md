---
name: safe-ops
description: Guard rails for destructive operations — deleting, moving, resetting, installing, or "cleaning" anything outside the project. Use before rm -rf / Remove-Item -Recurse / del /s / rmdir / git clean, before uninstalling or reinstalling software, before wiping caches or "creating a clean environment", and whenever a task is described as cleanup, reset, prune, or free-up-space. Moves targets into a recoverable quarantine with checksums instead of deleting them, refuses protected paths, and serializes host mutations behind an exclusive lock.
---

# Safe Ops

A delete is irreversible in one direction only. A move can be undone, a delete cannot. This skill replaces deleting with quarantining, refuses paths that must never be touched, and makes host mutations take turns.

Load it whenever a task says **delete, clean, purge, reset, remove, uninstall, reinstall, free space, or start from a clean environment**.

## The rules

1. **Never delete with a computed path.** No `rm -rf "$VAR"`, no `Remove-Item -Recurse $path`, no `del /s %X%` where the value can be empty, relative, or wrong. Expand it, print the resolved absolute path, read it back, then act.
2. **Never delete what you can move.** `safetrash` moves the target into `~/.safe-trash/<transaction>/` with a manifest and checksums; `restore` puts it back. `purge` is a separate, deliberate step.
3. **Never touch the protected roots** — the home directory, `~/.claude`, `~/.dsh`, `~/.agents`, `~/.ssh`, `~/.aws`, `~/.config`, `~/.gnupg`, `%LOCALAPPDATA%\Programs`, `%LOCALAPPDATA%\Packages`, `%APPDATA%`, `C:\Windows`, `C:\Program Files`, `C:\ProgramData`, drive roots — **and any ancestor of those**. The tool refuses them; do not work around a refusal by shortening the path.
4. **One host mutation at a time, under a lock.** Installing, upgrading, uninstalling, or resetting software takes `host-lock`. Two installers at once abort each other and leave half-written state.
5. **A clean environment is built beside the current one**, never by emptying it. Deleting config, caches, interpreters, or credentials to "simulate a fresh machine" destroys the machine you were asked to test on.

## Workflow

**Plan first, and read the totals.** Every line must read `OK` with an absolute path you recognise; `DENY` stops the task.

```bash
node bin/safetrash.cjs plan --path <target> [--path <target>]
```

The plan prints per-target kind, item count, bytes, and a `TOTAL`. Two warnings matter:

- `RECENTLY MODIFIED` — the target changed in the last 5 minutes. A live application owns it. `apply` will refuse until you pass `--allow-recent`, and you should know which app that is before you do.
- `size capped` — the tree exceeded the measurement cap; the byte total is a floor, not a promise.

**Apply only after the user has seen the resolved paths.** `--yes` is the operator's acknowledgement, not a formality.

```bash
node bin/safetrash.cjs apply --path <target> --reason "<why>" --yes [--allow-recent] --owner <agent-id>
```

`apply` takes the host lock, moves each target, verifies it arrived, records a sha256 for every file, writes `manifest.json`, and appends to `audit.log`. It refuses the whole transaction if any path is denied, if the lock is held, or if anything was modified inside the recency window.

**Recover when something turns out to be needed:**

```bash
node bin/safetrash.cjs list
node bin/safetrash.cjs restore --id <transaction> [--only <name>] --yes
```

Restore verifies the checksum it recorded. A `checksum mismatch` or `missing in quarantine` is reported per file, never force-overwritten, and never silently dropped.

**Purge only after the restore window has passed** — that is the one irreversible command:

```bash
node bin/safetrash.cjs purge --id <transaction> --yes
```

**Host mutations** (install / upgrade / uninstall / reset):

```bash
node bin/host-lock.cjs acquire --lock <run-dir>/.host.lock --owner <agent-id> --purpose "<what>"
# exactly one mutation
node bin/host-lock.cjs release --lock <run-dir>/.host.lock --owner <agent-id>
```

If the lock is held, stop and report the holder. Never retry in a loop.

## Extending the protected list

Add absolute paths to `~/.safe-ops/protected.json`:

```json
["C:\\Users\\me\\AppData\\Local\\SomeTool", "D:\\work\\shared-config"]
```

They are merged with the built-in list. This is for paths that must never be deleted, not for paths you merely want to be careful with.

## Report before acting

Print this, filled in, before the first mutation:

```
Target(s):   <absolute resolved paths + item count + size>
Operation:   quarantine (recoverable) | host mutation (locked)
Reason:      <one line>
Restore:     node bin/safetrash.cjs restore --id <id> --yes
Protected:   none of the protected roots are involved
```

If any line is unknown or empty, do not proceed.

## Anti-patterns

1. `Remove-Item -Recurse -Force $path` where `$path` was built rather than verified.
2. Deleting "just the cache" of a tool whose config lives beside it.
3. Emptying `%LOCALAPPDATA%\Programs`, `~/.claude`, or a Python `Lib` directory to get a clean slate.
4. Running two installers concurrently, or re-running a failed installer in a loop.
5. Widening a refusal (`…\.claude` denied → try `…`) instead of stopping.
6. Treating "the user said clean up" as authorisation to delete anything they did not name.
7. Deleting a live application's data while it runs, then reporting the crash as a new bug.
