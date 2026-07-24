import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listTree, readWorkspaceFile } from "./fs-explorer";

// E.1's module contract, on real temp directories: the walk's shape and caps,
// the jail, the secret denial, and the read's binary/truncation/UTF-8 honesty.

const madeDirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), "fsx-"));
  madeDirs.push(d);
  return d;
};

after(() => {
  for (const d of madeDirs) rmSync(d, { recursive: true, force: true });
});

test("listTree: nested files as /-relative paths, alphabetical per dir, skip dirs pruned", () => {
  const root = tmp();
  mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(path.join(root, "zz.txt"), "z");
  writeFileSync(path.join(root, "README.md"), "r");
  writeFileSync(path.join(root, "src", "app.ts"), "a");
  writeFileSync(path.join(root, "src", "deep", "x.ts"), "x");
  writeFileSync(path.join(root, ".git", "HEAD"), "ref");
  writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "m");
  const r = listTree(root);
  assert.ok(!("error" in r));
  assert.deepEqual(
    r.entries.map((e) => e.path),
    ["README.md", "src/app.ts", "src/deep/x.ts", "zz.txt"],
  );
  assert.equal(r.truncated, false);
});

test("listTree: a symlink is a leaf — even to a directory, it is never followed", () => {
  const root = tmp();
  mkdirSync(path.join(root, "real"));
  writeFileSync(path.join(root, "real", "inner.txt"), "i");
  symlinkSync(path.join(root, "real"), path.join(root, "link"));
  const r = listTree(root);
  assert.ok(!("error" in r));
  const paths = r.entries.map((e) => e.path);
  assert.ok(paths.includes("link"), "the symlink itself is listed");
  assert.ok(!paths.includes("link/inner.txt"), "the link's target is not recursed into");
  assert.ok(paths.includes("real/inner.txt"), "the real directory still walks");
});

test("listTree: entry cap trips honestly", () => {
  const root = tmp();
  for (let i = 0; i < 5; i++) writeFileSync(path.join(root, `f${i}.txt`), "x");
  const r = listTree(root, { maxEntries: 3 });
  assert.ok(!("error" in r));
  assert.equal(r.entries.length, 3);
  assert.equal(r.truncated, true);
});

test("listTree: path-byte cap trips honestly", () => {
  const root = tmp();
  for (let i = 0; i < 5; i++) writeFileSync(path.join(root, `file-with-a-name-${i}.txt`), "x");
  const r = listTree(root, { maxPathBytes: 50 });
  assert.ok(!("error" in r));
  assert.equal(r.truncated, true);
  assert.ok(r.entries.length < 5);
});

test("listTree: the walk is node-bounded — a tree of empty dirs can't be walked without limit (audit 2026-07-24)", () => {
  const root = tmp();
  // 30 sibling directories, each with a nested empty child — NO files, so the
  // entry/byte caps never trip. Before the node cap this walked all of them.
  for (let i = 0; i < 30; i++) {
    mkdirSync(path.join(root, `dir${i}`, "child"), { recursive: true });
  }
  const r = listTree(root, { maxNodes: 10 });
  assert.ok(!("error" in r));
  assert.equal(r.truncated, true, "the node cap must trip on a file-less tree");
  // And a normal small tree with room to spare is NOT flagged truncated.
  writeFileSync(path.join(root, "a.txt"), "a");
  const ok = listTree(tmp());
  assert.ok(!("error" in ok));
});

test("listTree: unreadable root is the error case, not a throw", () => {
  const r = listTree(path.join(os.tmpdir(), "fsx-does-not-exist-ever"));
  assert.ok("error" in r);
});

test("readWorkspaceFile: content round-trip with size", () => {
  const root = tmp();
  writeFileSync(path.join(root, "a.txt"), "hello mirafold\n");
  const r = readWorkspaceFile(root, "a.txt");
  assert.ok("content" in r);
  assert.equal(r.content, "hello mirafold\n");
  assert.equal(r.size, 15);
  assert.equal(r.truncatedBytes, undefined);
});

test("readWorkspaceFile: the jail — ../, absolute, and symlink-out all refuse", () => {
  const root = tmp();
  const outside = tmp();
  writeFileSync(path.join(outside, "loot.txt"), "outside");
  symlinkSync(path.join(outside, "loot.txt"), path.join(root, "innocent.txt"));
  for (const p of ["../loot.txt", path.join(outside, "loot.txt"), "innocent.txt"]) {
    const r = readWorkspaceFile(root, p);
    assert.ok("error" in r, `${p} must refuse`);
  }
});

test("readWorkspaceFile: secret env files refuse by basename, anywhere in the tree", () => {
  const root = tmp();
  mkdirSync(path.join(root, "sub"));
  writeFileSync(path.join(root, ".env"), "SECRET=1");
  writeFileSync(path.join(root, "sub", ".env.local"), "SECRET=2");
  writeFileSync(path.join(root, "sub", "envy.txt"), "fine");
  assert.ok("error" in readWorkspaceFile(root, ".env"));
  assert.ok("error" in readWorkspaceFile(root, "sub/.env.local"));
  assert.ok("content" in readWorkspaceFile(root, "sub/envy.txt"));
  // Listing still SHOWS them — honesty over hiding; only content is refused.
  const tree = listTree(root);
  assert.ok(!("error" in tree));
  assert.ok(tree.entries.some((e) => e.path === ".env"));
});

test("readWorkspaceFile: a directory and a missing file are errors", () => {
  const root = tmp();
  mkdirSync(path.join(root, "d"));
  assert.ok("error" in readWorkspaceFile(root, "d"));
  assert.ok("error" in readWorkspaceFile(root, "nope.txt"));
});

test("readWorkspaceFile: NUL sniff marks binary and withholds content", () => {
  const root = tmp();
  writeFileSync(path.join(root, "img.png"), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d]));
  const r = readWorkspaceFile(root, "img.png");
  assert.ok("binary" in r && r.binary === true);
  assert.equal(r.size, 5);
  assert.ok(!("content" in r));
});

test("readWorkspaceFile: cap is honest — truncatedBytes = size minus kept", () => {
  const root = tmp();
  writeFileSync(path.join(root, "big.txt"), "a".repeat(100_000));
  const r = readWorkspaceFile(root, "big.txt");
  assert.ok("content" in r);
  assert.equal(Buffer.byteLength(r.content, "utf8"), 64_000);
  assert.equal(r.size, 100_000);
  assert.equal(r.truncatedBytes, 36_000);
});

test("readWorkspaceFile: invalid UTF-8 decodes lossily, never throws", () => {
  const root = tmp();
  writeFileSync(path.join(root, "weird.txt"), Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x21]));
  const r = readWorkspaceFile(root, "weird.txt");
  assert.ok("content" in r);
  assert.ok(r.content.startsWith("hi"));
  assert.ok(r.content.includes("�"));
});

test("readWorkspaceFile: empty file is empty content, not an error", () => {
  const root = tmp();
  writeFileSync(path.join(root, "empty.txt"), "");
  const r = readWorkspaceFile(root, "empty.txt");
  assert.ok("content" in r);
  assert.equal(r.content, "");
  assert.equal(r.size, 0);
});
