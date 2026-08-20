import assert from "node:assert/strict";
import test from "node:test";
import {
  adjacentInputIndex,
  inputIndexAtViewport,
  isNavigableInputRow,
} from "./input-navigation";

test("only user-authored command strips become navigation stops", () => {
  assert.equal(isNavigableInputRow({ kind: "text", role: "user" }), true);
  assert.equal(isNavigableInputRow({ kind: "bang" }), true);
  assert.equal(isNavigableInputRow({ kind: "text", role: "assistant" }), false);
  assert.equal(isNavigableInputRow({ kind: "tool" }), false);
  assert.equal(isNavigableInputRow({ kind: "picker" }), false);
});

test("adjacentInputIndex moves chronologically without wrapping", () => {
  assert.equal(adjacentInputIndex(2, 5, "older"), 1);
  assert.equal(adjacentInputIndex(2, 5, "newer"), 3);
  assert.equal(adjacentInputIndex(0, 5, "older"), null);
  assert.equal(adjacentInputIndex(4, 5, "newer"), null);
});

test("adjacentInputIndex refuses empty and stale cursors", () => {
  assert.equal(adjacentInputIndex(0, 0, "older"), null);
  assert.equal(adjacentInputIndex(-1, 3, "newer"), null);
  assert.equal(adjacentInputIndex(3, 3, "older"), null);
  assert.equal(adjacentInputIndex(0.5, 3, "newer"), null);
});

test("inputIndexAtViewport binds response space to its preceding input", () => {
  const tops = [120, 460, 900];
  assert.equal(inputIndexAtViewport(tops, 80), 0);
  assert.equal(inputIndexAtViewport(tops, 120), 0);
  assert.equal(inputIndexAtViewport(tops, 700), 1);
  assert.equal(inputIndexAtViewport(tops, 2_000), 2);
  assert.equal(inputIndexAtViewport([], 700), null);
});
