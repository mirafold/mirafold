import { test } from "node:test";
import assert from "node:assert/strict";
import { touchIntentReachesBottom, wheelIntentReachesBottom } from "./use-follow-tail";

const box = {
  scrollHeight: 1_000,
  scrollTop: 776,
  clientHeight: 100,
}; // 124px from the tail; the shared slack is 24px.

test("downward wheel intent arms against the pre-scroll bottom boundary", () => {
  assert.equal(wheelIntentReachesBottom(box, { deltaY: 99 }), false);
  assert.equal(wheelIntentReachesBottom(box, { deltaY: 100 }), true);
  assert.equal(wheelIntentReachesBottom(box, { deltaY: -1_000 }), false);
});

test("wheel line/page modes are converted before the reach decision", () => {
  assert.equal(wheelIntentReachesBottom(box, { deltaY: 6, deltaMode: 1 }), false);
  assert.equal(wheelIntentReachesBottom(box, { deltaY: 7, deltaMode: 1 }), true);
  assert.equal(wheelIntentReachesBottom(box, { deltaY: 1, deltaMode: 2 }), true);
});

test("an upward finger gesture arms only when it reaches the tail", () => {
  assert.equal(touchIntentReachesBottom(box, 300, 201), false);
  assert.equal(touchIntentReachesBottom(box, 300, 200), true);
  assert.equal(touchIntentReachesBottom(box, 200, 300), false);
});
