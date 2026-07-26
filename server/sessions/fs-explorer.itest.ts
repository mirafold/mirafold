import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClientMsg, WireMsg } from "../protocol";
import { fixtureGit as git, startDaemon, TestClient, type Daemon } from "../testing/itest-harness";

// E.1 over a REAL daemon and socket: the fs_list/fs_read round-trip against a
// scripted temp workspace, the jail + secret denial refusing with error
// REPLIES (daemon alive after every attempt), the per-type throttle answering
// instead of dropping, the no-session case, and a deleted session root.
// Replies must be per-viewport: no seq, ever. E2.1 adds the lazy pair beside
// it: fs_listdir's one-directory replies, its jail, its token bucket, and the
// pin that the legacy whole-tree pair keeps answering identically.

type Any = WireMsg & Record<string, any>;

let d: Daemon;
let ws: string; // the session workspace
let outside: string; // where the planted symlink points
let mr: string; // the E2.3 multi-repo root: repoA (dirty) + repoB (own rules) + plain/

/** One fs_listdir round-trip: send with `id`, wait for its correlated fs_dir. */
const listdir = async (c: TestClient, id: string, p: string) => {
  c.send({ type: "fs_listdir", id, path: p } as ClientMsg);
  return (await c.waitFor((m) => m.type === "fs_dir" && (m as Any).id === id, `fs_dir ${id}`)) as Any;
};

// The throttle window under test — small so the suite stays fast, real so
// the burst case actually trips it.
const THROTTLE_MS = 150;
// fs_listdir's token bucket, sized down so a test burst actually drains it
// (E2.1) while the jail test's four sequential requests still fit one burst.
const LISTDIR_PER_SEC = 5;
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const openSession = async (cwd: string) => {
  const c = new TestClient(d.port);
  await c.opened();
  await c.type("agents");
  c.send({ type: "create", agent: "claude-code", cwd } as ClientMsg);
  await c.type("session_created");
  return c;
};

before(async () => {
  ws = mkdtempSync(path.join(os.tmpdir(), "fsx-ws-"));
  outside = mkdtempSync(path.join(os.tmpdir(), "fsx-out-"));
  mkdirSync(path.join(ws, "src"));
  mkdirSync(path.join(ws, "node_modules"));
  writeFileSync(path.join(ws, "README.md"), "# readme\n");
  writeFileSync(path.join(ws, "src", "app.ts"), "export {};\n");
  writeFileSync(path.join(ws, ".env"), "SECRET=1\n");
  writeFileSync(path.join(ws, "node_modules", "x.js"), "never listed");
  writeFileSync(path.join(ws, "img.bin"), Buffer.from([1, 0, 2]));
  writeFileSync(path.join(outside, "loot.txt"), "outside\n");
  symlinkSync(path.join(outside, "loot.txt"), path.join(ws, "innocent.txt"));

  // The E2.3 fixture: a Projects-style root that is NOT itself a repo,
  // holding two repos with different ignore rules + dirt, and a plain dir.
  mr = mkdtempSync(path.join(os.tmpdir(), "fsx-mr-"));
  const repoA = path.join(mr, "repoA");
  const repoB = path.join(mr, "repoB");
  mkdirSync(repoA);
  mkdirSync(repoB);
  mkdirSync(path.join(mr, "plain"));
  writeFileSync(path.join(mr, "plain", "note.txt"), "n\n");
  // repoA: ignores dist/; committed, then made dirty every way that matters —
  // a modified file, an unstaged delete, an untracked dir, ignored build output.
  git(repoA, "init", "-q");
  writeFileSync(path.join(repoA, ".gitignore"), "dist/\n");
  writeFileSync(path.join(repoA, "kept.txt"), "k\n");
  writeFileSync(path.join(repoA, "changed.txt"), "before\n");
  writeFileSync(path.join(repoA, "doomed.txt"), "d\n");
  git(repoA, "add", "-A");
  git(repoA, "commit", "-qm", "init");
  writeFileSync(path.join(repoA, "changed.txt"), "after\n");
  rmSync(path.join(repoA, "doomed.txt"));
  mkdirSync(path.join(repoA, "dist"));
  writeFileSync(path.join(repoA, "dist", "bundle.js"), "x\n");
  mkdirSync(path.join(repoA, "newdir"));
  writeFileSync(path.join(repoA, "newdir", "fresh.txt"), "f\n");
  // repoB: ignores secret.log — and does NOT ignore dist/, so the same name
  // gets opposite verdicts in the two repos.
  git(repoB, "init", "-q");
  writeFileSync(path.join(repoB, ".gitignore"), "secret.log\n");
  writeFileSync(path.join(repoB, "app.ts"), "export {};\n");
  git(repoB, "add", "-A");
  git(repoB, "commit", "-qm", "init");
  writeFileSync(path.join(repoB, "secret.log"), "s\n");
  mkdirSync(path.join(repoB, "dist"));
  writeFileSync(path.join(repoB, "dist", "x.js"), "x\n");

  d = await startDaemon({
    FS_MIN_INTERVAL_MS: String(THROTTLE_MS),
    FS_LISTDIR_MAX_PER_SEC: String(LISTDIR_PER_SEC),
  });
});
after(async () => {
  await d.stop();
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  rmSync(mr, { recursive: true, force: true });
});

