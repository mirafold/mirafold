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
    { sign: "-", text: "" },
    { sign: "+", text: "x" },
  ]);
});

test("formatBytes scales units", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});
