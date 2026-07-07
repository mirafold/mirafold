import { test } from "node:test";
import assert from "node:assert/strict";
import { niceTicks, fmt } from "./Chart";

test("niceTicks spans the range and the top tick clears the data max", () => {
  const ticks = niceTicks(0, 100);
  assert.ok(ticks.length >= 2);
  assert.equal(ticks[0], 0);
  assert.ok(ticks[ticks.length - 1] >= 100);
});

test("niceTicks tolerates a flat range", () => {
  assert.ok(niceTicks(5, 5).length >= 1);
});

test("fmt abbreviates magnitudes", () => {
  assert.equal(fmt(42), "42");
  assert.equal(fmt(1500), "1.5k");
  assert.equal(fmt(2_000_000), "2M");
});
