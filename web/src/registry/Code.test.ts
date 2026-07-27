import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, isValidElement, type ReactElement } from "react";
import { codeFence, highlightedLines, splitNodeLines } from "./Code";

test("codeFence: the fence always outruns any backtick run inside the code", () => {
  assert.equal(codeFence("const a = 1;", "ts"), "```ts\nconst a = 1;\n```");
  // Code containing a triple-backtick fence can't close ours.
  assert.equal(codeFence("```md\ninner\n```"), "````\n```md\ninner\n```\n````");
  // Inline backticks shorter than the fence change nothing.
  assert.equal(codeFence("a `b` c"), "```\na `b` c\n```");
});

test("codeFence: only a plain language token reaches the info string", () => {
  // Spaces/backticks in lang could smuggle content onto the fence line.
  assert.equal(codeFence("x", "ts extra"), "```\nx\n```");
  assert.equal(codeFence("x", "c``"), "```\nx\n```");
  assert.equal(codeFence("x", "c++"), "```c++\nx\n```");
  assert.equal(codeFence("x", "objective-c"), "```objective-c\nx\n```");
});

test("codeFence: CRLF input normalizes so line numbering matches what renders", () => {
  assert.equal(codeFence("a\r\nb\rc"), "```\na\nb\nc\n```");
});

test("highlightedLines: expands inclusive ranges, single lines, and merges", () => {
  assert.deepEqual([...highlightedLines([{ start: 2, end: 4 }, { start: 7 }], 10)], [2, 3, 4, 7]);
  assert.equal(highlightedLines(undefined, 10).size, 0);
});

test("highlightedLines: clamps to the code's own length — a runaway end can't allocate", () => {
  assert.deepEqual([...highlightedLines([{ start: 3, end: 1_000_000_000 }], 4)], [3, 4]);
  assert.deepEqual([...highlightedLines([{ start: 99 }], 4)], []);
  // A reversed range reads as its span, not as empty.
  assert.deepEqual([...highlightedLines([{ start: 3, end: 2 }], 4)], [2, 3]);
});

test("splitNodeLines: plain text splits on newlines; the fence's trailing line drops", () => {
  assert.deepEqual(splitNodeLines("a\nb\n"), [["a"], ["b"]]);
  assert.deepEqual(splitNodeLines(""), [[]]);
});

test("splitNodeLines: a token element spanning a newline is cut into per-line clones", () => {
  // The shape rehype-highlight emits for a block comment: one span whose text
  // crosses the line break.
  const comment = createElement("span", { className: "hljs-comment" }, "/* a\nb */");
  const lines = splitNodeLines(["x", comment, "y"]);
  assert.equal(lines.length, 2);

  const [x, firstHalf] = lines[0] as [string, ReactElement<{ className: string; children: string }>];
  assert.equal(x, "x");
  assert.ok(isValidElement(firstHalf));
  assert.equal(firstHalf.props.className, "hljs-comment");
  assert.equal(firstHalf.props.children, "/* a");

  const [secondHalf, y] = lines[1] as [ReactElement<{ className: string; children: string }>, string];
  assert.equal(secondHalf.props.className, "hljs-comment");
  assert.equal(secondHalf.props.children, "b */");
  assert.equal(y, "y");
});