test("E.1: fs_list round-trips the workspace tree, per-viewport (no seq)", async () => {
  const c = await openSession(ws);
  c.send({ type: "fs_list", id: "t1" } as ClientMsg);
  const tree = (await c.waitFor((m) => m.type === "fs_tree", "fs_tree")) as Any;
  assert.equal(tree.id, "t1");
  assert.equal(tree.git, false);
  assert.equal(tree.error, undefined);
  assert.ok(!("seq" in tree), "per-viewport replies are never sequenced");
  const paths = (tree.entries as { path: string }[]).map((e) => e.path);
  assert.deepEqual(paths, [".env", "README.md", "img.bin", "innocent.txt", "src/app.ts"]);
  // .env LISTED (honesty over hiding), node_modules pruned, symlink a leaf.
  c.close();
});

test("E.1: fs_read serves content; jail and secret denial answer with error replies; daemon lives", async () => {
  const c = await openSession(ws);
  const read = async (id: string, p: string) => {
    await settle(THROTTLE_MS + 30);
    c.send({ type: "fs_read", id, path: p } as ClientMsg);
    return (await c.waitFor((m) => m.type === "fs_file" && (m as Any).id === id, `fs_file ${id}`)) as Any;
  };

  const ok = await read("r1", "README.md");
  assert.equal(ok.content, "# readme\n");
  assert.equal(ok.size, 9);
  assert.ok(!("seq" in ok));

  const secret = await read("r2", ".env");
  assert.equal(typeof secret.error, "string");
  assert.equal(secret.content, undefined, "denied content never rides an error reply");

  const escape = await read("r3", "../" + path.basename(outside) + "/loot.txt");
  assert.equal(typeof escape.error, "string");

  const absolute = await read("r4", path.join(outside, "loot.txt"));
  assert.equal(typeof absolute.error, "string");

  const symlinkOut = await read("r5", "innocent.txt");
  assert.equal(typeof symlinkOut.error, "string", "a planted symlink can't read outside the root");

  const binary = await read("r6", "img.bin");
  assert.equal(binary.binary, true);
  assert.equal(binary.content, undefined);
  assert.equal(binary.size, 3);

  // Every refusal above left the daemon standing: a real read still works.
  const alive = await read("r7", "src/app.ts");
  assert.equal(alive.content, "export {};\n");
  assert.doesNotMatch(d.logs(), /crashed \(uncaughtException\)/);
  c.close();
});

