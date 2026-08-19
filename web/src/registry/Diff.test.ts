import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSnippet } from "./Diff";

test("diffSnippet diffs a change through the shared line differ", () => {
  assert.deepEqual(diffSnippet("a\nb", "a\nB"), [
    { sign: " ", text: "a" },
    { sign: "-", text: "b", noNewline: true },
    { sign: "+", text: "B", noNewline: true },
  ]);
});

test("diffSnippet: empty before = new file, all additions, no phantom empty line", () => {
  assert.deepEqual(diffSnippet("", "x\ny"), [
    { sign: "+", text: "x" },
    { sign: "+", text: "y", noNewline: true },
  ]);
});

test("diffSnippet: empty after = deletion, all removals", () => {
  assert.deepEqual(diffSnippet("x", ""), [{ sign: "-", text: "x", noNewline: true }]);
});

test("diffSnippet: both sides empty renders nothing", () => {
  assert.deepEqual(diffSnippet("", ""), []);
});
