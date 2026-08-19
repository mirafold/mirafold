import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines } from "../diff";
import { formatBytes } from "./ToolBlock";

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