test("E.1: a burst is throttled but ANSWERED — then works again past the window", async () => {
  const c = await openSession(ws);
  c.send({ type: "fs_list", id: "b1" } as ClientMsg);
  c.send({ type: "fs_list", id: "b2" } as ClientMsg);
  // Since E.2 the served reply is async (git) while the throttle error is
  // sync — b2's error legitimately arrives BEFORE b1's tree. Correlate by
  // echoed id, never by arrival order: that's the wire contract.
  const first = (await c.waitFor((m) => m.type === "fs_tree", "first fs_tree")) as Any;
  const second = (await c.waitFor((m) => m.type === "fs_tree", "second fs_tree")) as Any;
  const byId = new Map<string, Any>([first, second].map((m) => [m.id, m]));
  assert.ok(byId.has("b1") && byId.has("b2"), "one reply per request");
  assert.equal(byId.get("b1")!.error, undefined);
  assert.match(String(byId.get("b2")!.error), /too fast/);
  await settle(THROTTLE_MS + 30);
  c.send({ type: "fs_list", id: "b3" } as ClientMsg);
  const third = (await c.waitFor((m) => m.type === "fs_tree" && (m as Any).id === "b3", "b3")) as Any;
  assert.equal(third.error, undefined);
  c.close();
});

test("E2.1: fs_listdir serves one directory at a time — root and nested, kinds, no seq; legacy fs_list untouched beside it", async () => {
  const c = await openSession(ws);
  const root = await listdir(c, "L1", "");
  assert.equal(root.error, undefined);
  assert.equal(root.path, "");
  assert.ok(!("seq" in root), "per-viewport replies are never sequenced");
  // Dirs first then the rest alphabetical; node_modules omitted (the SKIP_DIRS
  // floor); .env LISTED (honesty over hiding); the symlink a leaf by kind.
  assert.deepEqual(root.entries, [
    { name: "src", kind: "dir" },
    { name: ".env", kind: "file" },
    { name: "README.md", kind: "file" },
    { name: "img.bin", kind: "file" },
    { name: "innocent.txt", kind: "symlink" },
  ]);

  const nested = await listdir(c, "L2", "src");
  assert.equal(nested.error, undefined);
  assert.deepEqual(nested.entries, [{ name: "app.ts", kind: "file" }]);

  // The compatibility floor: on the SAME connection, the legacy whole-tree
  // request still answers exactly as before the lazy pair existed.
  c.send({ type: "fs_list", id: "L3" } as ClientMsg);
  const tree = (await c.waitFor((m) => m.type === "fs_tree" && (m as Any).id === "L3", "fs_tree L3")) as Any;
  assert.equal(tree.error, undefined);
  assert.deepEqual(
    (tree.entries as { path: string }[]).map((e) => e.path),
    [".env", "README.md", "img.bin", "innocent.txt", "src/app.ts"],
  );
  c.close();
});

test("E2.1: fs_listdir jail — ../, absolute, and a symlink-to-outside dir all refuse with error replies; daemon lives", async () => {
  // Own workspace so the planted DIR symlink doesn't perturb the shared
  // fixture's fs_list expectations.
  const jailWs = mkdtempSync(path.join(os.tmpdir(), "fsx-jail-"));
  const jailOut = mkdtempSync(path.join(os.tmpdir(), "fsx-jailout-"));
  writeFileSync(path.join(jailOut, "loot.txt"), "outside\n");
  writeFileSync(path.join(jailWs, "ok.txt"), "inside\n");
  symlinkSync(jailOut, path.join(jailWs, "outlink"));
  const c = await openSession(jailWs);
  const escape = await listdir(c, "j1", "../" + path.basename(jailOut));
  assert.equal(typeof escape.error, "string");
  assert.deepEqual(escape.entries, [], "denied listings never carry entries");
  const absolute = await listdir(c, "j2", jailOut);
  assert.equal(typeof absolute.error, "string");
  const symlinkOut = await listdir(c, "j3", "outlink");
  assert.equal(typeof symlinkOut.error, "string", "a planted dir symlink can't list outside the root");

  // Every refusal left the daemon standing — and the link is still honestly
  // LISTED as a leaf, it just refuses to expand.
  const alive = await listdir(c, "j4", "");
  assert.equal(alive.error, undefined);
  assert.deepEqual(alive.entries, [
    { name: "ok.txt", kind: "file" },
    { name: "outlink", kind: "symlink" },
  ]);
  assert.doesNotMatch(d.logs(), /crashed \(uncaughtException\)/);
  c.close();
  rmSync(jailWs, { recursive: true, force: true });
  rmSync(jailOut, { recursive: true, force: true });
});

