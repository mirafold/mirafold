import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClientMsg, WireMsg } from "../protocol";
import { startDaemon, TestClient, type Daemon } from "../testing/itest-harness";

// E.2 against a REAL daemon and a scripted temp repo: git's view of the tree
// (tracked + untracked, ignored excluded, statuses collapsed, staged deletes
// kept visible), the before/after diff for modified/added/deleted/renamed
// files, the SUBDIRECTORY-session path relativity trap, and the unborn-HEAD
// degrade. The non-repo fallback is pinned by fs-explorer.itest.ts.

type Any = WireMsg & Record<string, any>;

const THROTTLE_MS = 150;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-C", cwd, "-c", "user.email=t@t.t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { stdio: "pipe" },
  );

let d: Daemon;
let repo: string;
let unborn: string;

const openSession = async (cwd: string) => {
  const c = new TestClient(d.port);
  await c.opened();
  await c.type("agents");
  c.send({ type: "create", agent: "claude-code", cwd } as ClientMsg);
  await c.type("session_created");
  return c;
};

const fsList = async (c: TestClient, id: string) => {
  await settle(THROTTLE_MS + 30);
  c.send({ type: "fs_list", id } as ClientMsg);
  return (await c.waitFor((m) => m.type === "fs_tree" && (m as Any).id === id, `fs_tree ${id}`)) as Any;
};

const fsDiff = async (c: TestClient, id: string, p: string) => {
  await settle(THROTTLE_MS + 30);
  c.send({ type: "fs_diff", id, path: p } as ClientMsg);
  return (await c.waitFor(
    (m) => m.type === "fs_file_diff" && (m as Any).id === id,
    `fs_file_diff ${id}`,
  )) as Any;
};

before(async () => {
  // The scripted repo: commit a baseline, then produce one of every change
  // shape — modified, untracked, unstaged delete, staged rename, ignored,
  // and a modified file inside a subdirectory (the prefix-strip case).
  repo = mkdtempSync(path.join(os.tmpdir(), "fsg-repo-"));
  git(repo, "init", "-q");
  mkdirSync(path.join(repo, "sub"));
  writeFileSync(path.join(repo, "tracked.txt"), "one\n");
  writeFileSync(path.join(repo, "gone.txt"), "bye\n");
  writeFileSync(path.join(repo, "moveme.txt"), "movable\n");
  writeFileSync(path.join(repo, "sub", "inner.txt"), "inner-one\n");
  writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "c1");
  writeFileSync(path.join(repo, "tracked.txt"), "one\ntwo\n");
  writeFileSync(path.join(repo, "untracked.txt"), "new\n");
  writeFileSync(path.join(repo, "ignored.txt"), "invisible\n");
  writeFileSync(path.join(repo, "sub", "inner.txt"), "inner-two\n");
  // A wholly-untracked directory: status collapses it to one `?? newdir/`
  // record (the 2026-07-28 phantom-entry fix's case).
  mkdirSync(path.join(repo, "newdir"));
  writeFileSync(path.join(repo, "newdir", "inside.txt"), "inside\n");
  unlinkSync(path.join(repo, "gone.txt"));
  git(repo, "mv", "moveme.txt", "moved.txt");

  // A repo with no commits: HEAD is unborn, everything is untracked.
  unborn = mkdtempSync(path.join(os.tmpdir(), "fsg-unborn-"));
  git(unborn, "init", "-q");
  writeFileSync(path.join(unborn, "fresh.txt"), "fresh\n");

  d = await startDaemon({ FS_MIN_INTERVAL_MS: String(THROTTLE_MS) });
});
after(async () => {
  await d.stop();
  rmSync(repo, { recursive: true, force: true });
  rmSync(unborn, { recursive: true, force: true });
});

