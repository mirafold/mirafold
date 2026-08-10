import { test } from "node:test";
import assert from "node:assert/strict";

import { groupSettledTools } from "./tool-visibility";

test("a completed successful turn becomes one anchor; live and failed calls remain visible", () => {
  const tools = [
    { id: 1, batchId: 10, settled: true },
    { id: 2, batchId: 10, settled: true },
    { id: 3, batchId: 10, settled: true, isError: true },
    { id: 4, batchId: 11, settled: false },
  ];
  const grouped = groupSettledTools(tools);
  assert.deepEqual(grouped.anchors.get(1)?.map((tool) => tool.id), [1, 2]);
  assert.deepEqual([...grouped.hidden], [2]);
  assert.equal(grouped.anchors.has(3), false);
  assert.equal(grouped.hidden.has(3), false);
  assert.equal(grouped.anchors.has(4), false);
});

test("a single settled call keeps its ordinary one-line tool presentation", () => {
  const grouped = groupSettledTools([{ id: 1, batchId: 10, settled: true }]);
  assert.equal(grouped.anchors.size, 0);
  assert.equal(grouped.hidden.size, 0);
});
