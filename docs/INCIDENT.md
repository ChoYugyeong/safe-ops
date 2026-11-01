# The incident this project comes from

A first-party account of the failure, kept here because the design decisions only make sense with it. It is also the honest answer to "why another safety tool".

## What the agent was asked to do

Audit a small Python package. The audit skill being followed required target code to run inside "an empty environment populated from an explicit allowlist with safe values, with scratch-local `HOME`, temporary directories, and caches".

That is a reasonable requirement. It describes the *state* the sandbox should be in.

## What it could not do

There was no OS-enforced sandbox on the machine. The skill's own documentation says that without one, the workflow should keep every lead as `needs_validation` instead of executing target code — but that is prose, not a gate. There was nothing to fail.

So the agent did what an agent does when a requirement is stated but not enforced: it satisfied the requirement itself. Instead of building an empty environment beside the current one, it emptied the current one.

## What was destroyed

- a tool's configuration directory, including months of conversation history
- 128 installed skills
- SSH keys and npm configuration
- the system Python's standard library (`python` stopped starting)
- caches and application data for several desktop apps, one of which then crash-looped on its own encrypted database

None of it went to the Recycle Bin, because the deletion was a programmatic recursive remove. There were no volume shadow copies. The session transcripts lived inside the deleted directory, so the evidence of what ran went with it.

Hours later, the machine's remaining failures were still being discovered one app at a time.

## The three properties that were missing

1. **Measurement.** Nothing printed what was about to be removed — no count, no size, no resolved absolute path.
2. **Refusal.** Nothing knew that `~/.claude`, `%LOCALAPPDATA%\Programs`, and the home directory itself are not deletable. Not a single check said no.
3. **Recovery.** The operation was `delete`, not `move`. Once it ran, nothing could be undone.

Every design choice in this repository is one of those three, applied to a specific failure:

| Missing property | What `safe-ops` does |
|---|---|
| measurement | `plan` prints resolved paths, item counts, byte totals, and flags recently modified targets |
| refusal | protected roots, their ancestors, wildcards, links, and live-app data are refused by the tool |
| recovery | targets are *moved* into `~/.safe-trash` with a sha256 manifest; `restore` verifies and refuses to overwrite |

## What would have prevented it outright

The isolation gate and host lock in [cloudflare/security-audit-skill#129](https://github.com/cloudflare/security-audit-skill/pull/129): prove the scratch environment exists before running target code, and serialize anything that mutates the host.

`safe-ops` is the other half — it assumes the agent will sometimes try anyway, and makes that attempt reversible.

## The lesson, stated plainly

An instruction that describes a desired state does not create it. If a rule matters, it needs a check that fails when the rule is violated, and a tool that makes the safe path shorter than the unsafe one.

A "clean environment" is built beside the current one. Never by emptying it.
