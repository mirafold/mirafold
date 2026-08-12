import { test } from "node:test";
import assert from "node:assert/strict";
import {
  closestHunk,
  formatReviewDraft,
  interactiveReviewTooLarge,
  languageForPath,
  MAX_INTERACTIVE_REVIEW_LINES,
  reviewHunks,
  reviewLines,
  reviewSelection,
  reviewScrollBehavior,
} from "./change-review";

test("reviewLines: stable HEAD/current line numbers survive additions and deletions", () => {
  assert.deepEqual(reviewLines("one\ntwo\nthree", "one\nTWO\nthree\nfour"), [
    { id: " :1:1", index: 0, oldLine: 1, newLine: 1, sign: " ", text: "one" },
    { id: "-:2:", index: 1, oldLine: 2, newLine: undefined, sign: "-", text: "two" },
    { id: "+::2", index: 2, oldLine: undefined, newLine: 2, sign: "+", text: "TWO" },
    { id: " :3:3", index: 3, oldLine: 3, newLine: 3, sign: " ", text: "three" },
    {
      id: "+::4",
      index: 4,
      oldLine: undefined,
      newLine: 4,
      sign: "+",
      text: "four",
      noNewline: true,
    },
  ]);
});

test("reviewLines: terminal newline changes replace the real final line, never invent a blank line", () => {
  assert.deepEqual(reviewLines("a\n", "a"), [
    { id: "-:1:", index: 0, oldLine: 1, newLine: undefined, sign: "-", text: "a" },
    {
      id: "+::1",
      index: 1,
      oldLine: undefined,
      newLine: 1,
      sign: "+",
      text: "a",
      noNewline: true,
    },
  ]);
  assert.deepEqual(reviewLines("", "x\n"), [
    { id: "+::1", index: 0, oldLine: undefined, newLine: 1, sign: "+", text: "x" },
  ]);
  assert.doesNotMatch(
    formatReviewDraft("explain", "a.txt", reviewLines("a\n", "a")),
    /HEAD line 2|working tree line 2/,
  );
  assert.match(
    formatReviewDraft("explain", "a.txt", reviewLines("a\n", "a")),
    /\\ No newline at end of file/,
  );
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

test("interactiveReviewTooLarge: caps linear added/deleted diffs before row rendering", () => {
  const manyLines = Array.from(
    { length: MAX_INTERACTIVE_REVIEW_LINES + 1 },
    (_, index) => `line ${index}`,
  ).join("\n");
  assert.equal(interactiveReviewTooLarge("", manyLines), true);
  assert.equal(interactiveReviewTooLarge("", "one\ntwo"), false);
});

test("reviewScrollBehavior: reduced motion turns hunk jumps into immediate scrolling", () => {
  assert.equal(reviewScrollBehavior(true), "auto");
  assert.equal(reviewScrollBehavior(false), "smooth");
});