test("E2.1: an fs_listdir burst drains the token bucket but is ANSWERED — and works again once it refills", async () => {
  const c = await openSession(ws);
  const N = 8; // bucket holds LISTDIR_PER_SEC (5) — a same-instant burst of 8 must see refusals
  for (let i = 0; i < N; i++) c.send({ type: "fs_listdir", id: `q${i}`, path: "" } as ClientMsg);
  const replies: Any[] = [];
  for (let i = 0; i < N; i++) {
    replies.push(
      (await c.waitFor((m) => m.type === "fs_dir" && (m as Any).id === `q${i}`, `fs_dir q${i}`)) as Any,
    );
  }
  assert.equal(replies[0].error, undefined, "the burst's first request is served");
  const refused = replies.filter((m) => typeof m.error === "string");
  assert.ok(refused.length >= 1, "a same-instant burst past the bucket is refused, never silently dropped");
  assert.ok(refused.every((m) => /too fast/.test(String(m.error))));
  await settle(1_000); // one full refill window
  c.send({ type: "fs_listdir", id: "q-after", path: "" } as ClientMsg);
  const after = (await c.waitFor((m) => m.type === "fs_dir" && (m as Any).id === "q-after", "q-after")) as Any;
  assert.equal(after.error, undefined);
  c.close();
});

test("E2.3: a multi-repo root — each repo's own ignore rules and statuses, the plain dir statusless", async () => {
  // Two connections so the per-connection token bucket (5/s here) never
  // throttles the five listings under test.
  const c1 = await openSession(mr);
  const c2 = await openSession(mr);

  // The root itself is not a repo: plain listing, no statuses anywhere.
  const root = await listdir(c1, "m1", "");
  assert.equal(root.error, undefined);
  assert.deepEqual(root.entries, [
    { name: "plain", kind: "dir" },
    { name: "repoA", kind: "dir" },
    { name: "repoB", kind: "dir" },
  ]);

  // repoA through its own view: dist/ gone (A's .gitignore), the untracked
  // dir U, the modified file M, the deleted file still VISIBLE with D, the
  // clean files statusless.
  const a = await listdir(c1, "m2", "repoA");
  assert.equal(a.error, undefined);
  assert.deepEqual(a.entries, [
    { name: "newdir", kind: "dir", status: "U" },
    { name: ".gitignore", kind: "file" },
    { name: "changed.txt", kind: "file", status: "M" },
    { name: "doomed.txt", kind: "file", status: "D" },
    { name: "kept.txt", kind: "file" },
  ]);

  // Inside the collapsed untracked dir, children inherit U — porcelain gave
  // them no record of their own.
  const nested = await listdir(c1, "m3", "repoA/newdir");
  assert.equal(nested.error, undefined);
  assert.deepEqual(nested.entries, [{ name: "fresh.txt", kind: "file", status: "U" }]);

  // repoB's OWN rules: secret.log gone here (and only here), while dist/ —
  // ignored in repoA — is a visible untracked dir in B. No rule leaks across.
  const b = await listdir(c2, "m4", "repoB");
  assert.equal(b.error, undefined);
  assert.deepEqual(b.entries, [
    { name: "dist", kind: "dir", status: "U" },
    { name: ".gitignore", kind: "file" },
    { name: "app.ts", kind: "file" },
  ]);

  // The plain dir: outside any repo, the E2.1 listing byte-identical —
  // entries and nothing else.
  const p = await listdir(c2, "m5", "plain");
  assert.equal(p.error, undefined);
  assert.deepEqual(p.entries, [{ name: "note.txt", kind: "file" }]);

  assert.doesNotMatch(d.logs(), /crashed \(uncaughtException\)/);
  c1.close();
  c2.close();
});

