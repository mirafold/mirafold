import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanRelPath, parseStatusZ } from "./git";

// E.2's pure parsing pins: the -z rename two-field trap, status collapsing,
// and the textual path containment that guards `git show`.

test("parseStatusZ: plain records collapse to single chars", () => {
  const m = parseStatusZ("M  a.txt\0?? new.txt\0 D gone.txt\0A  staged.txt\0 M work.txt\0");
  assert.equal(m.get("a.txt"), "M");
  assert.equal(m.get("new.txt"), "U");
  assert.equal(m.get("gone.txt"), "D");
  assert.equal(m.get("staged.txt"), "A");
  assert.equal(m.get("work.txt"), "M");
});

test("parseStatusZ: a rename record is TWO fields — later records stay aligned", () => {
  // R: `XY to\0from\0`. A naive one-field split would read `old.txt` as a
  // record and misparse everything after it.
  const m = parseStatusZ("R  new-name.txt\0old-name.txt\0M  after-the-rename.txt\0");
  assert.equal(m.get("new-name.txt"), "A");
  assert.equal(m.get("old-name.txt"), "D");
  assert.equal(m.get("after-the-rename.txt"), "M", "alignment survives the rename record");
});

test("parseStatusZ: a copy's source is NOT marked deleted", () => {
  const m = parseStatusZ("C  copy.txt\0source.txt\0");
  assert.equal(m.get("copy.txt"), "A");
  assert.equal(m.get("source.txt"), undefined, "the copy source still exists unchanged");
});

test("parseStatusZ: trailing empty field and junk are ignored", () => {
  const m = parseStatusZ("M  a.txt\0\0x\0");
  assert.equal(m.size, 1);
});

test("cleanRelPath: accepts plain relative paths, normalizes ./", () => {
  assert.equal(cleanRelPath("src/app.ts"), "src/app.ts");
  assert.equal(cleanRelPath("./src/app.ts"), "src/app.ts");
  assert.equal(cleanRelPath("a"), "a");
});

test("cleanRelPath: rejects traversal, absolute, empty, backslash, NUL, oversized", () => {
  for (const bad of [
    "../loot",
    "a/../b",
    "..",
    "/etc/passwd",
    "",
    "a//b",
    "a\\b",
    "a\0b",
    ".",
    "x".repeat(5_000),
  ]) {
    assert.equal(cleanRelPath(bad), null, JSON.stringify(bad));
  }
});
