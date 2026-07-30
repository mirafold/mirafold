import { test } from "node:test";
import assert from "node:assert/strict";
import { nextOpenTurns } from "./turn-busy";

const run = (start: number, types: string[]) =>
  types.reduce((n, t) => nextOpenTurns(n, t), start);

// The straight-line 4.14 guarantee: a queued follow-up keeps the count >0
// across the first turn's boundary — the indicator never blanks between
// queued turns.
test("a queued follow-up keeps at least one turn open across the boundary", () => {
  let n = 0;
  n = nextOpenTurns(n, "user_prompt"); // turn 1
  n = nextOpenTurns(n, "user_prompt"); // queued turn 2
  assert.equal(n, 2);
  n = nextOpenTurns(n, "turn_end"); // turn 1 ends…
  assert.equal(n, 1, "…but the queued turn keeps busy on");
  n = nextOpenTurns(n, "turn_end");
  assert.equal(n, 0);
});

// 2026-07-29 bughunt: the resume path. A disconnect zeroes the counter and
// a tail resume never replays the in-flight turn's user_prompt — without
// the activity floor, the queued follow-up's first turn_end took 1→0 and
// blanked the indicator across the engine roll-in. The missed mid-turn
// frames always arrive replay-stamped, which is what carries the floor.
test("tail resume: REPLAYED activity floors the counter, so a queued prompt survives the first turn_end", () => {
  let n = 0; // disconnect zeroed it; the in-flight turn's prompt won't replay
  n = nextOpenTurns(n, "status", true); // resumed mid-turn activity (replayed)
  assert.equal(n, 1, "replayed activity implies an open turn");
  n = nextOpenTurns(n, "user_prompt"); // the user queues a follow-up
  assert.equal(n, 2);
  n = nextOpenTurns(n, "turn_end"); // the resumed turn ends
  assert.equal(n, 1, "busy stays across the roll-in — the 4.14 gap stays closed");
  n = nextOpenTurns(n, "turn_end");
  assert.equal(n, 0);
});

// The floor must NOT apply to live frames: an engine (the mock's overlay
// above all) can emit a straggler frame after its final turn_end — flooring
// on it would wedge busy on forever, with no turn_end ever coming to close
// the phantom turn (found live in Tier 3, 2026-07-29).
test("a LIVE straggler after the final turn_end cannot re-open a closed turn", () => {
  let n = run(0, ["user_prompt", "status", "turn_end"]);
  assert.equal(n, 0);
  n = nextOpenTurns(n, "text_delta"); // live straggler — no floor
  assert.equal(n, 0, "busy stays off; nothing will ever close a phantom turn");
});

test("the floor never double-counts a normally-opened turn", () => {
  assert.equal(run(0, ["user_prompt", "status", "text_delta", "tool_use"]), 1);
  let n = 0;
  n = nextOpenTurns(n, "user_prompt");
  n = nextOpenTurns(n, "status", true); // replayed activity on an open turn
  assert.equal(n, 1);
  assert.equal(run(0, ["user_prompt", "status", "turn_end"]), 0);
});

test("turn_end never goes negative; unrelated messages change nothing", () => {
  assert.equal(nextOpenTurns(0, "turn_end"), 0);
  assert.equal(nextOpenTurns(3, "render"), 3);
  assert.equal(nextOpenTurns(0, "usage"), 0);
});
