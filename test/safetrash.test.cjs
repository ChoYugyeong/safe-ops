const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { AUDIT_LOG, apply, classify, expandPath, list, measure, plan, purge, restore } = require("../bin/safetrash.cjs");

const cliPath = path.join(__dirname, "..", "bin", "safetrash.cjs");
const CLI_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "safetrash-cli-"));

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safetrash-"));
  const quarantine = path.join(dir, "quarantine");
  const victim = path.join(dir, "victim");
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, "keep.txt"), "important");
  return { dir, quarantine, victim };
}

function clean(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, SAFETRASH_ROOT: CLI_ROOT },
  });
}

test("expandPath resolves variables and tilde", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" };
  assert.equal(expandPath("%LOCALAPPDATA%\\prog", env), path.resolve("C:\\Users\\x\\AppData\\Local\\prog"));
  assert.equal(expandPath("~"), os.homedir());
});

test("a normal directory is allowed and measured", () => {
  const { dir, victim } = workspace();
  try {
    const result = classify(victim);
    assert.equal(result.ok, true);
    assert.equal(result.kind, "directory");
    assert.equal(result.entries, 1);
    assert.equal(result.bytes, "important".length);
  } finally {
    clean(dir);
  }
});

test("the home directory is refused", () => {
  const result = classify(os.homedir());
  assert.equal(result.ok, false);
  assert.match(result.reason, /home directory/);
});

test("a filesystem root is refused", () => {
  const result = classify(path.parse(os.homedir()).root);
  assert.equal(result.ok, false);
  assert.match(result.reason, /filesystem root/);
});

test("tool configuration directories are refused", () => {
  for (const target of [path.join(os.homedir(), ".claude"), path.join(os.homedir(), ".agents"), path.join(os.homedir(), ".ssh")]) {
    const result = classify(target);
    assert.equal(result.ok, false, target);
    assert.match(result.reason, /protected path/);
  }
});

test("an ancestor of a protected path is refused", () => {
  const parent = path.dirname(path.join(os.homedir(), ".claude"));
  assert.equal(classify(parent).ok, false);
});

test("wildcards are refused instead of expanded", () => {
  const result = classify(path.join(os.tmpdir(), "*"));
  assert.equal(result.ok, false);
  assert.match(result.reason, /wildcard/);
});

test("a missing path is refused", () => {
  const result = classify(path.join(os.tmpdir(), `nope-${Date.now()}`));
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not exist/);
});

test("plan reports totals and refuses the whole batch when one entry is denied", () => {
  const { dir, victim } = workspace();
  try {
    const good = plan([victim]);
    assert.equal(good.ok, true);
    assert.equal(good.totalEntries >= 1, true);
    assert.equal(good.totalBytes >= "important".length, true);

    const mixed = plan([victim, os.homedir()]);
    assert.equal(mixed.ok, false);
    assert.equal(mixed.entries[1].ok, false);
  } finally {
    clean(dir);
  }
});

test("measure counts nested files without following links", () => {
  const { dir, victim } = workspace();
  try {
    fs.mkdirSync(path.join(victim, "nested"));
    fs.writeFileSync(path.join(victim, "nested", "a.txt"), "12345");
    const size = measure(victim);
    // entries counts every child (keep.txt, nested/, nested/a.txt)
    assert.equal(size.entries, 3);
    assert.equal(size.bytes, "important".length + 5);
  } finally {
    clean(dir);
  }
});

test("apply refuses a recently modified target unless allowRecent is set", () => {
  const { dir, quarantine, victim } = workspace();
  try {
    const planned = plan([victim]);
    const refused = apply(planned, { quarantine, reason: "recency guard", owner: "tester" });
    assert.equal(refused.applied, false);
    assert.match(refused.reason, /modified in the last 5 minutes/);
    assert.equal(fs.existsSync(victim), true, "nothing may move without the acknowledgement");

    const allowed = apply(planned, { quarantine, reason: "recency guard", owner: "tester", allowRecent: true });
    assert.equal(allowed.applied, true);
  } finally {
    clean(dir);
  }
});

test("apply moves the target, records checksums and writes an audit log", () => {
  const { dir, quarantine, victim } = workspace();
  try {
    const result = apply(plan([victim]), { quarantine, reason: "test move", owner: "tester", allowRecent: true });
    assert.equal(result.applied, true);
    assert.equal(fs.existsSync(victim), false);

    const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, "manifest.json"), "utf8"));
    assert.equal(manifest.reason, "test move");
    assert.equal(manifest.owner, "tester");
    assert.equal(manifest.entries.length, 1);
    assert.equal(manifest.entries[0].verified, true);
    assert.equal(manifest.totalEntries >= 1, true);

    const log = fs.readFileSync(path.join(quarantine, AUDIT_LOG), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(log.at(-1).action, "apply");
    assert.equal(log.at(-1).id, result.id);

    const items = list({ quarantine });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, result.id);
  } finally {
    clean(dir);
  }
});

