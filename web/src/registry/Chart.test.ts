import { test } from "node:test";
import assert from "node:assert/strict";
import { niceTicks, fmt, pieSlices, arcPath, stackSegments } from "./Chart";

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

test("pieSlices: ≤6 slices pass through (size-ordered), fractions sum to 1", () => {
  const s = pieSlices(["a", "b", "c"], [1, 3, 2]);
  assert.deepEqual(
    s.map((e) => e.label),
    ["b", "c", "a"],
  );
  assert.ok(Math.abs(s.reduce((sum, e) => sum + e.frac, 0) - 1) < 1e-9);
});

test("pieSlices: past 6, the tail folds into ONE 'other' — never a 7th hue", () => {
  const labels = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const s = pieSlices(labels, [80, 40, 20, 10, 5, 3, 2, 1]);
  assert.equal(s.length, 6);
  assert.equal(s[5].label, "other");
  assert.equal(s[5].value, 3 + 2 + 1); // the top 5 keep their slots; f+g+h fold
  // Exactly 6 real slices: no fold, all six kept.
  assert.equal(pieSlices(labels.slice(0, 6), [6, 5, 4, 3, 2, 1]).length, 6);
});

test("pieSlices: non-finite and non-positive values have no pie geometry — dropped", () => {
  const s = pieSlices(["a", "b", "c", "d"], [5, -2, NaN, 0]);
  assert.deepEqual(
    s.map((e) => e.label),
    ["a"],
  );
  assert.equal(s[0].frac, 1);
});

test("arcPath: well-formed arcs, and a full-circle slice never degenerates", () => {
  const half = arcPath(100, 100, 90, 50, 0, Math.PI);
  assert.match(half, /^M[\d.,-]+ A90,90 0 0 1 /);
  assert.ok(!half.includes("NaN"));
  // frac=1 (a single slice): start==end mod 2π would draw nothing — the
  // clamp keeps it a visible, valid ring.
  const full = arcPath(100, 100, 90, 50, 0, 2 * Math.PI);
  assert.ok(!full.includes("NaN"));
  assert.match(full, / A90,90 0 1 1 /); // large-arc flag set: it swept past π
});

test("stackSegments: cumulative spans in series order; negatives don't stack", () => {
  const cols = stackSegments(
    [{ values: [3, 1] }, { values: [-5, 2] }, { values: [4, NaN] }],
    2,
  );
  assert.deepEqual(cols[0], [
    { si: 0, v: 3, lo: 0, hi: 3 },
    { si: 2, v: 4, lo: 3, hi: 7 }, // the negative series is skipped, slot kept
  ]);
  assert.deepEqual(cols[1], [
    { si: 0, v: 1, lo: 0, hi: 1 },
    { si: 1, v: 2, lo: 1, hi: 3 },
  ]);
});
