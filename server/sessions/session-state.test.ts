import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionMsg } from "../protocol";
import { PERMISSION_TIMEOUT_MS } from "../adapters/types";
import { IDLE_STATE, PERMISSION_MIRROR_CAP, reduceSessionState, type SessionActivityState } from "./session-state";

const run = (msgs: SessionMsg[], start: SessionActivityState = IDLE_STATE, now = 1_000) =>
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

test("a request-scoped error leaves an active model turn and its permission intact", () => {
  let s = reduceSessionState(IDLE_STATE, { kind: "prompt_accepted" }).state;
  s = run([
    { type: "status", state: "tool", label: "Bash" },
    { type: "permission_request", tool: "Bash", detail: "rm file", id: "p1" },
    { type: "bang_start", command: "echo hi", id: "b1" },
  ], s);
  const before = s;
  const failed = reduceSessionState(s, {
    kind: "message",
    msg: { type: "error", message: "! failed to start", terminal: false },
  });
  assert.equal(failed.state, before, "the side request owns no model-turn state");
  assert.equal(failed.state.modelTurnsPending, 1);
  assert.equal(failed.state.status, "permission");
  assert.deepEqual(failed.state.permissions.map((p) => p.id), ["p1"]);
  assert.equal(failed.watchersChanged, false);
});

test("activity: since resets only on a label CHANGE; idle clears; bang shows its first line capped", () => {
  let s = reduceSessionState(IDLE_STATE, { kind: "message", msg: { type: "status", state: "tool", label: "Read" } }, 10).state;
  s = reduceSessionState(s, { kind: "message", msg: { type: "status", state: "tool", label: "Read" } }, 20).state;
  assert.deepEqual(s.activity, { label: "Read", since: 10 });
  s = reduceSessionState(s, { kind: "message", msg: { type: "bang_start", command: `${"x".repeat(100)}\nsecond`, id: "b" } }, 30).state;
  assert.equal(s.activity?.label, `! ${"x".repeat(80)}`);
  s = run([{ type: "bang_end", id: "b", exitCode: 0 }], s);
  assert.equal(s.activity, undefined);
  // "idle clears" means FROM busy: a turn opened, then closed (test-audit
  // 2026-08-26 — the old assertion never left idle).
  let busy = run([{ type: "user_prompt", text: "x" }], s);
  assert.notEqual(busy.status, "idle", "a prompt makes the session busy");
  busy = run([{ type: "turn_end" }], busy);
  assert.equal(busy.status, "idle", "turn_end clears it");
});

test("the ask mirror is capped, ages out on the adapter's clock, and drops with its turn", () => {
  const asks: SessionMsg[] = Array.from({ length: PERMISSION_MIRROR_CAP + 5 }, (_, i) => ({
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

test("replacing the oldest ask at the mirror cap notifies fleet watchers", () => {
  let s = IDLE_STATE;
  for (let i = 0; i < PERMISSION_MIRROR_CAP; i += 1) {
    s = reduceSessionState(s, {
      kind: "message",
      msg: { type: "permission_request", tool: "Bash", detail: `d${i}`, id: `p${i}` },
    }).state;
  }
  const replacement = reduceSessionState(s, {
    kind: "message",
    msg: { type: "permission_request", tool: "Bash", detail: "new", id: "new" },
  });
  assert.equal(replacement.state.permissions.length, PERMISSION_MIRROR_CAP);
  assert.equal(replacement.state.permissions[0].id, "p1");
  assert.equal(replacement.state.permissions.at(-1)?.id, "new");
  assert.equal(replacement.watchersChanged, true);
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

// AUDIT 2026-08-26: IDLE_STATE is spread into every SessionEntry; a shared
// mutable `permissions` array would leak one session's asks into all others
// the moment anything pushed in place. Frozen, so that is an exception, not a
// silent cross-session leak.
test("IDLE_STATE is frozen, its permissions array included; the reducer never mutates it", () => {
  assert.ok(Object.isFrozen(IDLE_STATE));
  assert.ok(Object.isFrozen(IDLE_STATE.permissions));
  assert.throws(() => (IDLE_STATE.permissions as unknown as unknown[]).push({}), TypeError);
  const s = run([{ type: "permission_request", tool: "Bash", detail: "x", id: "p1" }]);
  assert.equal(s.permissions.length, 1);
  assert.equal(IDLE_STATE.permissions.length, 0);
});

test("a running `!` keeps the row working when the model turn ends first (PR #77 review, P2)", () => {
  // `!` runs BESIDE the model turn; a quiet command (`sleep 30`) emits no
  // later bang_output to re-assert `working`, so turn_end alone must not
  // read the session as idle while its PTY is alive — the fleet row would
  // hide Stop exactly while shell work is still running.
  let s = reduceSessionState(IDLE_STATE, { kind: "prompt_accepted" }).state;
  s = run([{ type: "user_prompt", text: "explain" }, { type: "bang_start", command: "sleep 30", id: "b1" }], s);
  assert.equal(s.status, "working");
  s = run([{ type: "turn_end" }], s);
  assert.equal(s.status, "working", "the PTY is still running");
  assert.equal(s.activity?.label, "! sleep 30", "and the row still names it");
  s = run([{ type: "bang_end", id: "b1", exitCode: 0 }], s);
  assert.equal(s.status, "idle");
  assert.equal(s.activity, undefined);

  // The error-terminated variant of the same turn.
  let e = reduceSessionState(IDLE_STATE, { kind: "prompt_accepted" }).state;
  e = run([{ type: "bang_start", command: "sleep 30", id: "b2" }, { type: "error", message: "boom" }], e);
  assert.equal(e.status, "working", "an error-ended turn does not idle a live PTY either");
  e = run([{ type: "turn_end" }, { type: "bang_end", id: "b2", exitCode: null }], e);
  assert.equal(e.status, "idle");
});
