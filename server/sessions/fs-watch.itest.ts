import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startWatch, type FsChange } from "./fs-watch";

// W.1 against the real filesystem (real inotify, real git): one coalesced
// bell per change window with root-relative paths, a burst fires ONCE, a
// commit with no working-file change still rings (the .git HEAD/index/refs
// coverage) while .git/objects stays excluded, node_modules churn is
// silent, and a bad root degrades through onError without a crash. The
// wire half (fs_changed) is W.2 — nothing here touches a socket.

const DEBOUNCE = 150;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-C", cwd, "-c", "user.email=t@t.t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { stdio: "pipe" },
  );

type Watched = {
  root: string;
  changes: FsChange[];
  errors: unknown[];
  stop: () => void;
};

const roots: string[] = [];
const stops: (() => void)[] = [];

/** A fresh temp root under watch, subscription confirmed live. */
async function watchTemp(
  prefix: string,
  opts: { maxPaths?: number; debounceMs?: number } = {},
): Promise<Watched> {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  const changes: FsChange[] = [];
  const errors: unknown[] = [];
  const handle = startWatch(root, (c) => changes.push(c), {
    debounceMs: opts.debounceMs ?? DEBOUNCE,
    ...(opts.maxPaths !== undefined ? { maxPaths: opts.maxPaths } : {}),
    onError: (e) => errors.push(e),
  });
  stops.push(handle.stop);
  await handle.ready;
  assert.equal(errors.length, 0, "subscription came up clean");
  return { root, changes, errors, stop: handle.stop };
}

async function untilBell(w: Watched, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (w.changes.length === 0) {
    if (Date.now() > deadline) assert.fail("no bell within the timeout");
    await settle(25);
  }
}

