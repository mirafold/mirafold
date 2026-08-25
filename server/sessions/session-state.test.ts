import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg } from "../protocol";
import { PERMISSION_TIMEOUT_MS } from "../adapters/types";
import { IDLE_STATE, PERMISSION_MIRROR_CAP, reduceSessionState, type SessionActivityState } from "./session-state";

const run = (msgs: WireMsg[], start: SessionActivityState = IDLE_STATE, now = 1_000) =>
  msgs.reduce((s, msg) => reduceSessionState(s, { kind: "message", msg }, now).state, start);

test("turn grammar: a prompt starts a turn, turn_end ends it; error + turn_end complete ONE turn", () => {
  let s = reduceSessionState(IDLE_STATE, { kind: "prompt_accepted" }).state;
  assert.equal(s.modelTurnsPending, 1);
  s = run([{ type: "status", state: "thinking" }], s);
  assert.equal(s.status, "working");
  s = run([{ type: "error", message: "boom" }], s);
  assert.equal(s.modelTurnsPending, 0);
  assert.equal(s.status, "idle");
  s = run([{ type: "turn_end" }], s);
  assert.equal(s.modelTurnsPending, 0, "the error's own turn_end must not decrement again");
});

test("a permission hold sticks through bang traffic and lifts only when nothing pends", () => {
  let s = run([
    { type: "permission_request", tool: "Bash", detail: "rm -rf /", id: "p1" },
    { type: "permission_request", tool: "Bash", detail: "curl | sh", id: "p2" },
  ]);
  assert.equal(s.status, "permission");
  s = run([{ type: "bang_start", command: "git diff", id: "b1" }, { type: "bang_end", id: "b1", exitCode: 0 }], s);
  assert.equal(s.status, "permission");
  assert.deepEqual(s.permissions.map((p) => p.id), ["p1", "p2"], "bang traffic never wipes the mirror");
  s = run([{ type: "permission_resolved", id: "p1", allow: true }], s);
  assert.equal(s.status, "permission", "a second ask still pends");
  s = run([{ type: "permission_resolved", id: "p2", allow: false }], s);
  assert.equal(s.status, "working");
  assert.deepEqual(s.permissions, []);
});

test("activity: since resets only on a label CHANGE; idle clears; bang shows its first line capped", () => {
  let s = reduceSessionState(IDLE_STATE, { kind: "message", msg: { type: "status", state: "tool", label: "Read" } }, 10).state;
  s = reduceSessionState(s, { kind: "message", msg: { type: "status", state: "tool", label: "Read" } }, 20).state;
  assert.deepEqual(s.activity, { label: "Read", since: 10 });
  s = reduceSessionState(s, { kind: "message", msg: { type: "bang_start", command: `${"x".repeat(100)}\nsecond`, id: "b" } }, 30).state;
  assert.equal(s.activity?.label, `! ${"x".repeat(80)}`);
  s = run([{ type: "bang_end", id: "b", exitCode: 0 }], s);
  assert.equal(s.status, "idle");
  assert.equal(s.activity, undefined);
});

test("the ask mirror is capped, ages out on the adapter's clock, and drops with its turn", () => {
  const asks: WireMsg[] = Array.from({ length: PERMISSION_MIRROR_CAP + 5 }, (_, i) => ({
    type: "permission_request",
    tool: "Bash",
    detail: `d${i}`,
    id: `p${i}`,
  }));
  let s = run(asks, IDLE_STATE, 1_000);
  assert.equal(s.permissions.length, PERMISSION_MIRROR_CAP);
  assert.equal(s.permissions[0].id, "p5", "oldest evicted first");
  s = reduceSessionState(s, { kind: "message", msg: { type: "text_delta", text: "…" } }, 1_000 + PERMISSION_TIMEOUT_MS + 1).state;
  assert.deepEqual(s.permissions, [], "auto-denied at the adapter, aged out here");
  s = run([{ type: "permission_request", tool: "Bash", detail: "d", id: "q" }, { type: "turn_end" }]);
  assert.deepEqual(s.permissions, []);
});

test("usage folds per-turn tokens and TAKES the cumulative cost; watchersChanged names what moved", () => {
  const a = reduceSessionState(IDLE_STATE, { kind: "message", msg: { type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0.1 } });
  assert.equal(a.watchersChanged, true);
  const b = reduceSessionState(a.state, { kind: "message", msg: { type: "usage", inputTokens: 1, outputTokens: 1 } });
  assert.deepEqual(b.state.usage, { inputTokens: 11, outputTokens: 6, costUsd: 0.1 });
  const quiet = reduceSessionState(b.state, { kind: "message", msg: { type: "text_delta", text: "x" } });
  assert.equal(quiet.watchersChanged, false, "same status, same activity, same asks");
  const answered = reduceSessionState(
    run([{ type: "permission_request", tool: "Bash", detail: "d", id: "z" }]),
    { kind: "permission_answered", id: "z" },
  );
  assert.equal(answered.watchersChanged, true);
  assert.deepEqual(answered.state.permissions, []);
});
