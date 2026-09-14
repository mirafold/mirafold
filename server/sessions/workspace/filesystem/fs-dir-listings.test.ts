import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DirectoryListings } from "./fs-dir-listings";
import { createFsHandlers } from "./fs-handlers";
import { openConnection } from "../../connection";
import { SessionRegistry } from "../../registry";
import type { FsDirEntry, WireMsg } from "../../../protocol";

function fixture(t: TestContext, entries: FsDirEntry[], failAt = Infinity) {
  const base = fs.mkdtempSync(path.join(tmpdir(), "mirafold-dir-pages-"));
  const root = path.join(base, "workspace");
  fs.mkdirSync(root);
  const handles: { reads: number; closes: number }[] = [];
  const original = fs.opendirSync;
  t.mock.method(fs, "opendirSync", (p: fs.PathLike, ...args: unknown[]) => {
    if (String(p) !== root) return original(p, args[0] as never);
    const handle = { reads: 0, closes: 0 };
    handles.push(handle);
    return {
      readSync() {
        assert.equal(handle.closes, 0, "closed handles cannot be read");
        if (handle.reads === failAt) throw new Error("injected read failure");
        const entry = entries[handle.reads++];
        return entry ? {
          name: entry.name,
          isDirectory: () => entry.kind === "dir",
          isSymbolicLink: () => entry.kind === "symlink",
        } : null;
      },
      closeSync() { handle.closes++; },
    } as unknown as fs.Dir;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, root, handles };
}

const files = (count: number, padding = ""): FsDirEntry[] =>
  Array.from({ length: count }, (_, i) => ({ name: `file-${String(i).padStart(5, "0")}${padding}`, kind: "file" }));

for (const padding of ["", "x".repeat(230)]) {
  test(`later directories are reachable after a files-only raw page; each request respects all caps (${padding.length ? "long" : "short"} names)`, t => {
    const expected = [...files(10_000, padding), { name: "late-directory", kind: "dir" as const }];
    const { root, handles } = fixture(t, expected);
    const listings = new DirectoryListings({ maxScanEntries: 20_000 });
    t.after(() => listings.clear());
    const scope = {};
    let listing = listings.open(scope, root, "");
    let previousReads = 0;
    const names: string[] = [];
    let requests = 0;
    for (;;) {
      const page = listings.page(listing);
      const reads = handles[0].reads;
      assert.ok(reads - previousReads <= 10_000, "one request reads at most one raw page, including EOF probes");
      assert.ok(page.entries.length <= 2_000);
      assert.ok(page.entries.reduce((n, e) => n + Buffer.byteLength(e.name), 0) <= 200_000);
      if (requests++ === 0) {
        assert.equal(reads, 10_000);
        assert.ok(page.entries.every(e => e.kind === "file"));
        assert.equal(page.truncated, true);
        assert.ok(page.continuation);
      }
      names.push(...page.entries.map(e => e.name));
      previousReads = reads;
      if (!page.continuation) break;
      assert.ok(requests < 30, "continuations must make progress");
      const token = page.continuation;
      listing = listings.resume(scope, root, "", token);
      assert.throws(() => listings.resume(scope, root, "", token), /no longer available/, "single-use token");
    }
    assert.equal(handles.length, 1, "never reopen to rescan an offset");
    assert.equal(handles[0].closes, 1);
    assert.deepEqual(new Set(names), new Set(expected.map(e => e.name)));
    assert.equal(names.length, expected.length, "no skipped or duplicate entries");
    assert.equal(names.at(-1), "late-directory");
  });
}

test("empty filtered pages continue, while directory skips and symlink kinds remain intact", t => {
  const { root } = fixture(t, [
    { name: ".git", kind: "dir" }, { name: "node_modules", kind: "dir" },
    { name: "linked-directory", kind: "symlink" }, { name: "visible", kind: "dir" },
  ]);
  const listings = new DirectoryListings({ maxScanEntries: 2 });
  t.after(() => listings.clear());
  const scope = {};
  const first = listings.page(listings.open(scope, root, ""));
  assert.deepEqual(first.entries, []);
  assert.ok(first.continuation);
  const second = listings.page(listings.resume(scope, root, "", first.continuation));
  assert.deepEqual(second.entries, [
    { name: "visible", kind: "dir" }, { name: "linked-directory", kind: "symlink" },
  ]);
  assert.ok(second.continuation, "exact raw boundary does not read ahead");
  const last = listings.page(listings.resume(scope, root, "", second.continuation));
  assert.deepEqual(last, { entries: [] });
});

test("scope, replacement, and connection boundaries invalidate continuations", t => {
  const { root, handles } = fixture(t, files(4));
  const listings = new DirectoryListings({ maxScanEntries: 2 });
  const otherConnection = new DirectoryListings();
  t.after(() => { listings.clear(); otherConnection.clear(); });
  const scope = {};
  const start = () => listings.page(listings.open(scope, root, ""));
  let page = start();
  assert.throws(() => otherConnection.resume(scope, root, "", page.continuation), /no longer available/);
  assert.equal(handles[0].closes, 0, "another connection cannot cancel the original listing");
  assert.throws(() => listings.resume(scope, root, "another-directory", page.continuation), /no longer available/);
  assert.equal(handles[0].closes, 1);
  page = start();
  start();
  assert.throws(() => listings.resume(scope, root, "", page.continuation), /no longer available/);
  page = start();
  assert.throws(() => listings.resume({}, root, "", page.continuation), /no longer available/);
  assert.ok(handles.every(h => h.closes === 1), "session change closes all retained handles");
});

test("expiry, capacity eviction, read errors, and directory replacement close retained handles", async t => {
  const { root, base, handles } = fixture(t, files(5));
  const listings = new DirectoryListings({ maxScanEntries: 2, ttlMs: 15, maxListings: 1 });
  t.after(() => listings.clear());
  const scope = {};
  const page = listings.page(listings.open(scope, root, ""));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(handles[0].closes, 1);
  assert.throws(() => listings.resume(scope, root, "", page.continuation), /no longer available/);
  const first = listings.open(scope, root, "");
  listings.open(scope, root, "./");
  assert.equal(listings.has(first), false, "capacity is bounded even for path aliases");
  assert.equal(handles[1].closes, 1);
  const active = listings.open(scope, root, "");
  fs.renameSync(root, path.join(base, "moved"));
  fs.mkdirSync(root);
  assert.throws(() => listings.page(active), /directory changed/);
  assert.equal(handles.at(-1)?.closes, 1);
});

test("a failed raw read closes its handle and retires the listing", t => {
  const { root, handles } = fixture(t, files(5), 1);
  const listings = new DirectoryListings();
  const listing = listings.open({}, root, "");
  assert.throws(() => listings.page(listing), /not readable/);
  assert.equal(listings.has(listing), false);
  assert.equal(handles[0].closes, 1);
});

test("the jail is rechecked and an entry that cannot fit never creates an endless continuation", t => {
  const { root, base, handles } = fixture(t, [{ name: "too-long", kind: "file" }]);
  fs.mkdirSync(path.join(base, "outside"));
  fs.symlinkSync(path.join(base, "outside"), path.join(root, "escape"));
  const listings = new DirectoryListings({ maxNameBytes: 2 });
  t.after(() => listings.clear());
  for (const rel of ["../outside", "escape", path.join(base, "outside")]) {
    assert.throws(() => listings.open({}, root, rel), /outside the session workspace/);
  }
  const listing = listings.open({}, root, "");
  assert.throws(() => listings.page(listing), /exceeds the listing size limit/);
  assert.equal(listings.has(listing), false);
  assert.equal(handles[0].closes, 1);
});

test("a throttled continuation answers with an error and closes its retained scan", t => {
  const { root, handles } = fixture(t, files(10_001));
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const replies: WireMsg[] = [];
  const entry = { cwd: root };
  const handlers = createFsHandlers({ viewport: m => replies.push(m), getEntry: () => entry as never, isClosed: () => false });
  t.after(() => handlers.reset());
  handlers.listdir({ type: "fs_listdir", id: "first", path: "" });
  const first = replies[0];
  assert.ok(first.type === "fs_dir" && first.continuation);
  for (let i = 0; i < 31; i++) handlers.listdir({ type: "fs_listdir", id: `drain-${i}`, path: "", continuation: "invalid" });
  handlers.listdir({ type: "fs_listdir", id: "throttled", path: "", continuation: first.continuation });
  const refusal = replies.at(-1);
  assert.ok(refusal?.type === "fs_dir");
  assert.match(refusal.error ?? "", /too fast/);
  assert.equal(handles[0].closes, 1);
  now = 1_000;
  handlers.listdir({ type: "fs_listdir", id: "retired", path: "", continuation: first.continuation });
  const retired = replies.at(-1);
  assert.ok(retired?.type === "fs_dir");
  assert.match(retired.error ?? "", /no longer available/);
});

for (const teardown of ["disconnect", "watch", "switch", "end"] as const) {
  test(`connection ${teardown} closes an unfinished listing immediately`, t => {
    const { root, handles } = fixture(t, files(10_001));
    const registry = new SessionRegistry({ backend: { agent: "claude-code", kind: "none", live: false } });
    const entry = registry.create({ cwd: root });
    const second = registry.create({ cwd: root });
    const replies: WireMsg[] = [];
    const connection = openConnection(registry, m => replies.push(m));
    t.after(() => { connection.close(); registry.end(entry.id); registry.end(second.id); });
    connection.handleMessage(JSON.stringify({ type: "attach", sessionId: entry.id }));
    connection.handleMessage(JSON.stringify({ type: "fs_listdir", path: "", id: "page-one" }));
    const page = replies.find(m => m.type === "fs_dir");
    assert.ok(page?.type === "fs_dir" && page.continuation);
    assert.equal(handles[0].closes, 0, "the raw scan is still open after the first page");
    if (teardown === "disconnect") connection.close();
    else if (teardown === "end") registry.end(entry.id);
    else connection.handleMessage(JSON.stringify(teardown === "watch"
      ? { type: "watch_sessions" } : { type: "attach", sessionId: second.id }));
    assert.equal(handles[0].closes, 1);
  });
}
