import { test } from "node:test";
import assert from "node:assert/strict";

import { groupSettledTools, type ActivityItem } from "./tool-visibility";

type Tool = { id: number; batchId: number; settled: boolean; isError?: boolean };
type Think = { id: number };
type Item = ActivityItem<Tool, Think>;

const tool = (id: number, batchId = 10, extra: Partial<Tool> = {}): Item => ({
  kind: "tool",
  tool: { id, batchId, settled: true, ...extra },
});
const think = (id: number): Item => ({ kind: "thinking", thinking: { id } });

const foldIds = (items: ReturnType<typeof groupSettledTools<Tool, Think>>["anchors"] extends Map<number, infer V> ? V : never) =>
  items.map((item) => (item.kind === "tool" ? item.tool.id : item.thinking.id));

test("a completed successful turn becomes one anchor; live and failed calls remain visible", () => {
  const grouped = groupSettledTools([
    tool(1),
    tool(2),
    tool(3, 10, { isError: true }),
    tool(4, 11, { settled: false }),
  ]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.deepEqual([...grouped.hidden], [2]);
  assert.equal(grouped.anchors.has(3), false);
  assert.equal(grouped.hidden.has(3), false);
  assert.equal(grouped.anchors.has(4), false);
});

test("a single settled call keeps its ordinary one-line tool presentation", () => {
  const grouped = groupSettledTools([tool(1)]);
  assert.equal(grouped.anchors.size, 0);
  assert.equal(grouped.hidden.size, 0);
});

test("compaction never moves successful work across a visible failure", () => {
  const grouped = groupSettledTools([tool(1), tool(2, 10, { isError: true }), tool(3)]);
  assert.equal(grouped.anchors.size, 0);
  assert.equal(grouped.hidden.size, 0);
});

test("successful runs compact independently on each side of a chronology boundary", () => {
  const grouped = groupSettledTools([tool(1), tool(2), null, tool(3), tool(4)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.deepEqual(foldIds(grouped.anchors.get(3)!), [3, 4]);
  assert.deepEqual([...grouped.hidden], [2, 4]);
});

test("successful tools from adjacent user turns never compact into one record", () => {
  const grouped = groupSettledTools([tool(1), tool(2), tool(3, 11), tool(4, 11)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.deepEqual(foldIds(grouped.anchors.get(3)!), [3, 4]);
  assert.deepEqual([...grouped.hidden], [2, 4]);
});

test("interior thinking is absorbed into the fold in true transcript order", () => {
  // Codex's cadence: narrate, act, narrate, act. The narration between
  // commands must not break the fold — it rides inside it, in order.
  const grouped = groupSettledTools([tool(1), think(2), tool(3), think(4), tool(5)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2, 3, 4, 5]);
  assert.deepEqual([...grouped.hidden], [2, 3, 4, 5]);
});

test("leading and trailing thinking keep their own visible rows", () => {
  // A turn's opening plan and closing conclusion are not actions.
  const grouped = groupSettledTools([think(1), tool(2), tool(3), think(4)]);
  assert.deepEqual(foldIds(grouped.anchors.get(2)!), [2, 3]);
  assert.deepEqual([...grouped.hidden], [3]);
  assert.equal(grouped.hidden.has(1), false);
  assert.equal(grouped.hidden.has(4), false);
});

test("thinking beside an unfoldable singleton stays visible", () => {
  const grouped = groupSettledTools([tool(1), think(2), tool(3, 10, { isError: true })]);
  assert.equal(grouped.anchors.size, 0);
  assert.equal(grouped.hidden.size, 0);
});

test("thinking at a turn seam belongs to neither fold", () => {
  const grouped = groupSettledTools([tool(1), tool(2), think(3), tool(4, 11), tool(5, 11)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.deepEqual(foldIds(grouped.anchors.get(4)!), [4, 5]);
  assert.equal(grouped.hidden.has(3), false);
});

test("a non-tool boundary discards pending interior thinking from the fold", () => {
  // tool, thinking, TEXT, tool: the text row is a real boundary, so neither
  // side folds and the thinking stays its own row.
  const grouped = groupSettledTools([tool(1), think(2), null, tool(3)]);
  assert.equal(grouped.anchors.size, 0);
  assert.equal(grouped.hidden.size, 0);
});
