import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFileTree, type FileNode } from "./files-tree";

// The shell-owned flat→nested tree (E.3): dir inference, status carry, and
// the dirs-first display ordering the panel relies on.

const names = (nodes: FileNode[]) => nodes.map((n) => n.name);

test("nests flat paths and infers directories", () => {
  const tree = buildFileTree([
    { path: "src/app.ts" },
    { path: "src/deep/x.ts" },
    { path: "README.md" },
  ]);
  assert.deepEqual(names(tree), ["src", "README.md"]); // dir before file
  const src = tree[0]!;
  assert.equal(src.isDir, true);
  assert.equal(src.path, "src");
  assert.deepEqual(names(src.children), ["deep", "app.ts"]); // dir before file
  const deep = src.children[0]!;
  assert.equal(deep.path, "src/deep");
  assert.equal(deep.children[0]!.path, "src/deep/x.ts");
});

test("carries the git status onto the leaf, not its ancestors", () => {
  const tree = buildFileTree([{ path: "src/app.ts", status: "M" }]);
  assert.equal(tree[0]!.status, undefined, "the dir has no status");
  assert.equal(tree[0]!.children[0]!.status, "M");
});

test("dirs sort before files, alphabetical within each group", () => {
  const tree = buildFileTree([
    { path: "z.txt" },
    { path: "a.txt" },
    { path: "beta/one.ts" },
    { path: "alpha/two.ts" },
  ]);
  assert.deepEqual(names(tree), ["alpha", "beta", "a.txt", "z.txt"]);
});

test("a path that later proves to be a directory is reclassified", () => {
  // "src" appears as a leaf first, then as a parent — must end a dir.
  const tree = buildFileTree([{ path: "src" }, { path: "src/app.ts" }]);
  assert.equal(tree[0]!.isDir, true);
  assert.equal(tree[0]!.children[0]!.name, "app.ts");
});

test("empty and root-ish inputs don't throw", () => {
  assert.deepEqual(buildFileTree([]), []);
  assert.deepEqual(buildFileTree([{ path: "" }]), []);
});
