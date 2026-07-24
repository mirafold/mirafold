import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClientMsg, WireMsg } from "../protocol";
import { startDaemon, TestClient, type Daemon } from "../testing/itest-harness";

// E.1 over a REAL daemon and socket: the fs_list/fs_read round-trip against a
// scripted temp workspace, the jail + secret denial refusing with error
// REPLIES (daemon alive after every attempt), the per-type throttle answering
// instead of dropping, the no-session case, and a deleted session root.
// Replies must be per-viewport: no seq, ever.

type Any = WireMsg & Record<string, any>;

let d: Daemon;
let ws: string; // the session workspace
let outside: string; // where the planted symlink points

// The throttle window under test — small so the suite stays fast, real so
// the burst case actually trips it.
const THROTTLE_MS = 150;
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
  d = await startDaemon({ FS_MIN_INTERVAL_MS: String(THROTTLE_MS) });
});
after(async () => {
  await d.stop();
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
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
  const first = (await c.waitFor((m) => m.type === "fs_tree" && (m as Any).id === "b1", "b1")) as Any;
  const second = (await c.waitFor((m) => m.type === "fs_tree" && (m as Any).id === "b2", "b2")) as Any;
  assert.equal(first.error, undefined);
  assert.match(String(second.error), /too fast/);
  await settle(THROTTLE_MS + 30);
  c.send({ type: "fs_list", id: "b3" } as ClientMsg);
  const third = (await c.waitFor((m) => m.type === "fs_tree" && (m as Any).id === "b3", "b3")) as Any;
  assert.equal(third.error, undefined);
  c.close();
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