test("E2.3: a single-repo root gets the git view lazily — and the legacy whole-tree pair still answers beside it", async () => {
  const c = await openSession(path.join(mr, "repoA"));
  c.send({ type: "fs_listdir", id: "s1", path: "" } as ClientMsg);
  const root = (await c.waitFor((m) => m.type === "fs_dir" && (m as Any).id === "s1", "fs_dir s1")) as Any;
  assert.equal(root.error, undefined);
  assert.deepEqual(root.entries, [
    { name: "newdir", kind: "dir", status: "U" },
    { name: ".gitignore", kind: "file" },
    { name: "changed.txt", kind: "file", status: "M" },
    { name: "doomed.txt", kind: "file", status: "D" },
    { name: "kept.txt", kind: "file" },
  ]);

  // The compatibility floor, now with git: the legacy fs_list on the SAME
  // connection still serves the whole-tree git view exactly as Phase E did —
  // including its quirk of surfacing a wholly-untracked dir as a collapsed
  // `newdir/` U entry beside the statusless file ls-files lists. Pinned
  // as-is: the old pair is byte-identical, never "improved".
  c.send({ type: "fs_list", id: "s2" } as ClientMsg);
  const tree = (await c.waitFor((m) => m.type === "fs_tree" && (m as Any).id === "s2", "fs_tree s2")) as Any;
  assert.equal(tree.error, undefined);
  assert.equal(tree.git, true);
  assert.deepEqual(
    (tree.entries as { path: string; status?: string }[]).map((e) => [e.path, e.status]),
    [
      [".gitignore", undefined],
      ["changed.txt", "M"],
      ["doomed.txt", "D"],
      ["kept.txt", undefined],
      ["newdir/", "U"],
      ["newdir/fresh.txt", undefined],
    ],
  );
  c.close();
});

test("E2.4: a diff comes from the repo that CONTAINS the file — nested repos diff, the plain dir degrades honestly", async () => {
  const c = await openSession(mr);
  const diff = async (id: string, p: string) => {
    await settle(THROTTLE_MS + 30);
    c.send({ type: "fs_diff", id, path: p } as ClientMsg);
    return (await c.waitFor(
      (m) => m.type === "fs_file_diff" && (m as Any).id === id,
      `fs_file_diff ${id}`,
    )) as Any;
  };

  // A modified file in a nested repo: HEAD's version resolves through repoA,
  // not the (non-repo) session root — E2.3's recorded gap, closed.
  const mod = await diff("d1", "repoA/changed.txt");
  assert.equal(mod.error, undefined);
  assert.equal(mod.before, "before\n");
  assert.equal(mod.after, "after\n");

  // A deleted file still diffs: HEAD's content against an empty after side.
  const gone = await diff("d2", "repoA/doomed.txt");
  assert.equal(gone.error, undefined);
  assert.equal(gone.before, "d\n");
  assert.equal(gone.after, "");

  // Outside any repo there is honestly no diff — the error reply, unchanged.
  const plain = await diff("d3", "plain/note.txt");
  assert.match(String(plain.error), /not a git repository/);

  // The textual jail still fronts everything repo discovery does.
  const escape = await diff("d4", "../loot.txt");
  assert.equal(typeof escape.error, "string");
  assert.doesNotMatch(d.logs(), /crashed \(uncaughtException\)/);
  c.close();
});

