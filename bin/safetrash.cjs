#!/usr/bin/env node

/**
 * safetrash — destructive operations that are recoverable by construction.
 *
 * Nothing is deleted. Paths are resolved, measured, classified, and moved into a
 * quarantine directory with a manifest (including checksums), so any transaction
 * can be restored and verified.
 *
 * Design notes, learned from a real incident where an agent emptied a user
 * profile to "create a clean environment":
 *   - measurements first: `plan` prints byte and item totals, so a big delete is
 *     visible before anything moves
 *   - a recency guard: targets modified in the last 5 minutes are refused unless
 *     `--allow-recent` acknowledges that a live application owns them
 *   - a host lock: concurrent apply/restore cannot interleave
 *   - move verification plus sha256 in the manifest, re-checked on restore
 *   - an audit log (JSONL) of every apply/restore/purge
 *   - wildcards and links are refused rather than resolved
 *   - protected paths are extensible via ~/.safe-ops/protected.json
 *
 * Usage:
 *   node safetrash.cjs plan    --path <p> [--path <p>] [--json]
 *   node safetrash.cjs apply   --path <p> [...] --reason "<why>" --yes [--allow-recent] [--owner <id>]
 *   node safetrash.cjs list    [--json]
 *   node safetrash.cjs restore --id <txn> [--only <name>] --yes [--owner <id>]
 *   node safetrash.cjs purge   --id <txn> --yes [--owner <id>]
 *
 * Exit codes: 0 ok, 1 refused / not found, 2 usage error.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const QUARANTINE_ROOT = path.join(os.homedir(), ".safe-trash");
const CONFIG_PATH = path.join(os.homedir(), ".safe-ops", "protected.json");
const AUDIT_LOG = "audit.log";
const MANIFEST = "manifest.json";
const RECENT_MS = 5 * 60 * 1000;
const SIZE_CAP_ENTRIES = 200000;
const WILDCARD = /[*?[\]]/;

let hostLock = null;
try {
  // Optional: present in the packaged skill, absent in a bare checkout.
  hostLock = require("./host-lock.cjs");
} catch (error) {
  hostLock = null;
}

/** Absolute paths that must never be the target of a destructive operation. */
function protectedRoots(env = process.env) {
  const home = os.homedir();
  const roots = [
    home,
    path.join(home, ".claude"),
    path.join(home, ".dsh"),
    path.join(home, ".agents"),
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, ".config"),
    path.join(home, ".gnupg"),
    path.join(home, ".memdex"),
    path.join(home, ".reason"),
    path.join(home, ".safe-trash"),
  ];
  if (env.LOCALAPPDATA) {
    roots.push(
      path.join(env.LOCALAPPDATA, "Programs"),
      path.join(env.LOCALAPPDATA, "Packages"),
      path.join(env.LOCALAPPDATA, "Temp", "claude"),
      path.join(env.LOCALAPPDATA, "Microsoft"),
    );
  }
  if (env.APPDATA) roots.push(env.APPDATA);
  roots.push("C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData");

  try {
    const extra = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (Array.isArray(extra)) {
      for (const entry of extra) {
        if (typeof entry === "string" && entry.trim()) roots.push(entry.trim());
      }
    }
  } catch (error) {
    // No user config, or unreadable: the built-in list still applies.
  }
  return roots;
}

/** Expand %VAR%, $VAR and ~, then resolve to an absolute path. */
function expandPath(input, env = process.env) {
  if (typeof input !== "string" || input.trim() === "") throw new Error("empty path");
  let value = input.trim().replace(/^"(.*)"$/, "$1");
  value = value.replace(/%([^%]+)%/g, (whole, name) => (env[name] !== undefined ? env[name] : whole));
  value = value.replace(/\$\{([^}]+)\}/g, (whole, name) => (env[name] !== undefined ? env[name] : whole));
  if (value === "~") value = os.homedir();
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
}

