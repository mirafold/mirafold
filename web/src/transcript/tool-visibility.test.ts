import { test } from "node:test";
import assert from "node:assert/strict";

import { groupToolActivity, isRoutineSuccess, type ActivityItem, type FoldedActivity } from "./tool-visibility";

type Tool = { id: number; batchId: number; output?: string; isError?: boolean; actions?: unknown[]; exitCode?: number };
type Think = { id: number };
type Item = ActivityItem<Tool, Think>;

const READ = [{ kind: "read", target: "a.ts" }];
/** A finished routine call (a read the engine classified). */
const tool = (id: number, batchId = 10, extra: Partial<Tool> = {}): Item => ({
  kind: "tool",
  tool: { id, batchId, output: "ok", actions: READ, ...extra },
});
/** A finished command of unknown purpose: never grouped. */
const command = (id: number, batchId = 10, extra: Partial<Tool> = {}): Item => ({
  kind: "tool",
  tool: { id, batchId, output: "ok", ...extra },
});
const running = (id: number, batchId = 10): Item => ({
  kind: "tool",
  tool: { id, batchId, output: undefined, actions: READ },
});
const think = (id: number): Item => ({ kind: "thinking", thinking: { id } });

const foldIds = (items: Array<FoldedActivity<Tool, Think>>) =>
  items.map((item) => (item.kind === "tool" ? item.tool.id : item.thinking.id));

test("finished routine calls fold; a failed call and an in-flight call each remain visible", () => {
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

test("R2: only engine-classified routine work groups — an unknown or mixed command is a boundary and its own row", () => {
  const grouped = groupToolActivity([tool(1), tool(2), command(3), tool(4), tool(5)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.deepEqual(foldIds(grouped.anchors.get(4)!), [4, 5]);
  assert.equal(grouped.hidden.has(3), false, "the command stays explicit between two groups");
  assert.equal(isRoutineSuccess({ id: 9, batchId: 1, output: "x" }), false);
  assert.equal(isRoutineSuccess({ id: 9, batchId: 1, output: "x", actions: [] }), false);
});

test("R2/R3: a nonzero exit ends the group and never disappears into it, even when the engine calls it non-error", () => {
  const grouped = groupToolActivity([tool(1), tool(2), tool(3, 10, { exitCode: 1 }), tool(4), tool(5, 10, { exitCode: 0 })]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.equal(grouped.hidden.has(3), false, "grep exit 1 is a visible fact");
  assert.deepEqual(foldIds(grouped.anchors.get(4)!), [4, 5], "exit 0 is ordinary success");
  assert.equal(isRoutineSuccess({ id: 3, batchId: 1, output: "", actions: READ, exitCode: 2 }), false);
});

test("the fold forms live: finished calls fold before the turn settles, the running one is the trailing boundary", () => {
  const grouped = groupToolActivity([tool(1), tool(2), running(3)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.equal(grouped.hidden.has(3), false);
  assert.equal(grouped.anchors.has(3), false);
});

test("a single finished call keeps its ordinary one-line tool presentation", () => {
  const grouped = groupToolActivity([tool(1), command(2, 10, { isError: true })]);
  assert.equal(grouped.anchors.size, 0);
  assert.equal(grouped.hidden.size, 0);
});

test("compaction never moves successful work across a visible failure", () => {
  const grouped = groupToolActivity([tool(1), command(2, 10, { isError: true }), tool(3), tool(4)]);
  assert.deepEqual([...grouped.anchors.keys()], [3]);
  assert.deepEqual([...grouped.hidden], [4]);
});

test("routine runs compact independently on each side of a chronology boundary", () => {
  const grouped = groupToolActivity([tool(1), tool(2), null, tool(3), tool(4)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.deepEqual(foldIds(grouped.anchors.get(3)!), [3, 4]);
});

test("routine calls from adjacent user turns never compact into one record", () => {
  const grouped = groupToolActivity([tool(1, 10), tool(2, 10), tool(3, 11), tool(4, 11)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.deepEqual(foldIds(grouped.anchors.get(3)!), [3, 4]);
});

test("interior thinking is absorbed into the fold in true transcript order", () => {
  const grouped = groupToolActivity([tool(1), think(2), tool(3), think(4), tool(5)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2, 3, 4, 5]);
  assert.deepEqual([...grouped.hidden].sort((a, b) => a - b), [2, 3, 4, 5]);
});

test("leading and trailing thinking keep their own visible rows", () => {
  const grouped = groupToolActivity([think(1), tool(2), tool(3), think(4)]);
  assert.deepEqual(foldIds(grouped.anchors.get(2)!), [2, 3]);
  assert.equal(grouped.hidden.has(1), false);
  assert.equal(grouped.hidden.has(4), false);
});

test("thinking beside an unfoldable singleton stays visible", () => {
  const grouped = groupToolActivity([tool(1), think(2), command(3)]);
  assert.equal(grouped.anchors.size, 0);
  assert.equal(grouped.hidden.size, 0);
});

test("thinking before a running call is not yet interior — it waits for the call to finish", () => {
  const grouped = groupToolActivity([tool(1), think(2), running(3)]);
  assert.equal(grouped.anchors.size, 0);
  assert.equal(grouped.hidden.has(2), false);
  const later = groupToolActivity([tool(1), think(2), tool(3)]);
  assert.deepEqual(foldIds(later.anchors.get(1)!), [1, 2, 3]);
});

test("thinking at a turn seam belongs to neither fold", () => {
  const grouped = groupToolActivity([tool(1, 10), tool(2, 10), think(3), tool(4, 11), tool(5, 11)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.deepEqual(foldIds(grouped.anchors.get(4)!), [4, 5]);
  assert.equal(grouped.hidden.has(3), false);
});

test("a non-tool boundary (a message from either side) discards pending interior thinking from the fold", () => {
  const grouped = groupToolActivity([tool(1), tool(2), think(3), null, tool(4), tool(5)]);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), [1, 2]);
  assert.deepEqual(foldIds(grouped.anchors.get(4)!), [4, 5]);
  assert.equal(grouped.hidden.has(3), false);
});

test("R2: fifty adjacent routine calls form one group; every retained call stays in original order", () => {
  const items: Item[] = [];
  for (let i = 1; i <= 50; i++) items.push(tool(i));
  const grouped = groupToolActivity(items);
  assert.equal(grouped.anchors.size, 1);
  assert.deepEqual(foldIds(grouped.anchors.get(1)!), items.map((_, i) => i + 1));
  assert.equal(grouped.hidden.size, 49);
});