test("E2.4: the old-client floor at a Projects root — legacy fs_list still serves the whole-tree walk", async () => {
  // An old app bundle against a new daemon sends only fs_list. At a
  // multi-repo root that's the PLAIN walk (git:false — the root is no repo):
  // no statuses, ignore rules unhonored, every nested repo's files flat.
  // Pinned as-is: this is the compatibility floor the lazy pair improves on,
  // and it must keep answering exactly like this, never be "fixed".
  const c = await openSession(mr);
  c.send({ type: "fs_list", id: "f1" } as ClientMsg);
  const tree = (await c.waitFor((m) => m.type === "fs_tree" && (m as Any).id === "f1", "fs_tree f1")) as Any;
  assert.equal(tree.error, undefined);
  assert.equal(tree.git, false);
  assert.deepEqual(
    (tree.entries as { path: string; status?: string }[]).map((e) => e.path),
    [
      "plain/note.txt",
      "repoA/.gitignore",
      "repoA/changed.txt",
      "repoA/dist/bundle.js",
      "repoA/kept.txt",
      "repoA/newdir/fresh.txt",
      "repoB/.gitignore",
      "repoB/app.ts",
      "repoB/dist/x.js",
      "repoB/secret.log",
    ],
  );
  assert.ok(
    (tree.entries as { status?: string }[]).every((e) => e.status === undefined),
    "the plain walk never carries statuses",
  );
  c.close();
});

// The 2026-07-26 audit's probe, kept as a permanent pin (SECURITY.md, "Git
// metadata is read from the containing repo"). Since E2.3 the daemon finds a
// directory's repo by walking ABOVE the session root, so it runs git in — and
// reads HEAD through — a repo the session was never scoped to. That is
// deliberate fidelity; the bound is that NOTHING from outside the session
// directory reaches the wire. A session scoped to a subdirectory must not be
// able to see, name, or read anything in its parent repo above that scope,
// and every escape route must still refuse.
test("SECURITY (audit 2026-07-26): a subdirectory-scoped session sees nothing above its scope, though the repo above it is what supplies git data", async () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "fsx-scope-"));
  const repo = path.join(base, "repo");
  mkdirSync(path.join(repo, "public", "inner"), { recursive: true });
  git(repo, "init", "-q");
  writeFileSync(path.join(repo, "TOPSECRET.txt"), "sibling secret\n");
  writeFileSync(path.join(repo, "SECRETGONE.txt"), "deleted sibling secret\n");
  writeFileSync(path.join(repo, "public", "ok.txt"), "committed\n");
  writeFileSync(path.join(repo, "public", "inner", "deep.txt"), "deep\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  // Dirt ABOVE the scope and inside it: the status the panel shows must come
  // from the parent repo, while the secrets above stay invisible. Both dirty
  // SHAPES exist above the scope on purpose — a modified file AND a deleted
  // one. The deleted case is the one that matters most: deleted files are
  // merged into a listing from status alone (they aren't on disk to be read
  // by readdir), so a regression in that merge's same-directory check is
  // exactly how a path from above the scope could reach the wire.
  writeFileSync(path.join(repo, "TOPSECRET.txt"), "sibling secret CHANGED\n");
  rmSync(path.join(repo, "SECRETGONE.txt"));
  writeFileSync(path.join(repo, "public", "ok.txt"), "committed CHANGED\n");
  // A second repo entirely outside, reachable only by a planted symlink.
  const outsideRepo = path.join(base, "outsiderepo");
  mkdirSync(outsideRepo);
  git(outsideRepo, "init", "-q");
  writeFileSync(path.join(outsideRepo, "loot.txt"), "loot\n");
  git(outsideRepo, "add", "-A");
  git(outsideRepo, "commit", "-qm", "init");
  writeFileSync(path.join(outsideRepo, "loot.txt"), "loot CHANGED\n");
  symlinkSync(outsideRepo, path.join(repo, "public", "escape"));

  const c = await openSession(path.join(repo, "public"));
  const root = await listdir(c, "sc1", "");
  assert.equal(root.error, undefined);
  // The parent repo IS supplying git data — ok.txt carries its M — while
  // nothing above the scope is named.
  assert.deepEqual(root.entries, [
    { name: "inner", kind: "dir" },
    { name: "escape", kind: "symlink", status: "U" },
    { name: "ok.txt", kind: "file", status: "M" },
  ]);
  const serialized = JSON.stringify(root);
  assert.ok(!serialized.includes("TOPSECRET"), "a file above the session scope was named on the wire");
  assert.ok(
    !serialized.includes("SECRETGONE"),
    "a DELETED file above the session scope was merged into the listing",
  );
  assert.ok(!serialized.includes(base), "an absolute path above the session root reached the wire");

  // Every escape route still refuses — including the symlink to a real repo.
  for (const [id, p] of [
    ["sc2", ".."],
    ["sc3", repo],
    ["sc4", "escape"],
  ] as const) {
    const r = await listdir(c, id, p);
    assert.match(String(r.error), /outside the session workspace/, `${p} must refuse`);
    assert.deepEqual(r.entries, [], "a refused listing never carries entries");
  }

  const diff = async (id: string, p: string) => {
    await settle(THROTTLE_MS + 30);
    c.send({ type: "fs_diff", id, path: p } as ClientMsg);
    return (await c.waitFor(
      (m) => m.type === "fs_file_diff" && (m as Any).id === id,
      `fs_file_diff ${id}`,
    )) as Any;
  };
  // The in-scope diff works THROUGH the parent repo (that's the E2.4 fix)…
  const ok = await diff("sd1", "ok.txt");
  assert.equal(ok.error, undefined);
  assert.equal(ok.before, "committed\n");
  assert.equal(ok.after, "committed CHANGED\n");
  // …while the secret above the scope, and the outside repo's file behind the
  // symlink, both refuse — the repo walk never becomes a read path.
  const secret = await diff("sd2", "../TOPSECRET.txt");
  assert.equal(typeof secret.error, "string");
  assert.equal(secret.before, undefined, "denied content never rides an error reply");
  const looted = await diff("sd3", "escape/loot.txt");
  assert.equal(typeof looted.error, "string");
  assert.equal(looted.before, undefined);

  assert.doesNotMatch(d.logs(), /crashed \(uncaughtException\)/);
  c.close();
  rmSync(base, { recursive: true, force: true });
});

