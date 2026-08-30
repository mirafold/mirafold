import { test } from "node:test";
import assert from "node:assert/strict";
import { folderTreeNodeGlyphKind } from "./FolderTreeNodeGlyph";

test("folderTreeNodeGlyphKind distinguishes symlinks and broad file families", () => {
  assert.equal(folderTreeNodeGlyphKind("current.ts", "symlink"), "symlink");

  assert.equal(folderTreeNodeGlyphKind("PromptBox.TSX", "file"), "code");
  assert.equal(folderTreeNodeGlyphKind("package.json", "file"), "config");
  assert.equal(folderTreeNodeGlyphKind(".gitignore", "file"), "config");
  assert.equal(folderTreeNodeGlyphKind("yarn.lock", "file"), "config");
  assert.equal(folderTreeNodeGlyphKind("README.md", "file"), "document");
  assert.equal(folderTreeNodeGlyphKind("theme.scss", "file"), "style");
  assert.equal(folderTreeNodeGlyphKind("logo.svg", "file"), "image");
  assert.equal(folderTreeNodeGlyphKind("LICENSE", "file"), "file");
});
