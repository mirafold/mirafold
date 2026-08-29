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

test("an error plus its paired turn_end leaves a queued follow-up busy", () => {
  const queued = play([
    { type: "user_prompt", text: "one" },
    { type: "user_prompt", text: "two" },
  ]).state;
  const failed = reduceTurn(queued, {
    kind: "message",
    msg: { type: "error", message: "first failed" },
  });
  assert.equal(failed.state.openTurns, 1);
  assert.equal(failed.state.busy, true);
  const pairedEnd = reduceTurn(failed.state, { kind: "message", msg: { type: "turn_end" } });
  assert.equal(pairedEnd.state.openTurns, 1);
  assert.equal(pairedEnd.state.busy, true);
  assert.equal(pairedEnd.state.errorAwaitingTurnEnd, false);
  assert.deepEqual(pairedEnd.announcements, [], "the error's end is not announced twice");
});

test("a request-scoped error is announced without ending the active model turn", () => {
  const active = play([
    { type: "user_prompt", text: "x" },
    { type: "status", state: "tool", label: "Bash" },
    { type: "permission_request", tool: "Bash", detail: "rm file", id: "p1" },
  ]).state;
  const r = reduceTurn(active, {
    kind: "message",
    msg: { type: "error", message: "! failed to start", terminal: false },
  });
  assert.equal(r.state.openTurns, 1);
  assert.equal(r.state.busy, true);
  assert.deepEqual(r.state.activity, { state: "tool", label: "Bash" });
  assert.deepEqual(r.state.asks.map((ask) => ask.id), ["p1"]);
  assert.deepEqual(r.announcements, [{ text: "! failed to start", assertive: true }]);
});

test("replayed frames repaint state but announce nothing; the turn-end response is spoken once, live", () => {
  const replayed = play([
    { type: "user_prompt", text: "x", replay: true },
    { type: "text_delta", text: "hello", replay: true },
    { type: "permission_request", tool: "Bash", detail: "ls", id: "p1", replay: true },
    { type: "permission_resolved", id: "p1", allow: false, replay: true },
    { type: "error", message: "old failure", replay: true },
  ]);
  assert.deepEqual(replayed.said, []);
  assert.equal(replayed.state.asks.length, 0, "a replayed resolution still repaints the ask state");
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

// AUDIT 2026-08-26 (hardening): a message the reducer ignores — or one that
// leaves every rendered field as it was — must return `prev` itself, or the
// whole Shell re-renders per frame (the OutputZone's full row map included)
// at a rate the engine controls.
test("a no-op frame returns the previous state object; a real change returns a new one", () => {
  const busy = play([
    { type: "user_prompt", text: "x" },
    { type: "status", state: "thinking" },
  ]).state;
  const ignored: ZoneMsg[] = [
    { type: "render", component: "card", props: {}, id: "r1" },
    { type: "bang_output", data: "…", id: "b1" },
    { type: "shell_cwd", cwd: "/work/child" },
    { type: "thinking_delta", text: "still thinking" },
    { type: "status", state: "thinking" },
    { type: "usage", inputTokens: 1, outputTokens: 1 },
  ];
  for (const msg of ignored) {
    assert.equal(reduceTurn(busy, { kind: "message", msg }).state, busy, `${msg.type} is identity-preserving`);
  }
  assert.equal(reduceTurn(busy, { kind: "interrupt" }).state, busy, "an interrupt with one open turn changes nothing");
  assert.notEqual(reduceTurn(busy, { kind: "message", msg: { type: "text_delta", text: "hi" } }).state, busy);
  assert.notEqual(reduceTurn(busy, { kind: "message", msg: { type: "tool_use", name: "Bash", id: "t1" } }).state, busy);
  assert.notEqual(reduceTurn(busy, { kind: "disconnected" }).state, busy);
  assert.equal(reduceTurn(IDLE_TURN, { kind: "disconnected" }).state, IDLE_TURN);
});
