import { test } from "node:test";
import assert from "node:assert/strict";
import {
  niceTicks,
  fmt,
  pieSlices,
  arcPath,
  stackSegments,
  chartDomain,
  showXLabel,
  groupedBarLayout,
} from "./Chart";

test("chartDomain: bars anchor to zero, lines fit the data", () => {
  // A latency band far from zero: the bar domain must include the honest
  // baseline; the line domain must NOT flatten the trend against it.
  assert.deepEqual(chartDomain([200, 210, 205], true), [0, 210]);
  assert.deepEqual(chartDomain([200, 210, 205], false), [200, 210]);
  // Negatives anchor symmetrically for bars, fit for lines.
  assert.deepEqual(chartDomain([-5, -2], true), [-5, 0]);
  assert.deepEqual(chartDomain([-5, -2], false), [-5, -2]);
  // No finite values at all: a degenerate but usable domain, never ±Infinity.
  assert.deepEqual(chartDomain([], false), [0, 0]);
});

test("showXLabel: the forced last label suppresses a stride label it would collide with", () => {
  // 17 labels, stride 3: index 15 is a stride hit one band from the forced
  // 16 — the old `i % stride === 0` clause drew both, overlapping.
  assert.equal(showXLabel(16, 17, 3), true);
  assert.equal(showXLabel(15, 17, 3), false);
  assert.equal(showXLabel(12, 17, 3), true); // a full stride short — keeps
  // Stride 1 (≤8 categories): every label still draws.
  for (let i = 0; i < 5; i++) assert.equal(showXLabel(i, 5, 1), true, `i=${i}`);
});

test("groupedBarLayout: bars plus gaps never exceed the group band", () => {
  // The old Math.max(2, …) floor with a fixed 2px gap overflowed: 6 series
  // needed ≥22 units while a 40-category band offers ~11.5 of group width.
  for (const [band, n] of [
    [16, 6],
    [8, 4],
    [80, 6],
    [640, 1],
  ] as const) {
    const { groupW, barW, gap } = groupedBarLayout(band, n);
    assert.ok(barW > 0);
    assert.ok(
      n * barW + (n - 1) * gap <= groupW + 1e-9,
      `band=${band} n=${n}: group overflows its band`,
    );
  }
  // Roomy case keeps the classic look: 2px gaps, bars well above the floor.
  const roomy = groupedBarLayout(200, 3);
  assert.equal(roomy.gap, 2);
  assert.ok(roomy.barW > 40);
});

test("niceTicks spans the range and the top tick clears the data max", () => {
  // 2026-08-11 test-audit: exact output is deterministic and knowable, so pin
  // it — the old `length>=2 / [0]===0 / last>=100` bounds survived a wrong step
  // count or spacing.
  assert.deepEqual(niceTicks(0, 100), [0, 50, 100]);
});

test("niceTicks tolerates a flat range", () => {
  // A flat range must still yield a usable spread around the value, not a
  // single degenerate tick (the old `length>=1` accepted `[5]`).
  assert.deepEqual(niceTicks(5, 5), [4, 6]);
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

// The axis must scale on what is DRAWN (2026-07-28 fix): marks clip values to
// one per x label, so surplus values may not stretch the domain invisibly.
test("surplus values beyond the x labels do not stretch the axis", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { Chart } = await import("./Chart");
  for (const kind of ["bar", "hbar", "line"] as const) {
    const html = renderToStaticMarkup(
      createElement(Chart as never, {
        kind,
        x: ["only"],
        series: [{ name: "s", values: [1, 1000] }],
      }),
    );
    assert.ok(!html.includes("1k"), `${kind}: the undrawn 1000 must not appear as a tick`);
  }
});

// 2026-07-29 bughunt: the line-chart END LABELS (the ≥2-series CVD-safe
// identifier) were computed from the FULL values array while every mark
// clips to x.length — a surplus value placed a series' label and dot far
// off-canvas (measured y=-71768 in a 260-high viewBox), silently deleting it.
test("line end labels are computed from DRAWN values only", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { Chart } = await import("./Chart");
  const html = renderToStaticMarkup(
    createElement(Chart as never, {
      kind: "line",
      x: ["a", "b"],
      series: [
        { name: "alpha", values: [1, 2, 1000] }, // surplus 1000 is undrawn
        { name: "beta", values: [2, 3] },
      ],
    }),
  );
  assert.ok(html.includes("alpha") && html.includes("beta"), "both end labels render");
  // Every coordinate in the SVG stays inside the 640×260 viewBox — no
  // off-canvas label anchored to an undrawn point.
  const coords = [...html.matchAll(/\s(?:x|y|cx|cy)="(-?\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1]));
  assert.ok(coords.length > 0);
  assert.ok(
    coords.every((c) => c >= -20 && c <= 700),
    `all coordinates on-canvas; saw ${Math.min(...coords)}..${Math.max(...coords)}`,
  );
});
