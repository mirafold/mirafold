import { test } from "node:test";
import assert from "node:assert/strict";
import { convertMermaidCharts, xychartToChart } from "./mermaid-chart";

// V.2: the mermaid xychart → chart-component conversion, pinned on the exact
// fence shapes gpt-5.6-sol emitted in the live probes, plus the fail-open
// boundary — anything not fully parseable must come back as verbatim text.

// The fence observed live 2026-07-18 (bar, quoted title, y-axis with range).
const LIVE_BAR = `xychart-beta
    title "Monthly Revenue"
    x-axis ["Jan", "Feb", "Mar", "Apr", "May", "Jun"]
    y-axis "Revenue" 0 --> 30
    bar [10, 15, 12, 20, 18, 25]`;

test("live bar fence parses: title, x labels, yLabel-named single series", () => {
  const c = xychartToChart(LIVE_BAR);
  assert.ok(c);
  assert.equal(c.kind, "bar");
  assert.equal(c.title, "Monthly Revenue");
  assert.equal(c.yLabel, "Revenue");
  assert.deepEqual(c.x, ["Jan", "Feb", "Mar", "Apr", "May", "Jun"]);
  assert.deepEqual(c.series, [{ name: "Revenue", values: [10, 15, 12, 20, 18, 25] }]);
});

test("duplicate line+bar of the same values collapses to one series (observed live)", () => {
  const c = xychartToChart(`xychart-beta
    x-axis [a, b, c]
    line [1, 2, 3]
    bar [1, 2, 3]`);
  assert.ok(c);
  assert.equal(c.kind, "line"); // first directive wins
  assert.equal(c.series.length, 1);
});

test("two distinct series keep both, named Series N", () => {
  const c = xychartToChart(`xychart
    x-axis ["Q1", "Q2"]
    bar [5, 6]
    bar [7, 8]`);
  assert.ok(c);
  assert.deepEqual(
    c.series.map((s) => s.name),
    ["Series 1", "Series 2"],
  );
});

test("fail-open: numeric-range x-axis, length mismatch, junk values, no series", () => {
  assert.equal(xychartToChart(`xychart-beta\nx-axis 0 --> 10\nbar [1, 2]`), undefined);
  assert.equal(xychartToChart(`xychart-beta\nx-axis [a, b]\nbar [1, 2, 3]`), undefined);
  assert.equal(xychartToChart(`xychart-beta\nx-axis [a, b]\nbar [1, oops]`), undefined);
  assert.equal(xychartToChart(`xychart-beta\nx-axis [a, b]\ntitle "empty"`), undefined);
  assert.equal(xychartToChart(`flowchart TD\nA-->B`), undefined);
});

test("convertMermaidCharts: chart fence becomes a chart between text runs", () => {
  const segs = convertMermaidCharts(`before\n\n\`\`\`mermaid\n${LIVE_BAR}\n\`\`\`\n\nafter`);
  assert.equal(segs.length, 3);
  assert.deepEqual("text" in segs[0] && segs[0].text.trim(), "before");
  assert.ok("chart" in segs[1]);
  assert.deepEqual("text" in segs[2] && segs[2].text.trim(), "after");
});

test("convertMermaidCharts: unparseable mermaid and plain text pass through verbatim", () => {
  const flow = "look:\n```mermaid\nflowchart TD\nA-->B\n```\ndone";
  assert.deepEqual(convertMermaidCharts(flow), [{ text: flow }]);
  assert.deepEqual(convertMermaidCharts("no fences at all"), [{ text: "no fences at all" }]);
});

// 2026-07-29 bughunt: quoted labels containing commas were split on those
// commas — usually silently defeating the backstop (count mismatch → code
// block), and painting a WRONG chart when the mangled count happened to
// match the series length.

test("commas inside quoted labels are content, not separators", () => {
  const chart = xychartToChart('xychart-beta\nx-axis ["Jan, 2026", Feb]\nbar [1, 2]');
  assert.ok(chart, "the two-label axis parses");
  assert.deepEqual(chart!.x, ["Jan, 2026", "Feb"]);
  assert.deepEqual(chart!.series[0].values, [1, 2]);
});

test("a comma-bearing label can no longer masquerade as two categories", () => {
  // Old behavior: ["\"Jan", "2026\""] — one label mangled into two, painted.
  const chart = xychartToChart('xychart-beta\nx-axis ["Jan, 2026"]\nbar [1, 2]');
  assert.equal(chart, undefined, "a real length mismatch fails open to a code block");
});