test("identical basenames get distinct destinations", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safetrash-dupes-"));
  const quarantine = path.join(dir, "quarantine");
  try {
    const a = path.join(dir, "a", "same.txt");
    const b = path.join(dir, "b", "same.txt");
    fs.mkdirSync(path.dirname(a), { recursive: true });
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.writeFileSync(a, "one");
    fs.writeFileSync(b, "two");

    const result = apply(plan([a, b]), { quarantine, reason: "dupes", owner: "tester", allowRecent: true });
    assert.equal(result.applied, true);
    const names = result.manifest.entries.map((entry) => entry.storedAs);
    assert.equal(new Set(names).size, 2);
  } finally {
    clean(dir);
  }
});

test("apply refuses a denied plan and requires a reason", () => {
  const { dir, quarantine, victim } = workspace();
  try {
    const refused = apply(plan([os.homedir()]), { quarantine, reason: "should not happen" });
    assert.equal(refused.applied, false);
    assert.throws(() => apply(plan([victim]), { quarantine, allowRecent: true }), /reason is required/);
    assert.equal(fs.existsSync(victim), true);
  } finally {
    clean(dir);
  }
});

test("restore verifies checksums and refuses to overwrite", () => {
  const { dir, quarantine, victim } = workspace();
  try {
    const result = apply(plan([victim]), { quarantine, reason: "restore test", owner: "tester", allowRecent: true });
    const restored = restore(result.id, { quarantine });
    assert.deepEqual(restored.restored, [victim]);
    assert.equal(fs.readFileSync(path.join(victim, "keep.txt"), "utf8"), "important");

    const again = apply(plan([victim]), { quarantine, reason: "second move", owner: "tester", allowRecent: true });
    fs.mkdirSync(victim, { recursive: true });
    assert.throws(() => restore(again.id, { quarantine }), /refusing to overwrite/);
  } finally {
    clean(dir);
  }
});

test("restore reports a tampered file instead of restoring it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safetrash-tamper-"));
  const quarantine = path.join(dir, "quarantine");
  try {
    const file = path.join(dir, "file.bin");
    fs.writeFileSync(file, "original");
    const result = apply(plan([file]), { quarantine, reason: "tamper test", owner: "tester", allowRecent: true });
    fs.writeFileSync(path.join(result.dir, result.manifest.entries[0].storedAs), "tampered");

    const restored = restore(result.id, { quarantine });
    assert.equal(restored.restored.length, 0);
    assert.match(restored.problems.join(" "), /checksum mismatch/);
  } finally {
    clean(dir);
  }
});

test("apply is refused while the host lock is held", () => {
  const { dir, quarantine, victim } = workspace();
  try {
    const lockPath = path.join(quarantine, ".safe-trash.lock");
    fs.mkdirSync(quarantine, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ owner: "other-agent", ttlSeconds: 600 }), "utf8");

    const result = apply(plan([victim]), { quarantine, reason: "lock test", owner: "tester", allowRecent: true });
    assert.equal(result.applied, false);
    assert.match(result.reason, /lock .*held by other-agent/);
    assert.equal(fs.existsSync(victim), true);
  } finally {
    clean(dir);
  }
});

test("purge removes the transaction and logs it", () => {
  const { dir, quarantine, victim } = workspace();
  try {
    const result = apply(plan([victim]), { quarantine, reason: "purge test", owner: "tester", allowRecent: true });
    assert.equal(purge(result.id, { quarantine, owner: "tester" }).purged, true);
    assert.equal(fs.existsSync(result.dir), false);
    assert.equal(list({ quarantine }).length, 0);
    const log = fs.readFileSync(path.join(quarantine, AUDIT_LOG), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(log.at(-1).action, "purge");
  } finally {
    clean(dir);
  }
});

test("CLI plan returns 1 when any path is refused and 0 with totals when allowed", () => {
  const { dir, victim } = workspace();
  try {
    const denied = runCli(["plan", "--path", os.homedir()]);
    assert.equal(denied.status, 1);
    assert.match(denied.stdout, /DENY/);

    const allowed = runCli(["plan", "--path", victim]);
    assert.equal(allowed.status, 0);
    assert.match(allowed.stdout, /TOTAL/);
  } finally {
    clean(dir);
  }
});

test("CLI apply refuses without --yes and round-trips with it", () => {
  const { dir, victim } = workspace();
  try {
    const no = runCli(["apply", "--path", victim, "--reason", "x"]);
    assert.equal(no.status, 2);
    assert.equal(fs.existsSync(victim), true);

    const applied = runCli(["apply", "--path", victim, "--reason", "cli test", "--yes", "--allow-recent", "--owner", "tester"]);
    assert.equal(applied.status, 0, applied.stderr);
    const parsed = JSON.parse(applied.stdout);
    assert.equal(parsed.applied, true);
    assert.equal(fs.existsSync(victim), false);

    const restored = runCli(["restore", "--id", parsed.id, "--yes"]);
    assert.equal(restored.status, 0, restored.stderr);
    assert.equal(fs.existsSync(path.join(victim, "keep.txt")), true);
  } finally {
    clean(dir);
  }
});