test("E.2: fs_list is git's view — statuses collapsed, ignored excluded, staged delete visible", async () => {
  const c = await openSession(repo);
  const tree = await fsList(c, "g1");
  assert.equal(tree.error, undefined);
  assert.equal(tree.git, true);
  const by = new Map((tree.entries as Any[]).map((e) => [e.path, e.status]));
  assert.equal(by.get("tracked.txt"), "M");
  assert.equal(by.get("untracked.txt"), "U");
  assert.equal(by.get("gone.txt"), "D", "an unstaged delete stays listed");
  assert.equal(by.get("moved.txt"), "A", "rename target");
  assert.equal(by.get("moveme.txt"), "D", "rename source, merged from status-only paths");
  assert.equal(by.get("sub/inner.txt"), "M");
  assert.equal(by.get(".gitignore"), undefined, "unchanged tracked file carries no status");
  assert.ok(by.has(".gitignore"));
  assert.ok(!by.has("ignored.txt"), "gitignored files are git's view — not listed");
  assert.ok(![...by.keys()].some((p) => (p as string).startsWith(".git/")));
  // The untracked-dir collapse (2026-07-28 fix): the files inside carry U,
  // and no trailing-slash phantom entry ships for the dir itself.
  assert.equal(by.get("newdir/inside.txt"), "U", "files inside an untracked dir carry U");
  assert.ok(!by.has("newdir/"), "no phantom dir/ entry");
  // Deterministic order.
  const paths = (tree.entries as Any[]).map((e) => e.path);
  assert.deepEqual(paths, [...paths].sort());
  c.close();
});

test("E.2: diffs — modified, added, deleted, rename target", async () => {
  const c = await openSession(repo);
  const mod = await fsDiff(c, "d1", "tracked.txt");
  assert.equal(mod.before, "one\n");
  assert.equal(mod.after, "one\ntwo\n");
  assert.ok(!("seq" in mod));

  const added = await fsDiff(c, "d2", "untracked.txt");
  assert.equal(added.before, "", "absent in HEAD diffs against empty");
  assert.equal(added.after, "new\n");

  const deleted = await fsDiff(c, "d3", "gone.txt");
  assert.equal(deleted.before, "bye\n");
  assert.equal(deleted.after, "", "deleted diffs to empty — not an error");

  const renamed = await fsDiff(c, "d4", "moved.txt");
  assert.equal(renamed.before, "");
  assert.equal(renamed.after, "movable\n");

  const secret = await fsDiff(c, "d5", ".env");
  assert.equal(typeof secret.error, "string", "env files refuse diffs too");

  const escape = await fsDiff(c, "d6", "../outside.txt");
  assert.equal(typeof escape.error, "string", "textual containment before git sees the path");
  c.close();
});

test("E.2: a session rooted in a repo SUBDIRECTORY labels statuses and diffs correctly", async () => {
  const c = await openSession(path.join(repo, "sub"));
  const tree = await fsList(c, "s1");
  assert.equal(tree.git, true);
  const by = new Map((tree.entries as Any[]).map((e) => [e.path, e.status]));
  assert.equal(by.get("inner.txt"), "M", "porcelain's repo-root path is prefix-stripped");
  assert.ok(!by.has("sub/inner.txt"));
  assert.ok(!by.has("tracked.txt"), "changes outside the session subtree are not its story");

  const diff = await fsDiff(c, "s2", "inner.txt");
  assert.equal(diff.before, "inner-one\n");
  assert.equal(diff.after, "inner-two\n");
  c.close();
});

test("E.2: unborn HEAD — tree works, everything diffs against empty, never crashes", async () => {
  const c = await openSession(unborn);
  const tree = await fsList(c, "u1");
  assert.equal(tree.git, true);
  const by = new Map((tree.entries as Any[]).map((e) => [e.path, e.status]));
  assert.equal(by.get("fresh.txt"), "U");

  const diff = await fsDiff(c, "u2", "fresh.txt");
  assert.equal(diff.error, undefined);
  assert.equal(diff.before, "");
  assert.equal(diff.after, "fresh\n");
  assert.doesNotMatch(d.logs(), /crashed \(uncaughtException\)/);
  c.close();
});