function normalize(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrInside(child, parent) {
  const c = normalize(child);
  const p = normalize(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Measure a path without following links; capped so a huge tree cannot hang a plan. */
function measure(target) {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) return { bytes: stat.size, entries: 1, mtimeMs: stat.mtimeMs };
  let bytes = 0;
  let entries = 0;
  const stack = [target];
  while (stack.length > 0 && entries < SIZE_CAP_ENTRIES) {
    const current = stack.pop();
    let items;
    try {
      items = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      continue;
    }
    for (const item of items) {
      entries += 1;
      const full = path.join(current, item.name);
      if (item.isDirectory() && !item.isSymbolicLink()) stack.push(full);
      else if (item.isFile()) {
        try {
          bytes += fs.statSync(full).size;
        } catch (error) {
          // Raced with the owning application: the measurement is a floor.
        }
      }
    }
  }
  return { bytes, entries, mtimeMs: stat.mtimeMs, capped: entries >= SIZE_CAP_ENTRIES };
}

/**
 * Classify one path. Refused when it is a filesystem root, the home directory, a
 * protected root, an ancestor of a protected root, a wildcard, or a link.
 */
function classify(target, options = {}) {
  const env = options.env || process.env;
  const roots = options.protectedRoots || protectedRoots(env);
  const now = options.now || Date.now();

  if (WILDCARD.test(String(target))) {
    return { input: target, resolved: null, ok: false, reason: "wildcard pattern; list exact paths" };
  }

  const resolved = expandPath(target, env);

  if (path.dirname(resolved) === resolved) {
    return { input: target, resolved, ok: false, reason: "filesystem root" };
  }
  if (normalize(resolved) === normalize(os.homedir())) {
    return { input: target, resolved, ok: false, reason: "home directory" };
  }
  for (const root of roots) {
    if (normalize(resolved) === normalize(root)) {
      return { input: target, resolved, ok: false, reason: `protected path: ${root}` };
    }
  }
  for (const root of roots) {
    if (isSameOrInside(root, resolved) && normalize(root) !== normalize(resolved)) {
      return { input: target, resolved, ok: false, reason: `ancestor of protected path: ${root}` };
    }
  }

  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    return { input: target, resolved, ok: false, reason: "does not exist" };
  }

  if (stat.isSymbolicLink()) {
    return { input: target, resolved, ok: false, reason: "symbolic link or junction; resolve it explicitly" };
  }

  const size = measure(resolved);
  const recent = now - size.mtimeMs < RECENT_MS;
  return {
    input: target,
    resolved,
    ok: true,
    reason: "ok",
    kind: stat.isDirectory() ? "directory" : "file",
    bytes: size.bytes,
    entries: size.entries,
    capped: Boolean(size.capped),
    mtimeMs: size.mtimeMs,
    recent,
  };
}

function plan(paths, options = {}) {
  const entries = (paths || []).map((entry) => classify(entry, options));
  const ok = entries.length > 0 && entries.every((entry) => entry.ok);
  const totalBytes = entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0);
  const totalEntries = entries.reduce((sum, entry) => sum + (entry.entries || 0), 0);
  const warnings = [];
  for (const entry of entries) {
    if (entry.ok && entry.recent) warnings.push(`recently modified (<5m): ${entry.resolved}`);
    if (entry.ok && entry.capped) warnings.push(`size capped at ${SIZE_CAP_ENTRIES} entries: ${entry.resolved}`);
  }
  return { ok, entries, totalBytes, totalEntries, warnings };
}

