import { test } from "node:test";
import assert from "node:assert/strict";
import { explorerNodeGlyphKind } from "./ExplorerNodeGlyph";

test("explorerNodeGlyphKind distinguishes hierarchy and broad file families", () => {
  assert.equal(explorerNodeGlyphKind("src", "dir"), "folder");
  assert.equal(explorerNodeGlyphKind("src", "dir", true), "folder-open");
  assert.equal(explorerNodeGlyphKind("current.ts", "symlink"), "symlink");

  assert.equal(explorerNodeGlyphKind("PromptBox.TSX", "file"), "code");
  assert.equal(explorerNodeGlyphKind("package.json", "file"), "config");
  assert.equal(explorerNodeGlyphKind(".gitignore", "file"), "config");
  assert.equal(explorerNodeGlyphKind("yarn.lock", "file"), "config");
  assert.equal(explorerNodeGlyphKind("README.md", "file"), "document");
  assert.equal(explorerNodeGlyphKind("theme.scss", "file"), "style");
  assert.equal(explorerNodeGlyphKind("logo.svg", "file"), "image");
  assert.equal(explorerNodeGlyphKind("LICENSE", "file"), "file");
});
