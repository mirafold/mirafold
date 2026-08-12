import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closestHunk,
  formatReviewDraft,
  languageForPath,
  reviewHunks,
  reviewLines,
  reviewSelection,
} from "./change-review";

test("reviewLines: stable HEAD/current line numbers survive additions and deletions", () => {
  assert.deepEqual(reviewLines("one\ntwo\nthree", "one\nTWO\nthree\nfour"), [
    { id: " :1:1", index: 0, oldLine: 1, newLine: 1, sign: " ", text: "one" },
    { id: "-:2:", index: 1, oldLine: 2, newLine: undefined, sign: "-", text: "two" },
    { id: "+::2", index: 2, oldLine: undefined, newLine: 2, sign: "+", text: "TWO" },
    { id: " :3:3", index: 3, oldLine: 3, newLine: 3, sign: " ", text: "three" },
    { id: "+::4", index: 4, oldLine: undefined, newLine: 4, sign: "+", text: "four" },
  ]);
});

test("reviewHunks: nearby edits group, distant edits navigate independently", () => {
  const before = Array.from({ length: 20 }, (_, index) => `old ${index + 1}`).join("\n");
  const afterLines = before.split("\n");
  afterLines[1] = "new 2";
  afterLines[4] = "new 5";
  afterLines[18] = "new 19";
  const lines = reviewLines(before, afterLines.join("\n"));
  const hunks = reviewHunks(lines);
  assert.equal(hunks.length, 2);
  assert.equal(closestHunk(hunks, hunks[0].end + 1), 0);
  assert.equal(closestHunk(hunks, hunks[1].start), 1);
});

test("reviewSelection: clamps safely in either direction and reports the cap", () => {
  assert.deepEqual(reviewSelection(2, 9, 20, 4), {
    anchor: 2,
    focus: 5,
    start: 2,
    end: 5,
    clamped: true,
  });
  assert.deepEqual(reviewSelection(9, 1, 20, 3), {
    anchor: 9,
    focus: 7,
    start: 7,
    end: 9,
    clamped: true,
  });
  assert.equal(reviewSelection(0, 1, 0), undefined);
});

test("formatReviewDraft: path, dual source ranges, and exact diff snippet stay visible", () => {
  const lines = reviewLines("before\nkeep", "after\nkeep").slice(0, 2);
  assert.equal(
    formatReviewDraft("explain", "src/a`b.ts", lines),
    [
      "Explain the selected workspace change.",
      'File: "src/a`b.ts"',
      "Range: HEAD line 1; working tree line 1",
      "",
      "Selected diff:",
      "```diff",
      "- before",
      "+ after",
      "```",
    ].join("\n"),
  );
});

test("languageForPath: uses the shipped highlighter's language names", () => {
  assert.equal(languageForPath("web/App.tsx"), "typescript");
  assert.equal(languageForPath("scripts/run.sh"), "bash");
  assert.equal(languageForPath("Dockerfile"), "dockerfile");
  assert.equal(languageForPath("LICENSE"), undefined);
});
