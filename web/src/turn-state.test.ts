import { test } from "node:test";
import assert from "node:assert/strict";
import type { ZoneMsg } from "./session-bus";
import { IDLE_TURN, reduceTurn, type TurnState } from "./turn-state";

const play = (msgs: ZoneMsg[], start: TurnState = IDLE_TURN) =>
  msgs.reduce(
    (acc, msg) => {
      const r = reduceTurn(acc.state, { kind: "message", msg });
      return { state: r.state, said: [...acc.said, ...r.announcements.map((a) => a.text)] };
    },
    { state: start, said: [] as string[] },
  );

test("a queued follow-up keeps busy on across the first turn's boundary", () => {
  const { state } = play([
    { type: "user_prompt", text: "one" },
    { type: "status", state: "thinking" },
    { type: "user_prompt", text: "two" },
    { type: "turn_end" },
  ]);
  assert.equal(state.busy, true);
  assert.equal(state.openTurns, 1);
});

test("an errored turn brings the indicator down and is announced assertively", () => {
  const r = reduceTurn(play([{ type: "user_prompt", text: "x" }]).state, {
    kind: "message",
    msg: { type: "error", message: "engine died" },
  });
  assert.equal(r.state.busy, false);
  assert.equal(r.state.activity, null);
  assert.deepEqual(r.announcements, [{ text: "engine died", assertive: true }]);
});

test("replayed frames repaint state but announce nothing; the turn-end response is spoken once, live", () => {
  const replayed = play([
    { type: "user_prompt", text: "x", replay: true },
    { type: "text_delta", text: "hello", replay: true },
    { type: "permission_request", tool: "Bash", detail: "ls", id: "p1", replay: true },
  ]);
  assert.deepEqual(replayed.said, []);
  assert.equal(replayed.state.asks.length, 1, "a replayed ask may be genuinely pending");
  const live = play([
    { type: "user_prompt", text: "x" },
    { type: "text_delta", text: "hello **there**" },
    { type: "turn_end" },
  ]);
  assert.deepEqual(live.said, ["Sent. Working…", "hello there"]);
  assert.equal(live.state.turnText, "");
});

test("subagent traffic proves busy but never steers the label or the spoken response", () => {
  const { state, said } = play([
    { type: "user_prompt", text: "x" },
    { type: "tool_use", name: "Task", id: "t1" },
    { type: "tool_use", name: "Read", id: "t2", parentId: "t1" },
    { type: "text_delta", text: "child prose", parentId: "t1" },
    { type: "tool_result", output: "", id: "t2", parentId: "t1" },
  ]);
  assert.deepEqual(state.activity, { state: "tool", label: "Task" });
  assert.equal(state.turnText, "");
  assert.deepEqual(said, ["Sent. Working…", "Running Task.", "Running Read."]);
});

test("an ask answered here stays quiet on its wire resolution; one answered elsewhere is announced", () => {
  const asked = play([{ type: "permission_request", tool: "Bash", detail: "rm", id: "p1" }]).state;
  const here = reduceTurn(asked, { kind: "answered", id: "p1" }).state;
  assert.deepEqual(here.asks, []);
  const echo = reduceTurn(here, { kind: "message", msg: { type: "permission_resolved", id: "p1", allow: true } });
  assert.deepEqual(echo.announcements, []);
  const elsewhere = reduceTurn(asked, { kind: "message", msg: { type: "permission_resolved", id: "p1", allow: false } });
  assert.deepEqual(elsewhere.announcements, [{ text: "Permission denied." }]);
  assert.deepEqual(elsewhere.state.asks, []);
});

test("disconnect zeroes the turn; interrupt leaves exactly one turn_end owed; zone_reset restarts", () => {
  const two = play([{ type: "user_prompt", text: "a" }, { type: "user_prompt", text: "b" }]).state;
  assert.equal(reduceTurn(two, { kind: "interrupt" }).state.openTurns, 1);
  const dropped = reduceTurn(two, { kind: "disconnected" }).state;
  assert.equal(dropped.busy, false);
  assert.equal(dropped.openTurns, 0);
  assert.deepEqual(reduceTurn(two, { kind: "message", msg: { type: "zone_reset" } }).state, IDLE_TURN);
});
