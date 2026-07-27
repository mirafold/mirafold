import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClientMsg, WireMsg } from "../protocol";
import { startDaemon, TestClient, type Daemon } from "../testing/itest-harness";

// W.2 over a real daemon and a real socket: a disk write behind the wire
// pushes fs_changed to the attached viewport (per-viewport plumbing — never
// seq-stamped, never replayed to a late attacher), and a bell invalidates
// the per-repo status cache so the very next listing reads statuses fresh
// from inside what would otherwise be the TTL. The watcher module itself is
// pinned by fs-watch.itest.ts.

type Any = WireMsg & Record<string, any>;

const DEBOUNCE_MS = 120;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-C", cwd, "-c", "user.email=t@t.t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { stdio: "pipe" },
  );

let d: Daemon;
let plain: string;
let repo: string;

const openSession = async (cwd: string) => {
  const c = new TestClient(d.port);
  await c.opened();
  await c.type("agents");
  c.send({ type: "create", agent: "claude-code", cwd } as ClientMsg);
  const created = (await c.type("session_created")) as Any;
  return { c, sessionId: created.sessionId as string };
};

before(async () => {
  plain = mkdtempSync(path.join(os.tmpdir(), "fsc-plain-"));
  writeFileSync(path.join(plain, "existing.txt"), "here\n");

  // A clean repo: the status-freshness pin dirties it mid-test.
  repo = mkdtempSync(path.join(os.tmpdir(), "fsc-repo-"));
  git(repo, "init", "-q");
  writeFileSync(path.join(repo, "tracked.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "c1");

  d = await startDaemon({ FS_WATCH_DEBOUNCE_MS: String(DEBOUNCE_MS) });
});
after(async () => {
  await d.stop();
  rmSync(plain, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

test("W.2: a write behind the wire pushes fs_changed to the attached viewport, unsequenced", async () => {
  const { c } = await openSession(plain);
  await settle(DEBOUNCE_MS * 3); // session-create churn (if any) rings out
  writeFileSync(path.join(plain, "fresh.txt"), "new\n");
  const bell = (await c.waitFor((m) => m.type === "fs_changed", "fs_changed", 5_000)) as Any;
  assert.ok((bell.paths as string[]).includes("fresh.txt"), `hint carries the path, got: ${bell.paths}`);
  assert.ok(!("seq" in bell), "the bell is per-viewport plumbing — never seq-stamped");
  c.close();
});

test("W.2: the bell never enters the replay ring — a late attacher sees none", async () => {
  const { c, sessionId } = await openSession(plain);
  await settle(DEBOUNCE_MS * 3);
  writeFileSync(path.join(plain, "for-the-ring.txt"), "x\n");
  await c.waitFor((m) => m.type === "fs_changed", "fs_changed", 5_000);
  await settle(DEBOUNCE_MS * 3); // let any straggler bell land BEFORE the attach

  const late = new TestClient(d.port);
  await late.opened();
  await late.type("agents");
  late.send({ type: "attach", sessionId } as never);
  await late.type("session_created");
  await settle(300); // replay is synchronous on attach; this is margin
  assert.ok(
    !(late.received as Any[]).some((m) => m.type === "fs_changed"),
    "a replayed fs_changed rode the ring buffer",
  );
  late.close();
  c.close();
});

test("W.2: a bell invalidates the repo status cache — the next listing is fresh inside the TTL", async () => {
  const { c } = await openSession(repo);
  await settle(DEBOUNCE_MS * 3);

  // Prime the cache: a clean repo, no status chars anywhere.
  c.send({ type: "fs_listdir", id: "before", path: "" } as ClientMsg);
  const beforeReply = (await c.waitFor(
    (m) => m.type === "fs_dir" && (m as Any).id === "before",
    "fs_dir before",
  )) as Any;
  const beforeEntry = (beforeReply.entries as Any[]).find((e) => e.name === "tracked.txt");
  assert.equal(beforeEntry?.status, undefined, "clean file carries no status");

  // Dirty it behind the wire; the bell must arrive AND clear the cache.
  writeFileSync(path.join(repo, "tracked.txt"), "one\ntwo\n");
  await c.waitFor((m) => m.type === "fs_changed", "fs_changed", 5_000);

  // Well inside FS_GIT_STATUS_TTL_MS (3s default): without the bell's
  // invalidation this would be served the cached clean status.
  c.send({ type: "fs_listdir", id: "afterr", path: "" } as ClientMsg);
  const afterReply = (await c.waitFor(
    (m) => m.type === "fs_dir" && (m as Any).id === "afterr",
    "fs_dir after",
  )) as Any;
  const afterEntry = (afterReply.entries as Any[]).find((e) => e.name === "tracked.txt");
  assert.equal(afterEntry?.status, "M", "the post-bell listing reads statuses fresh");
  c.close();
});

test("W.2: the daemon's own git reads never ring the bell — no status-write feedback loop", async () => {
  // The trap: `git status` may take .git/index.lock and rewrite the index's
  // stat cache — a write the watcher hears, whose bell triggers a refetch,
  // whose status writes again… runGit's --no-optional-locks is the guard.
  // A same-content mtime touch makes the stat cache deterministically stale,
  // so a lock-taking status WOULD write; the touch's own bell is let pass
  // first, then listings must stay silent.
  const { c } = await openSession(repo);
  await settle(DEBOUNCE_MS * 3);

  const tracked = path.join(repo, "tracked.txt");
  const bumped = new Date(Date.now() + 1_000);
  utimesSync(tracked, bumped, bumped);
  await c.waitFor((m) => m.type === "fs_changed", "the touch's own bell", 5_000);
  await settle(DEBOUNCE_MS * 3); // and any straggler

  const bellsBefore = (c.received as Any[]).filter((m) => m.type === "fs_changed").length;
  for (const id of ["q1", "q2", "q3"]) {
    c.send({ type: "fs_listdir", id, path: "" } as ClientMsg);
    await c.waitFor((m) => m.type === "fs_dir" && (m as Any).id === id, `fs_dir ${id}`);
    await settle(DEBOUNCE_MS * 3); // a status-write bell would land here
  }
  const bellsAfter = (c.received as Any[]).filter((m) => m.type === "fs_changed").length;
  assert.equal(bellsAfter, bellsBefore, "a listing's git status rang the bell — feedback loop");
  c.close();
});
