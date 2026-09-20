import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DIFF_LCS_CELL_LIMIT, diffLines, unifiedDiffLines, wholeFileLines } from "../workspace/diff";
import { ToolBlock, changeCounts, formatBytes, formatDuration, lastLine, lastLines } from "./ToolBlock";

test("a malformed MultiEdit input renders instead of throwing (engine data is checked per element)", () => {
  const html = renderToStaticMarkup(
    createElement(ToolBlock, {
      toggleKey: "tool:1",
      expanded: true, // the output zone opens a failed record by default, so the input renders
      onToggle: () => {},
      name: "MultiEdit",
      input: { file_path: "a.ts", edits: [null, 42, { old_string: "a", new_string: "b" }] },
      output: "",
      isError: true,
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
      toggleKey: "tool:2",
      expanded: true,
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


test("a running row previews its last streamed lines while collapsed and shows the stream in its body (TS.11 / TF R3)", () => {
  const base = { toggleKey: "tool:3", onToggle: () => {}, name: "Shell", detail: "yarn test", streamed: "compiling\nrunning 12 tests\n", output: undefined };
  const collapsed = renderToStaticMarkup(createElement(ToolBlock, { ...base, expanded: false }));
  assert.match(collapsed, /tool-preview-live[^>]*>compiling\nrunning 12 tests</);
  assert.match(collapsed, /tool-state[^>]*>running</);
  const html = renderToStaticMarkup(createElement(ToolBlock, { ...base, expanded: true }));
  assert.match(html, /tool-output-live/);
  assert.equal(lastLine("a\nb\n\n"), "b");
  assert.equal(lastLine("x".repeat(100)).length, 80);
});

test("apply_patch path labels make direction controls visible", () => {
  const html = renderToStaticMarkup(
    createElement(ToolBlock, {
      toggleKey: "tool:1",
      expanded: true,
      onToggle: () => {},
      name: "apply_patch",
      input: {
        changes: [
          { path: "a\u202egnp.sh", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" },
          { path: "x", kind: "add", diff: "hi", movePath: "y\u200bz" },
        ],
      },
    }),
  );
  assert.ok(html.includes("‹U+202E›"));
  assert.ok(!html.includes("\u202e"));
  assert.ok(html.includes("‹U+200B›"));
});

test("the tool row's name makes engine-chosen controls visible", () => {
  const html = renderToStaticMarkup(
    createElement(ToolBlock, {
      toggleKey: "tool:1",
      expanded: false,
      onToggle: () => {},
      name: "crm\u202e.lookup\u{e0041}",
      output: "ok",
    }),
  );
  assert.ok(html.includes("‹U+202E›") && html.includes("‹U+E0041›"));
  assert.ok(!html.includes("\u202e"));
});

test("a one-sided middle takes the linear path and keeps the exact answer (PR #80 review)", () => {
  const removed = Array.from({ length: 200_000 }, (_, i) => `line-${i}`).join("\n");
  const lines = diffLines(`keep\n${removed}\nkeep2\n`, "keep\nkeep2\n");
  assert.equal(lines.length, 200_002);
  assert.deepEqual(lines[0], { sign: " ", text: "keep" });
  assert.equal(lines.filter((l) => l.sign === "-").length, 200_000);
  assert.deepEqual(lines.at(-1), { sign: " ", text: "keep2" });
});

test("R3: a settled command row carries exit code and duration as facts and a bounded preview of its last lines", () => {
  const html = renderToStaticMarkup(
    createElement(ToolBlock, {
      toggleKey: "tool:x",
      expanded: false,
      onToggle: () => {},
      name: "Bash",
      detail: "yarn test",
      output: "line 1\nline 2\n\nline 3\nline 4\nFAIL: 2 tests failed",
      exitCode: 1,
      durationMs: 3200,
    }),
  );
  assert.match(html, /tool-exit[^>]*>exit 1</);
  assert.match(html, /tool-duration[^>]*>3\.2s</);
  assert.match(html, /tool-preview/);
  assert.ok(html.includes("line 3\nline 4\nFAIL: 2 tests failed"), "the last three non-empty lines");
  assert.ok(!html.includes("line 2"), "the preview is bounded");
  assert.ok(!html.includes("is-error"), "a nonzero exit alone is a neutral fact, not error styling");
  // A routine read previews nothing: its row is the fact.
  const read = renderToStaticMarkup(
    createElement(ToolBlock, { toggleKey: "tool:r", expanded: false, onToggle: () => {}, name: "Read", detail: "a.ts", output: "content\nmore", actions: [{ kind: "read", target: "a.ts" }] }),
  );
  assert.ok(!read.includes("tool-preview"));
  assert.ok(!read.includes("tool-exit"));
});

test("R7: the expansion shows the retained head, an explicit omission notice, and the tail", () => {
  const html = renderToStaticMarkup(
    createElement(ToolBlock, {
      toggleKey: "tool:x",
      expanded: true,
      onToggle: () => {},
      name: "Bash",
      output: "HEAD",
      tail: "TAIL",
      omittedBytes: 4096,
      truncatedBytes: 5000,
    }),
  );
  assert.match(html, /HEAD[\s\S]*4\.0 KB omitted between head and tail[\s\S]*TAIL/);
  const legacy = renderToStaticMarkup(
    createElement(ToolBlock, { toggleKey: "tool:y", expanded: true, onToggle: () => {}, name: "Bash", output: "HEAD", truncatedBytes: 2048 }),
  );
  assert.match(legacy, /2\.0 KB elided/);
  const nothing = renderToStaticMarkup(
    createElement(ToolBlock, { toggleKey: "tool:z", expanded: true, onToggle: () => {}, name: "Bash", output: "", omittedBytes: 77 }),
  );
  assert.match(nothing, /77 B not retained/);
  assert.ok(!nothing.includes("(no output)"), "a zero-budget result is not 'no output'");
});

test("R3/R8: a running row says what silence means — no output yet, or live output unavailable for this agent", () => {
  const base = { toggleKey: "tool:x", expanded: true, onToggle: () => {}, name: "run_shell_command", detail: "ls" };
  assert.match(renderToStaticMarkup(createElement(ToolBlock, base)), /no output received yet/);
  assert.match(renderToStaticMarkup(createElement(ToolBlock, { ...base, liveOutputAvailable: false })), /live output unavailable for this agent/);
  const live = renderToStaticMarkup(
    createElement(ToolBlock, { ...base, live: { head: "first", tail: "last", omittedBytes: 10, revision: 3 } }),
  );
  assert.match(live, /first[\s\S]*10 B omitted between head and tail[\s\S]*last/);
  assert.match(renderToStaticMarkup(createElement(ToolBlock, { ...base, elapsedMs: 2500, expanded: false })), /running · 2\.5s/);
});

test("edit rows show change counts computed from their own input", () => {
  assert.deepEqual(changeCounts("Edit", { old_string: "a\nb", new_string: "a\nB\nc" }), { added: 2, removed: 1 });
  assert.equal(changeCounts("Write", { content: "x\ny\nz" }), undefined, "without old contents, written lines are not known additions");
  assert.deepEqual(changeCounts("apply_patch", { changes: [{ kind: "update", diff: "@@ -1 +1 @@\n-alpha\n+beta\n+gamma\n" }] }), { added: 2, removed: 1 });
  assert.equal(changeCounts("Bash", { command: "ls" }), undefined);
  assert.equal(changeCounts("Edit", { old_string: "x".repeat(300_000), new_string: "" }), undefined, "an oversized input is not counted");
  // PR #120 review: the bound is on the AGGREGATE — many individually small
  // edits or patches must not run the diff each render.
  const manyEdits = Array.from({ length: 4 }, () => ({ old_string: "x".repeat(60_000), new_string: "y".repeat(60_000) }));
  assert.equal(changeCounts("MultiEdit", { edits: manyEdits }), undefined);
  assert.equal(changeCounts("MultiEdit", { edits: Array.from({ length: 201 }, () => ({ old_string: "a", new_string: "b" })) }), undefined);
  assert.equal(changeCounts("apply_patch", { changes: Array.from({ length: 5 }, () => ({ kind: "update", diff: "+" + "z".repeat(50_000) })) }), undefined);
  const html = renderToStaticMarkup(
    createElement(ToolBlock, { toggleKey: "tool:e", expanded: false, onToggle: () => {}, name: "Edit", detail: "a.ts", input: { file_path: "a.ts", old_string: "a", new_string: "b\nc" }, output: "ok" }),
  );
  assert.match(html, /tool-change-add[^>]*>\+2</);
  assert.match(html, /tool-change-del[^>]*>−1</);
});

test("lastLines keeps the newest non-empty lines, each capped", () => {
  assert.equal(lastLines("a\n\nb\nc\nd\n", 3), "b\nc\nd");
  assert.equal(lastLines("", 3), "");
  const long = "x".repeat(300);
  assert.equal(lastLines(long, 1).length, 200);
  assert.equal(formatDuration(999), "999 ms");
  assert.equal(formatDuration(65_500), "1m 6s");
  assert.equal(formatDuration(119_600), "2m 0s", "a remainder that rounds to 60 carries (round 3)");
});
