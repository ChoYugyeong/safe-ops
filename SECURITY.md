# Security policy

## What this project touches

`safe-ops` moves and restores files on the machine it runs on. It is a safety tool, so its own failure modes matter:

- a bug that **widens a refusal** (deleting or moving something the classifier should have protected) is a security issue
- a bug that **restores over an existing path**, or that **skips checksum verification**, is a security issue
- a lock that can be bypassed silently, or an audit entry that can be forged or skipped, is a security issue

## Reporting

Open a regular issue for anything that is not sensitive. For a sensitive report — a bypass of the protected-path list, a traversal that reaches a protected root, or a data-destroying `purge` path — use GitHub's private vulnerability reporting for this repository.

Please include: the platform, the exact `plan`/`apply` invocation, and the resolved path the tool accepted. A reproduction against a temporary directory is ideal.

## Scope

Out of scope: quarantined data being readable by the user who quarantined it (the quarantine is not encrypted and is not meant to be), and destructive operations the operator explicitly runs with `purge`.

## Handling secrets

The repository contains no credentials, tokens, personal paths, or host-specific configuration. `~/.safe-ops/protected.json` is a local, per-machine file and is never committed. If you fork this project, keep `.env`, keys, and machine-specific paths out of commits — `.gitignore` covers the common cases.