function transactionId(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function fileHash(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function audit(quarantine, record) {
  try {
    fs.mkdirSync(quarantine, { recursive: true });
    fs.appendFileSync(path.join(quarantine, AUDIT_LOG), JSON.stringify(record) + "\n", "utf8");
  } catch (error) {
    // The audit log must never block the operation it records.
  }
}

/** Pick a destination name that cannot collide inside this transaction. */
function destinationFor(dir, index, name, taken) {
  let candidate = `${String(index).padStart(2, "0")}-${name}`;
  let suffix = 1;
  while (taken.has(candidate) || fs.existsSync(path.join(dir, candidate))) {
    candidate = `${String(index).padStart(2, "0")}-${name}.${suffix}`;
    suffix += 1;
  }
  taken.add(candidate);
  return candidate;
}

/**
 * Move every planned entry into the quarantine and record it.
 * Refuses the whole transaction if any entry is not ok, or if a target changed
 * within the recency window and `allowRecent` was not given.
 */
function apply(planned, options = {}) {
  if (!options.reason || !String(options.reason).trim()) throw new Error("a reason is required");
  if (!planned || !planned.ok) return { applied: false, reason: "refused", entries: planned ? planned.entries : [] };

  const recentHits = planned.entries.filter((entry) => entry.recent);
  if (recentHits.length > 0 && !options.allowRecent) {
    return {
      applied: false,
      reason: `refusing: ${recentHits.length} target(s) modified in the last 5 minutes (pass --allow-recent if a live app owns them)`,
      entries: recentHits,
    };
  }

  const root = options.quarantine || QUARANTINE_ROOT;
  const id = options.id || transactionId();
  const dir = path.join(root, id);
  const lockPath = options.lockPath || path.join(root, ".safe-trash.lock");
  const owner = options.owner || "";

  let held = false;
  if (hostLock && owner) {
    try {
      hostLock.acquireLock({ lockPath, owner, purpose: `quarantine ${planned.entries.length} path(s)` });
      held = true;
    } catch (error) {
      return { applied: false, reason: `lock: ${error.message}`, entries: [] };
    }
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    const manifest = {
      id,
      reason: String(options.reason).trim(),
      owner: owner || "unknown",
      host: os.hostname(),
      createdAt: new Date().toISOString(),
      tool: "safetrash",
      totalBytes: planned.totalBytes,
      totalEntries: planned.totalEntries,
      entries: [],
    };
    const taken = new Set();

    for (const [index, entry] of planned.entries.entries()) {
      const storedAs = destinationFor(dir, index, path.basename(entry.resolved), taken);
      const destination = path.join(dir, storedAs);
      const hash = entry.kind === "file" ? fileHash(entry.resolved) : null;

      fs.renameSync(entry.resolved, destination);

      const arrived = fs.existsSync(destination);
      const verified = arrived && (entry.kind === "file"
        ? fs.statSync(destination).size >= 0 && !fs.statSync(destination).isDirectory()
        : fs.statSync(destination).isDirectory());
      if (!verified) throw new Error(`move verification failed: ${entry.resolved}`);

      manifest.entries.push({ ...entry, storedAs, hash, verified, movedAt: new Date().toISOString() });
    }

    fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2), "utf8");
    audit(root, {
      at: manifest.createdAt,
      action: "apply",
      id,
      owner: manifest.owner,
      reason: manifest.reason,
      paths: manifest.entries.map((entry) => entry.resolved),
      bytes: manifest.totalBytes,
    });
    return { applied: true, id, dir, manifest };
  } catch (error) {
    audit(root, { at: new Date().toISOString(), action: "apply-failed", id, reason: String(options.reason), error: error.message });
    throw error;
  } finally {
    if (held) {
      try {
        hostLock.releaseLock({ lockPath, owner });
      } catch (error) {
        // A stale lock expires on its own TTL.
      }
    }
  }
}

function list(options = {}) {
  const root = options.quarantine || QUARANTINE_ROOT;
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      let manifest = null;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(root, entry.name, MANIFEST), "utf8"));
      } catch (error) {
        manifest = null;
      }
      return { id: entry.name, dir: path.join(root, entry.name), manifest };
    })
    .sort((a, b) => (a.id < b.id ? 1 : -1));
}

/** Restore a transaction, verifying checksums where they were recorded. */
function restore(id, options = {}) {
  const root = options.quarantine || QUARANTINE_ROOT;
  const dir = path.join(root, id);
  const manifestPath = path.join(dir, MANIFEST);
  if (!fs.existsSync(manifestPath)) return { restored: [], problems: [], reason: "transaction not found" };

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const wanted = options.only
    ? manifest.entries.filter((entry) => path.basename(entry.resolved) === options.only)
    : manifest.entries;

  const restored = [];
  const problems = [];
  for (const entry of wanted) {
    const source = path.join(dir, entry.storedAs);
    if (!fs.existsSync(source)) {
      problems.push(`missing in quarantine: ${entry.storedAs}`);
      continue;
    }
    if (fs.existsSync(entry.resolved)) throw new Error(`refusing to overwrite existing path: ${entry.resolved}`);
    if (entry.hash && entry.kind === "file") {
      if (fileHash(source) !== entry.hash) {
        problems.push(`checksum mismatch: ${entry.storedAs}`);
        continue;
      }
    }
    fs.mkdirSync(path.dirname(entry.resolved), { recursive: true });
    fs.renameSync(source, entry.resolved);
    restored.push(entry.resolved);
  }
  audit(root, {
    at: new Date().toISOString(),
    action: "restore",
    id,
    owner: options.owner || "unknown",
    restored: restored.length,
    problems,
  });
  return { restored, problems, id };
}

