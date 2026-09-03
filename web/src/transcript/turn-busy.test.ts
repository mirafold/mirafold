import { test } from "node:test";
import assert from "node:assert/strict";
import type { ZoneMsg } from "../transport/session-bus";
import { nextTurnBalance, type TurnBalance } from "./turn-busy";

const start = (openTurns = 0): TurnBalance => ({ openTurns, errorAwaitingTurnEnd: false });
const run = (openTurns: number, types: ZoneMsg["type"][]) =>
  types.reduce((state, type) => nextTurnBalance(state, type), start(openTurns));

// The straight-line 4.14 guarantee: a queued follow-up keeps the count >0
// across the first turn's boundary — the indicator never blanks between
// queued turns.
test("a queued follow-up keeps at least one turn open across the boundary", () => {
  let state = start();
  state = nextTurnBalance(state, "user_prompt"); // turn 1
  state = nextTurnBalance(state, "user_prompt"); // queued turn 2
  assert.equal(state.openTurns, 2);
  state = nextTurnBalance(state, "turn_end"); // turn 1 ends…
  assert.equal(state.openTurns, 1, "…but the queued turn keeps busy on");
  state = nextTurnBalance(state, "turn_end");
  assert.equal(state.openTurns, 0);
});

// 2026-07-29 bughunt: the resume path. A disconnect zeroes the counter and
// a tail resume never replays the in-flight turn's user_prompt — without
// the activity floor, the queued follow-up's first turn_end took 1→0 and
// blanked the indicator across the engine roll-in. The missed mid-turn
// frames always arrive replay-stamped, which is what carries the floor.
test("tail resume: REPLAYED activity floors the counter, so a queued prompt survives the first turn_end", () => {
  let state = start(); // disconnect zeroed it; the in-flight turn's prompt won't replay
  state = nextTurnBalance(state, "status", true); // resumed mid-turn activity (replayed)
  assert.equal(state.openTurns, 1, "replayed activity implies an open turn");
  state = nextTurnBalance(state, "user_prompt"); // the user queues a follow-up
  assert.equal(state.openTurns, 2);
  state = nextTurnBalance(state, "turn_end"); // the resumed turn ends
  assert.equal(state.openTurns, 1, "busy stays across the roll-in — the 4.14 gap stays closed");
  state = nextTurnBalance(state, "turn_end");
  assert.equal(state.openTurns, 0);
});

// The floor must NOT apply to live frames: an engine (the mock's overlay
// above all) can emit a straggler frame after its final turn_end — flooring
// on it would wedge busy on forever, with no turn_end ever coming to close
// the phantom turn (found live in Tier 3, 2026-07-29).
test("a LIVE straggler after the final turn_end cannot re-open a closed turn", () => {
  let state = run(0, ["user_prompt", "status", "turn_end"]);
  assert.equal(state.openTurns, 0);
  state = nextTurnBalance(state, "text_delta"); // live straggler — no floor
  assert.equal(state.openTurns, 0, "busy stays off; nothing will ever close a phantom turn");
});

test("the floor never double-counts a normally-opened turn", () => {
  assert.equal(run(0, ["user_prompt", "status", "text_delta", "tool_use"]).openTurns, 1);
  let state = start();
  state = nextTurnBalance(state, "user_prompt");
  state = nextTurnBalance(state, "status", true); // replayed activity on an open turn
  assert.equal(state.openTurns, 1);
  assert.equal(run(0, ["user_prompt", "status", "turn_end"]).openTurns, 0);
});

test("turn_end never goes negative; unrelated messages change nothing", () => {
  assert.equal(nextTurnBalance(start(), "turn_end").openTurns, 0);
  assert.equal(nextTurnBalance(start(3), "render").openTurns, 3);
  assert.equal(nextTurnBalance(start(), "usage").openTurns, 0);
});

// 2026-07-30: `error` is terminal for a turn, exactly as it is for the daemon
// (`registry.ts`: turn_end || error → idle + burst gate cleared). Found by a
// Tier-3 wedge whose trace showed 21 user_prompt frames against 20 turn_end:
// one turn had ended by error, the count never came down, and the indicator
// read "working…" with no way back — a reload replays the same imbalance.
test("an error closes the turn it ends — the indicator can come down", () => {
  let state = run(0, ["user_prompt", "status", "text_delta"]);
  assert.equal(state.openTurns, 1, "the turn is open");
  state = nextTurnBalance(state, "error");
  assert.equal(state.openTurns, 0, "an errored turn is a closed turn");
});

test("a request-scoped error does not close an unrelated model turn", () => {
  const state = nextTurnBalance(start(1), "error", false, false);
  assert.equal(state.openTurns, 1);
  assert.equal(state.errorAwaitingTurnEnd, false);
});

test("error then turn_end (the adapters that emit both) never goes negative", () => {
  // The Gemini adapter surfaces a failed turn as status → error → turn_end.
  assert.equal(run(0, ["user_prompt", "error", "turn_end"]).openTurns, 0);
  assert.equal(
    nextTurnBalance(start(), "error").openTurns,
    0,
    "an error with nothing open changes nothing",
  );
});

test("a new prompt clears an unpaired error marker before its own turn_end", () => {
  let state = run(0, ["user_prompt", "error"]);
  assert.equal(state.errorAwaitingTurnEnd, true);
  state = nextTurnBalance(state, "user_prompt");
  assert.equal(state.errorAwaitingTurnEnd, false);
  state = nextTurnBalance(state, "turn_end");
  assert.equal(state.openTurns, 0, "the new turn closes without leaving a phantom count");
});

test("a queued turn survives another turn's error", () => {
  let state = run(0, ["user_prompt", "user_prompt"]);
  assert.equal(state.openTurns, 2);
  state = nextTurnBalance(state, "error");
  assert.equal(state.openTurns, 1, "the still-running turn keeps the indicator up");
  state = nextTurnBalance(state, "turn_end");
  assert.equal(state.openTurns, 1, "the error's paired end cannot close the queued turn");
  assert.equal(state.errorAwaitingTurnEnd, false);
});

// The wedge itself, as a sequence: this is the exact shape the Tier-3 trace
// caught — an unterminated turn followed by a normal one — and the assertion
// is that the shell ends up idle rather than stuck.
test("a turn that ends by error does not wedge the counter for the next turn", () => {
  let state = run(0, ["user_prompt", "status", "error", "turn_end"]); // turn 1 dies
  state = ["user_prompt", "status", "text_delta", "turn_end"].reduce(
    (current, type) => nextTurnBalance(current, type as ZoneMsg["type"]),
    state,
  );
  assert.equal(state.openTurns, 0, "no phantom turn left counting");
});
