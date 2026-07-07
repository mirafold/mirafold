import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPtyOutput } from "./pty";

test("strips CSI color/style sequences", () => {
  assert.equal(cleanPtyOutput("\x1b[31mred\x1b[0m"), "red");
  assert.equal(cleanPtyOutput("\x1b[1;33;40mx\x1b[m"), "x");
});

test("strips OSC sequences (BEL- and ST-terminated)", () => {
  assert.equal(cleanPtyOutput("\x1b]0;window title\x07done"), "done");
  assert.equal(cleanPtyOutput("\x1b]0;window title\x1b\\done"), "done");
});

test("strips single-char ESC sequences", () => {
  assert.equal(cleanPtyOutput("\x1bMabc"), "abc");
});

test("normalizes CRLF and lone CR to LF", () => {
  assert.equal(cleanPtyOutput("a\r\nb\rc"), "a\nb\nc");
});

test("leaves plain text untouched", () => {
  assert.equal(cleanPtyOutput("hello world"), "hello world");
});
