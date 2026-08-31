import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DIFF_LCS_CELL_LIMIT, diffLines, unifiedDiffLines, wholeFileLines } from "../diff";
import { ToolBlock, formatBytes, lastLine } from "./ToolBlock";

test("a malformed MultiEdit input renders instead of throwing (engine data is checked per element)", () => {
  const html = renderToStaticMarkup(
    createElement(ToolBlock, {
      id: 1,
      toggled: null,
      onToggle: () => {},
      name: "MultiEdit",
      input: { file_path: "a.ts", edits: [null, 42, { old_string: "a", new_string: "b" }] },
      output: "",
      isError: true, // a failed record opens by default, so the input renders
    }),
  );
  assert.match(html, /tool-input/);
});

test("diffLines marks context, deletion, and addition", () => {
  assert.deepEqual(diffLines("a\nb\nc", "a\nB\nc"), [
    { sign: " ", text: "a" },
    { sign: "-", text: "b" },
    { sign: "+", text: "B" },
    { sign: " ", text: "c" },
  ]);
});

test("diffLines handles an empty side", () => {
  assert.deepEqual(diffLines("", "x"), [
    { sign: "+", text: "x", noNewline: true },
  ]);
});

test("diffLines bounds an oversized changed middle without dropping lines", () => {
  const side = Math.floor(Math.sqrt(DIFF_LCS_CELL_LIMIT)) + 1;
  const oldLines = Array.from({ length: side }, (_, i) => (i === 500 ? "shared" : `old-${i}`));
  const newLines = Array.from({ length: side }, (_, i) => (i === 500 ? "shared" : `new-${i}`));
  const lines = diffLines(oldLines.join("\n"), newLines.join("\n"));

  assert.equal(lines.length, side * 2);
  assert.equal(lines.filter((line) => line.sign === "-").length, side);
  assert.equal(lines.filter((line) => line.sign === "+").length, side);
  assert.equal(lines.filter((line) => line.text === "shared").length, 2);
  assert.equal(lines.at(side - 1)?.noNewline, true);
  assert.equal(lines.at(-1)?.noNewline, true);
});

test("diffLines: a terminated-vs-unterminated shared final line splits, git-style", () => {
  // Equal final text whose TERMINATION differs is a real replacement — on
  // BOTH shapes, not only when it's the final line of both sides (bughunt
  // 2026-08-13: the one-sided shapes silently hid the byte change).
  // Same final line on both sides:
  assert.deepEqual(diffLines("a\nb", "a\nb\n"), [
    { sign: " ", text: "a" },
    { sign: "-", text: "b", noNewline: true },
    { sign: "+", text: "b" },
  ]);
  // Old's unterminated final gains a newline AND a following line:
  assert.deepEqual(diffLines("a\nx", "a\nx\ny\n"), [
    { sign: " ", text: "a" },
    { sign: "-", text: "x", noNewline: true },
    { sign: "+", text: "x" },
    { sign: "+", text: "y" },
  ]);
  // The working tree truncates AND loses its trailing newline:
  assert.deepEqual(diffLines("x\ny\n", "x"), [
    { sign: "-", text: "x" },
    { sign: "+", text: "x", noNewline: true },
    { sign: "-", text: "y" },
  ]);
  // Control: both sides unterminated on the same shared line — honest
  // context, no split, no marker (bytes agree).
  assert.deepEqual(diffLines("a\nx", "b\nx"), [
    { sign: "-", text: "a" },
    { sign: "+", text: "b" },
    { sign: " ", text: "x" },
  ]);
});

test("formatBytes scales units", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});


test("an apply_patch row draws each file's patch as diff rows (TS.6)", () => {
  const html = renderToStaticMarkup(
    createElement(ToolBlock, {
      id: 2,
      toggled: true,
      onToggle: () => {},
      name: "apply_patch",
      input: {
        changes: [
          { path: "server/a.ts", kind: "update", diff: "@@ -1,2 +1,2 @@\n context\n-old line\n+new line\n" },
          { path: "NOTES.md", kind: "add", diff: "alpha probe\n" },
          { path: "gone.md", kind: "delete", diff: "bye" },
          { path: "old-name.ts", movePath: "new-name.ts", kind: "update", diff: "" },
        ],
      },
      output: "Updated server/a.ts, Added NOTES.md, Deleted gone.md",
    }),
  );
  assert.match(html, /Updated server\/a\.ts/);
  assert.match(html, /diff-del[^>]*>- old line/);
  assert.match(html, /diff-add[^>]*>\+ new line/);
  assert.match(html, /diff-ctx[^>]*>\s+context/);
  assert.match(html, /Added NOTES\.md/);
  assert.match(html, /diff-add[^>]*>\+ alpha probe/);
  assert.match(html, /Deleted gone\.md/);
  assert.match(html, /diff-del[^>]*>- bye/);
  assert.match(html, /Moved old-name\.ts → new-name\.ts/);
  assert.match(html, /No newline at end of file/); // "bye" has no trailing newline
  assert.doesNotMatch(html, /\[object Object\]/);
});

test("unifiedDiffLines and wholeFileLines produce the shared DiffLine rows", () => {
  assert.deepEqual(unifiedDiffLines("--- a\n+++ b\n@@ -1 +1 @@\n-x\n+y\n\\ No newline at end of file\n"), [
    { sign: " ", text: "@@ -1 +1 @@" },
    { sign: "-", text: "x" },
    { sign: "+", text: "y", noNewline: true },
  ]);
  assert.deepEqual(wholeFileLines("a\nb", "+"), [{ sign: "+", text: "a" }, { sign: "+", text: "b", noNewline: true }]);
  assert.deepEqual(wholeFileLines("", "-"), []);
});

test("unifiedDiffLines keeps hunk content beginning with two pluses or minuses", () => {
  assert.deepEqual(
    unifiedDiffLines("--- a\n+++ b\n@@ -1 +1 @@\n--- deleted\n+++ added\n"),
    [
      { sign: " ", text: "@@ -1 +1 @@" },
      { sign: "-", text: "-- deleted" },
      { sign: "+", text: "++ added" },
    ],
  );
});


test("a running row shows the last streamed line in its head and the stream in its body (TS.11)", () => {
  const html = renderToStaticMarkup(
    createElement(ToolBlock, {
      id: 3,
      toggled: true,
      onToggle: () => {},
      name: "Shell",
      detail: "yarn test",
      streamed: "compiling\nrunning 12 tests\n",
      output: undefined,
    }),
  );
  assert.match(html, /tool-live-tail[^>]*>running 12 tests/);
  assert.match(html, /tool-output-live/);
  assert.equal(lastLine("a\nb\n\n"), "b");
  assert.equal(lastLine("x".repeat(100)).length, 80);
});
