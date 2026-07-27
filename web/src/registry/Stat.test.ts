import { test } from "node:test";
import assert from "node:assert/strict";
import { deltaMeta } from "./Stat";

test("deltaMeta: the arrow follows direction, the tone follows good — independently", () => {
  // Up isn't always good (latency up) and down isn't always bad (cost down):
  // all four combinations are distinct, legitimate states.
  assert.deepEqual(deltaMeta({ direction: "up", good: true }), { arrow: "↑", tone: "good" });
  assert.deepEqual(deltaMeta({ direction: "up", good: false }), { arrow: "↑", tone: "bad" });
  assert.deepEqual(deltaMeta({ direction: "down", good: true }), { arrow: "↓", tone: "good" });
  assert.deepEqual(deltaMeta({ direction: "down", good: false }), { arrow: "↓", tone: "bad" });
});
