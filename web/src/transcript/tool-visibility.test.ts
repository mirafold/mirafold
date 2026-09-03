import { test } from "node:test";
import assert from "node:assert/strict";

import { groupToolActivity, type ActivityItem, type FoldedActivity } from "./tool-visibility";

type Tool = { id: number; batchId: number; output?: string; isError?: boolean };
type Think = { id: number };
type Text = { id: number };
type Item = ActivityItem<Tool, Think, Text>;

const tool = (id: number, batchId = 10, extra: Partial<Tool> = {}): Item => ({
  kind: "tool",
  tool: { id, batchId, output: "ok", ...extra },
});
const running = (id: number, batchId = 10): Item => ({
  kind: "tool",
  tool: { id, batchId, output: undefined },
});
const think = (id: number): Item => ({ kind: "thinking", thinking: { id } });
const say = (id: number): Item => ({ kind: "text", text: { id } });

const foldIds = (items: Array<FoldedActivity<Tool, Think, Text>>) =>
  items.map((item) =>
    item.kind === "tool" ? item.tool.id : item.kind === "thinking" ? item.thinking.id : item.text.id,
  );

test("finished successful calls fold; a failed call and an in-flight call each remain visible", () => {
  const grouped = groupToolActivity([
    tool(1),
    tool(2),
    tool(3, 10, { isError: true }),
    running(4),
  ]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.deepEqual([...grouped.hidden], [2]);
  assert.equal(grouped.anchors.has(3), false);
  assert.equal(grouped.hidden.has(3), false);
  assert.equal(grouped.anchors.has(4), false);
  assert.equal(grouped.hidden.has(4), false);
});

test("the fold forms live: finished calls fold before the turn settles, the running one is the trailing boundary", () => {
  // Nothing here is settled — the turn is still running — yet the two
  // finished calls already fold, and the in-flight third stays outside.
  const grouped = groupToolActivity([tool(1), think(2), tool(3), running(4)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2, 3]);
  assert.deepEqual([...grouped.hidden], [2, 3]);
  assert.equal(grouped.hidden.has(4), false);
  // When it finishes, it joins the same anchor — the fold grows in place.
  const grown = groupToolActivity([tool(1), think(2), tool(3), tool(4)]);
  assert.deepEqual(foldIds(grown.anchors.get(1)!), [1, 2, 3, 4]);
});

test("a single finished call keeps its ordinary one-line tool presentation", () => {
  const grouped = groupToolActivity([tool(1)]);
  assert.equal(grouped.anchors.size, 0);
  assert.equal(grouped.hidden.size, 0);
});

test("compaction never moves successful work across a visible failure", () => {
  const grouped = groupToolActivity([tool(1), tool(2, 10, { isError: true }), tool(3)]);
  assert.equal(grouped.anchors.size, 0);
  assert.equal(grouped.hidden.size, 0);
});

test("successful runs compact independently on each side of a chronology boundary", () => {
  const grouped = groupToolActivity([tool(1), tool(2), null, tool(3), tool(4)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.deepEqual(foldIds(grouped.anchors.get(3)!), [3, 4]);
  assert.deepEqual([...grouped.hidden], [2, 4]);
});

test("successful tools from adjacent user turns never compact into one record", () => {
  const grouped = groupToolActivity([tool(1), tool(2), tool(3, 11), tool(4, 11)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.deepEqual(foldIds(grouped.anchors.get(3)!), [3, 4]);
  assert.deepEqual([...grouped.hidden], [2, 4]);
});

test("interior thinking is absorbed into the fold in true transcript order", () => {
  // Codex's cadence: narrate, act, narrate, act. The narration between
  // commands must not break the fold — it rides inside it, in order.
  const grouped = groupToolActivity([tool(1), think(2), tool(3), think(4), tool(5)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2, 3, 4, 5]);
  assert.deepEqual([...grouped.hidden], [2, 3, 4, 5]);
});

test("a short spoken remark between calls is absorbed exactly like thinking", () => {
  // The caller decides what counts as short; here the fold treats a `text`
  // item as interior narration, in order, never as an action.
  const grouped = groupToolActivity([tool(1), say(2), tool(3), think(4), say(5), tool(6)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...grouped.hidden], [2, 3, 4, 5, 6]);
});

test("leading and trailing narration keep their own visible rows", () => {
  // A turn's opening plan and closing conclusion are not actions.
  const grouped = groupToolActivity([think(1), say(2), tool(3), tool(4), think(5), say(6)]);
  assert.deepEqual(foldIds(grouped.anchors.get(3)!), [3, 4]);
  assert.deepEqual([...grouped.hidden], [4]);
});

test("narration beside an unfoldable singleton stays visible", () => {
  const grouped = groupToolActivity([tool(1), think(2), tool(3, 10, { isError: true })]);
  assert.equal(grouped.anchors.size, 0);
  assert.equal(grouped.hidden.size, 0);
});

test("narration before a running call is not yet interior — it waits for the call to finish", () => {
  // Mid-turn: tool, remark, RUNNING tool. The remark shows as its own row
  // until the call finishes and proves it interior.
  const grouped = groupToolActivity([tool(1), tool(2), say(3), running(4)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.equal(grouped.hidden.has(3), false);
});

test("thinking at a turn seam belongs to neither fold", () => {
  const grouped = groupToolActivity([tool(1), tool(2), think(3), tool(4, 11), tool(5, 11)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.deepEqual(foldIds(grouped.anchors.get(4)!), [4, 5]);
  assert.equal(grouped.hidden.has(3), false);
});

test("a non-tool boundary discards pending interior narration from the fold", () => {
  // tool, thinking, PAINTING/long text (null), tool: the row is a real
  // boundary, so neither side folds and the thinking stays its own row.
  const grouped = groupToolActivity([tool(1), think(2), null, tool(3)]);
  assert.equal(grouped.anchors.size, 0);
  assert.equal(grouped.hidden.size, 0);
});
