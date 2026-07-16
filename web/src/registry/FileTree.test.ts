import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree } from "./FileTree";

test("buildTree nests slash paths under shared parents, first appearance fixes order", () => {
  const tree = buildTree([
    { path: "src/api/router.ts" },
    { path: "src/lib/tokens.ts" },
    { path: "test/auth.test.ts" },
  ]);
  assert.deepEqual(
    tree.map((n) => n.name),
    ["src", "test"],
  );
  const src = tree[0]!;
  assert.equal(src.isDir, true);
  assert.deepEqual(
    src.children.map((n) => n.name),
    ["api", "lib"],
  );
  assert.equal(src.children[0]!.children[0]!.name, "router.ts");
  assert.equal(src.children[0]!.children[0]!.isDir, false);
});

test("buildTree merges a repeated parent instead of duplicating it", () => {
  const tree = buildTree([{ path: "src/a.ts" }, { path: "src/b.ts" }]);
  assert.equal(tree.length, 1);
  assert.deepEqual(
    tree[0]!.children.map((n) => n.name),
    ["a.ts", "b.ts"],
  );
});

test("buildTree: trailing slash marks a childless dir; notes attach to the leaf", () => {
  const tree = buildTree([
    { path: "test/fixtures/" },
    { path: "src/api/handlers/auth.ts", note: "new" },
  ]);
  const fixtures = tree[0]!.children[0]!;
  assert.equal(fixtures.name, "fixtures");
  assert.equal(fixtures.isDir, true);
  assert.equal(fixtures.children.length, 0);
  const auth = tree[1]!.children[0]!.children[0]!.children[0]!;
  assert.equal(auth.name, "auth.ts");
  assert.equal(auth.note, "new");
  assert.equal(auth.isDir, false);
});

test("buildTree: a file later reached through becomes a dir, and empty paths drop", () => {
  const tree = buildTree([{ path: "src" }, { path: "src/deep/x.ts" }, { path: "/" }]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0]!.isDir, true);
});
