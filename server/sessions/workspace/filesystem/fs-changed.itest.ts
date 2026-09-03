import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClientMsg, WireMsg } from "../../../protocol";
import { fixtureGit as git, startDaemon, TestClient, type Daemon } from "../../../testing/itest-harness";

// W.2 over a real daemon and a real socket: a disk write behind the wire
// pushes fs_changed to the attached viewport (per-viewport plumbing — never
// seq-stamped, never replayed to a late attacher), and a bell invalidates
// the per-repo status cache so the very next listing reads statuses fresh
// from inside what would otherwise be the TTL. The watcher module itself is
// pinned by fs-watch.itest.ts.

type Any = WireMsg & Record<string, any>;

const DEBOUNCE_MS = 120;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

let d: Daemon;
let plain: string;
let repo: string;
let slow: string;
let hookDir: string;

const STATUS_WAIT_MS = 150;

const openSession = async (cwd: string) => {
  const c = new TestClient(d.port);
  await c.opened();
  await c.type("agents");
  c.send({ type: "create", agent: "claude-code", cwd } as ClientMsg);
  const created = (await c.type("session_created")) as Any;
  return { c, sessionId: created.sessionId as string };
};

/** One root listing, correlated on `id`. */
const listRoot = async (c: TestClient, id: string): Promise<Any> => {
  c.send({ type: "fs_listdir", id, path: "" } as ClientMsg);
  return (await c.waitFor((m) => m.type === "fs_dir" && (m as Any).id === id, `fs_dir ${id}`, 5_000)) as Any;
};

/** The status char an fs_dir reply carries for `name` (undefined = clean). */
const statusOf = (reply: Any, name: string): string | undefined =>
  (reply.entries as Any[]).find((e) => e.name === name)?.status;

before(async () => {
  plain = mkdtempSync(path.join(os.tmpdir(), "fsc-plain-"));
  writeFileSync(path.join(plain, "existing.txt"), "here\n");

  // A clean repo: the status-freshness pin dirties it mid-test.
  repo = mkdtempSync(path.join(os.tmpdir(), "fsc-repo-"));
  git(repo, "init", "-q");
  writeFileSync(path.join(repo, "tracked.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "c1");

  // A DELIBERATELY slow repo (W.H1): a core.fsmonitor hook that sleeps
  // makes every `git status` take ~2s, far past the listing bound. The
  // hook lives OUTSIDE the repo so nothing about it rings the watcher.
  hookDir = mkdtempSync(path.join(os.tmpdir(), "fsc-hook-"));
  const hook = path.join(hookDir, "slow.sh");
  writeFileSync(hook, "#!/bin/sh\nsleep 1\nexit 1\n");
  chmodSync(hook, 0o755);
  slow = mkdtempSync(path.join(os.tmpdir(), "fsc-slow-"));
  git(slow, "init", "-q");
  writeFileSync(path.join(slow, "tracked.txt"), "one\n");
  git(slow, "add", "-A");
  git(slow, "commit", "-q", "-m", "c1");
  writeFileSync(path.join(slow, "tracked.txt"), "one\ntwo\n"); // the M to see
  git(slow, "config", "core.fsmonitor", hook);
  // That setting is exactly what the 2026-07-26 audit made the daemon refuse
  // by default, so this repo has to be ALLOWED for its hook to run at all —
  // which makes this fixture a live proof of the allow path through the real
  // daemon, on top of what it was already pinning.
  const trustPath = path.join(hookDir, "trusted-repos.json");
  writeFileSync(trustPath, JSON.stringify({ repos: [slow] }));

  d = await startDaemon({
    FS_WATCH_DEBOUNCE_MS: String(DEBOUNCE_MS),
    FS_LISTDIR_STATUS_WAIT_MS: String(STATUS_WAIT_MS),
    MIRAFOLD_TRUST_FILE: trustPath,
  });
});
after(async () => {
  await d.stop();
  rmSync(plain, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(slow, { recursive: true, force: true });
  rmSync(hookDir, { recursive: true, force: true });
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
  const before = await listRoot(c, "before");
  assert.equal(statusOf(before, "tracked.txt"), undefined, "clean file carries no status");

  // Dirty it behind the wire; the bell must arrive AND clear the cache.
  writeFileSync(path.join(repo, "tracked.txt"), "one\ntwo\n");
  await c.waitFor((m) => m.type === "fs_changed", "fs_changed", 5_000);

  // Well inside FS_GIT_STATUS_TTL_MS (3s default): without the bell's
  // invalidation this would be served the cached clean status.
  const after = await listRoot(c, "afterr");
  assert.equal(statusOf(after, "tracked.txt"), "M", "the post-bell listing reads statuses fresh");
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
    await listRoot(c, id);
    await settle(DEBOUNCE_MS * 3); // a status-write bell would land here
  }
  const bellsAfter = (c.received as Any[]).filter((m) => m.type === "fs_changed").length;
  assert.equal(bellsAfter, bellsBefore, "a listing's git status rang the bell — feedback loop");
  c.close();
});

test("W.H1: a slow repo ships plain at the bound; badges follow via a non-mutation signal", async () => {
  const { c } = await openSession(slow);
  await settle(DEBOUNCE_MS * 3);

  // The listing must arrive at the wait bound (150ms here), NOT after the
  // ~2s status — and arrive plain, statuses honestly absent.
  const t0 = Date.now();
  const first = await listRoot(c, "s1");
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 900, `the listing waited on git (${elapsed}ms) instead of shipping at the bound`);
  assert.equal(statusOf(first, "tracked.txt"), undefined, "the bounded reply is the plain listing");

  // When the status finally settles, ONE dedicated status-ready signal tells
  // this viewport to refetch without impersonating a disk mutation bell.
  const ready = (await c.waitFor(
    (m) => m.type === "fs_changed" && (m as Any).reason === "status",
    "the late-status signal",
    10_000,
  )) as Any;
  assert.ok(!("paths" in ready));
  assert.equal(ready.truncated, undefined, "status completion falsely claimed unknown disk churn");

  // The refetch decorates instantly from the settled cache (TTL from
  // arrival, W.H2) — no second timeout round.
  const second = await listRoot(c, "s2");
  assert.equal(statusOf(second, "tracked.txt"), "M", "the post-bell listing carries the badge");
  c.close();
});