after(() => {
  for (const stop of stops) stop();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("W.1: a file touch rings one bell carrying the root-relative path", async () => {
  const w = await watchTemp("fsw-touch-");
  writeFileSync(path.join(w.root, "hello.txt"), "hi\n");
  await untilBell(w);
  // The window is over once the bell rings; quiet after means ONE bell.
  await settle(DEBOUNCE * 3);
  assert.equal(w.changes.length, 1);
  assert.deepEqual(w.changes[0].paths, ["hello.txt"]);
  assert.equal(w.changes[0].truncated, false);
});

test("W.1: a 30-file burst coalesces into a single bell", async () => {
  const WINDOW = 300;
  const w = await watchTemp("fsw-burst-", { debounceMs: WINDOW });
  mkdirSync(path.join(w.root, "sub"));
  await settle(WINDOW * 3); // let the mkdir's own bell pass
  w.changes.length = 0;
  // Two spurts inside one window: the native layer delivers them as separate
  // event batches (its internal throttle is ~50ms), so a single bell proves
  // OUR coalescing, not the backend's batching.
  for (let i = 0; i < 15; i++) {
    writeFileSync(path.join(w.root, "sub", `f${String(i).padStart(2, "0")}.txt`), `${i}\n`);
  }
  await settle(100);
  for (let i = 15; i < 30; i++) {
    writeFileSync(path.join(w.root, "sub", `f${String(i).padStart(2, "0")}.txt`), `${i}\n`);
  }
  await untilBell(w);
  await settle(WINDOW * 2);
  assert.equal(w.changes.length, 1, "one coalesced bell, not thirty");
  const paths = w.changes[0].paths;
  assert.equal(paths.length, 30);
  assert.ok(paths.includes("sub/f00.txt") && paths.includes("sub/f29.txt"));
  assert.equal(w.changes[0].truncated, false);
});

test("W.1: the paths hint caps honestly — truncated, never silently cut", async () => {
  const w = await watchTemp("fsw-cap-", { maxPaths: 5 });
  for (let i = 0; i < 12; i++) {
    writeFileSync(path.join(w.root, `c${String(i).padStart(2, "0")}.txt`), `${i}\n`);
  }
  await untilBell(w);
  assert.equal(w.changes[0].paths.length, 5);
  assert.equal(w.changes[0].truncated, true);
});

test("W.1: a git commit with no working-file change rings; .git/objects never reports", async () => {
  const w = await watchTemp("fsw-git-");
  git(w.root, "init", "-q");
  writeFileSync(path.join(w.root, "tracked.txt"), "one\n");
  git(w.root, "add", "-A");
  git(w.root, "commit", "-q", "-m", "c1");
  await settle(DEBOUNCE * 3); // setup churn done ringing
  w.changes.length = 0;

  git(w.root, "commit", "-q", "--allow-empty", "-m", "c2");
  await untilBell(w);
  const all = w.changes.flatMap((c) => c.paths);
  assert.ok(
    all.some((p) => p === ".git" || p.startsWith(".git/")),
    `the bell came from .git internals (HEAD/refs/logs), got: ${all.join(", ")}`,
  );
  assert.ok(
    !all.some((p) => p.startsWith(".git/objects")),
    "object churn is excluded from the hint",
  );
});

test("W.1: writes under node_modules stay silent — and the watcher is still alive after", async () => {
  const w = await watchTemp("fsw-nm-");
  mkdirSync(path.join(w.root, "node_modules", "pkg"), { recursive: true });
  await settle(DEBOUNCE * 3); // the mkdir of node_modules itself may ring
  w.changes.length = 0;

  writeFileSync(path.join(w.root, "node_modules", "pkg", "index.js"), "x\n");
  writeFileSync(path.join(w.root, "node_modules", "pkg", "extra.js"), "y\n");
  await settle(DEBOUNCE * 4);
  assert.equal(w.changes.length, 0, "excluded churn rings no bell");

  // Aliveness proof: the silence above was the exclusion, not a dead watcher.
  writeFileSync(path.join(w.root, "visible.txt"), "seen\n");
  await untilBell(w);
  assert.deepEqual(w.changes[0].paths, ["visible.txt"]);
});

test("W.1: a subtree created in one mkdir -p self-heals — later writes inside it still ring", async () => {
  const w = await watchTemp("fsw-deep-");
  // The backend wart: `deep/nested` lands faster than watch registration, so
  // without the resubscribe heal, everything under it stays silent forever.
  mkdirSync(path.join(w.root, "deep", "nested"), { recursive: true });
  await untilBell(w); // the create bell (typically only `deep` is visible)
  await settle(600); // resubscribe crawl settles
  w.changes.length = 0;

  writeFileSync(path.join(w.root, "deep", "nested", "late.txt"), "healed\n");
  await untilBell(w);
  const all = w.changes.flatMap((c) => c.paths);
  assert.ok(all.includes("deep/nested/late.txt"), `heal covered the new subtree, got: ${all.join(", ")}`);
});

test("W.1: a bad root degrades through onError — no throw, no bell, stop() safe", async () => {
  const missing = path.join(os.tmpdir(), "fsw-definitely-not-here", "nope");
  const changes: FsChange[] = [];
  const errors: unknown[] = [];
  const handle = startWatch(missing, (c) => changes.push(c), {
    debounceMs: DEBOUNCE,
    onError: (e) => errors.push(e),
  });
  await handle.ready;
  await settle(50);
  assert.equal(errors.length, 1, "exactly one failure report");
  assert.equal(changes.length, 0);
  handle.stop(); // idempotent after failure
});

test("W.1: stop before the subscription lands leaks nothing and never rings", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fsw-early-"));
  roots.push(root);
  const changes: FsChange[] = [];
  const handle = startWatch(root, (c) => changes.push(c), { debounceMs: DEBOUNCE });
  handle.stop(); // before ready — the subscription is dropped on arrival
  await handle.ready;
  writeFileSync(path.join(root, "after-stop.txt"), "x\n");
  await settle(DEBOUNCE * 4);
  assert.equal(changes.length, 0);
});