function purge(id, options = {}) {
  const root = options.quarantine || QUARANTINE_ROOT;
  const dir = path.join(root, id);
  if (!fs.existsSync(dir)) return { purged: false, reason: "transaction not found" };
  fs.rmSync(dir, { recursive: true, force: true });
  audit(root, { at: new Date().toISOString(), action: "purge", id, owner: options.owner || "unknown" });
  return { purged: true, id };
}

function humanBytes(n) {
  const units = ["B", "KB", "MB", "GB"];
  let value = Number(n) || 0;
  for (const unit of units) {
    if (value < 1024 || unit === "GB") return `${value.toFixed(unit === "B" ? 0 : 1)} ${unit}`;
    value /= 1024;
  }
  return `${value} B`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command, paths: [], reason: "", yes: false, json: false, id: "", owner: "", only: "", allowRecent: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const next = () => {
      index += 1;
      if (index >= rest.length) throw new Error(`missing value for ${flag}`);
      return rest[index];
    };
    switch (flag) {
      case "--path": options.paths.push(next()); break;
      case "--reason": options.reason = next(); break;
      case "--id": options.id = next(); break;
      case "--owner": options.owner = next(); break;
      case "--only": options.only = next(); break;
      case "--yes": options.yes = true; break;
      case "--allow-recent": options.allowRecent = true; break;
      case "--json": options.json = true; break;
      default: throw new Error(`unknown argument: ${flag}`);
    }
  }
  return options;
}

function renderPlan(result) {
  const lines = result.entries.map((entry) => {
    if (!entry.ok) return `DENY ${entry.resolved || entry.input}  (${entry.reason})`;
    const bits = [entry.kind, `${entry.entries} item(s)`, humanBytes(entry.bytes)];
    if (entry.recent) bits.push("RECENTLY MODIFIED");
    if (entry.capped) bits.push("size capped");
    return `OK   ${entry.resolved}  [${bits.join(", ")}]`;
  });
  lines.push(`TOTAL ${result.entries.length} path(s), ${result.totalEntries} item(s), ${humanBytes(result.totalBytes)}`);
  for (const warning of result.warnings) lines.push(`WARN ${warning}`);
  return lines.join("\n") + "\n";
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
    switch (options.command) {
      case "plan": {
        const result = plan(options.paths);
        process.stdout.write(options.json ? JSON.stringify(result, null, 2) + "\n" : renderPlan(result));
        return result.ok ? 0 : 1;
      }
      case "apply": {
        if (!options.yes) {
          process.stderr.write("refusing to apply without --yes\n");
          return 2;
        }
        const planned = plan(options.paths);
        const result = apply(planned, { ...options, quarantine: process.env.SAFETRASH_ROOT || undefined });
        process.stdout.write(
          JSON.stringify({
            applied: result.applied,
            id: result.id,
            dir: result.dir,
            moved: result.manifest ? result.manifest.entries.length : 0,
            bytes: result.manifest ? result.manifest.totalBytes : 0,
            refused: result.reason,
          }) + "\n",
        );
        return result.applied ? 0 : 1;
      }
      case "list": {
        const items = list({ quarantine: process.env.SAFETRASH_ROOT });
        process.stdout.write(
          options.json
            ? JSON.stringify(items, null, 2) + "\n"
            : items
                .map((item) =>
                  item.manifest
                    ? `${item.id}  ${item.manifest.entries.length} item(s)  ${humanBytes(item.manifest.totalBytes)}  ${item.manifest.reason}`
                    : `${item.id}  manifest unreadable`)
                .join("\n") + "\n",
        );
        return 0;
      }
      case "restore": {
        if (!options.yes) return 2;
        const result = restore(options.id, { ...options, quarantine: process.env.SAFETRASH_ROOT });
        process.stdout.write(JSON.stringify(result) + "\n");
        return result.restored.length > 0 ? 0 : 1;
      }
      case "purge": {
        if (!options.yes) return 2;
        const result = purge(options.id, { ...options, quarantine: process.env.SAFETRASH_ROOT });
        process.stdout.write(JSON.stringify(result) + "\n");
        return result.purged ? 0 : 1;
      }
      default:
        throw new Error("command must be plan, apply, list, restore, or purge");
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  AUDIT_LOG,
  QUARANTINE_ROOT,
  RECENT_MS,
  apply,
  classify,
  expandPath,
  humanBytes,
  list,
  measure,
  plan,
  protectedRoots,
  purge,
  restore,
};