test("E.1: no session attached — both queries answer with an error reply, not silence", async () => {
  const c = new TestClient(d.port);
  await c.opened();
  await c.type("agents"); // connected, but never created/attached
  c.send({ type: "fs_list", id: "n1" } as ClientMsg);
  const tree = (await c.waitFor((m) => m.type === "fs_tree", "fs_tree")) as Any;
  assert.match(String(tree.error), /no session/);
  c.send({ type: "fs_read", id: "n2", path: "README.md" } as ClientMsg);
  const file = (await c.waitFor((m) => m.type === "fs_file", "fs_file")) as Any;
  assert.match(String(file.error), /no session/);
  c.send({ type: "fs_listdir", id: "n3", path: "" } as ClientMsg);
  const dir = (await c.waitFor((m) => m.type === "fs_dir", "fs_dir")) as Any;
  assert.match(String(dir.error), /no session/);
  c.close();
});

test("E.1: a session root deleted after create errors cleanly, never crashes", async () => {
  const doomed = mkdtempSync(path.join(os.tmpdir(), "fsx-doomed-"));
  writeFileSync(path.join(doomed, "a.txt"), "a");
  const c = await openSession(doomed);
  rmSync(doomed, { recursive: true, force: true });
  c.send({ type: "fs_list", id: "d1" } as ClientMsg);
  const tree = (await c.waitFor((m) => m.type === "fs_tree", "fs_tree")) as Any;
  assert.equal(typeof tree.error, "string");
  await settle(THROTTLE_MS + 30);
  c.send({ type: "fs_read", id: "d2", path: "a.txt" } as ClientMsg);
  const file = (await c.waitFor((m) => m.type === "fs_file", "fs_file")) as Any;
  assert.equal(typeof file.error, "string");
  assert.doesNotMatch(d.logs(), /crashed \(uncaughtException\)/);
  c.close();
});
