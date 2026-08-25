import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MINI_SPAN,
  PONDER_AFTER_MS,
  WALKER_SPAN,
  miniMotion,
  miniSprite,
  nextSubagents,
  trackPosition,
  walkerMood,
  walkerSprite,
} from "./walker";

// ── Mood: every behavior maps to a real engine state ─────────────────────

test("mood follows the engine: tool carries, fresh thinking walks, long thinking ponders", () => {
  assert.equal(walkerMood("tool", 0), "carry");
  assert.equal(walkerMood("tool", PONDER_AFTER_MS * 2), "carry", "a tool is never a ponder");
  assert.equal(walkerMood("thinking", 0), "walk");
  assert.equal(walkerMood("thinking", PONDER_AFTER_MS - 1), "walk");
  assert.equal(walkerMood("thinking", PONDER_AFTER_MS), "ponder");
  assert.equal(walkerMood(null, PONDER_AFTER_MS * 2), "walk", "generic working never ponders");
});

// ── Pacing: the triangle wave stays on the track and turns at the ends ───

test("pacing walks 0→span→0 and flips facing at the turn", () => {
  const span = 4;
  const cells = Array.from({ length: span * 2 + 1 }, (_, s) => trackPosition(s, span).cell);
  assert.deepEqual(cells, [0, 1, 2, 3, 4, 3, 2, 1, 0]);
  assert.equal(trackPosition(2, span).facing, 1);
  assert.equal(trackPosition(6, span).facing, -1);
});

test("pacing never leaves the track, whatever the step", () => {
  for (const span of [WALKER_SPAN, MINI_SPAN]) {
    for (let s = 0; s < span * 6 + 7; s++) {
      const { cell } = trackPosition(s, span);
      assert.ok(cell >= 0 && cell <= span, `step ${s} left the track: ${cell}`);
    }
  }
});

test("a zero-width track parks the walker instead of dividing by zero", () => {
  assert.deepEqual(trackPosition(17, 0), { cell: 0, facing: 1 });
});

// ── Sprites ──────────────────────────────────────────────────────────────

test("the carry sprite holds its box on the side it walks toward", () => {
  assert.ok(walkerSprite("carry", 0, 1).endsWith("▪"));
  assert.ok(walkerSprite("carry", 0, -1).startsWith("▪"));
});

test("step 0 shows open eyes — the parked reduced-motion frame never blinks", () => {
  assert.equal(walkerSprite("walk", 0, 1), "(•ᴗ•)");
});

test("ponder cycles its thought dots without ever going dotless", () => {
  const dots = [0, 1, 2, 3].map((s) => walkerSprite("ponder", s, 1).split(" ")[1].length);
  assert.deepEqual(dots, [1, 2, 3, 1]);
});

// ── Minis: deterministic gait, honest roster ─────────────────────────────

test("mini gait is deterministic per id and varies across ids", () => {
  const a = miniMotion("11111111-2222-3333-4444-555555555555");
  assert.deepEqual(a, miniMotion("11111111-2222-3333-4444-555555555555"));
  assert.ok(a.speed >= 0.5 && a.speed <= 1.25);
  assert.ok(a.drift >= 0 && a.drift < 14, `drift off the parade: ${a.drift}`);
  const ids = ["a", "bb", "ccc", "dddd", "eeeee", "ffffff", "0123", "zzzz9"];
  assert.ok(new Set(ids.map((id) => miniMotion(id).speed)).size > 1, "every mini paced in lockstep");
  assert.ok(new Set(ids.map((id) => miniMotion(id).drift)).size > 1, "every mini shares one lane");
  assert.ok(miniSprite(0, 3).startsWith("("));
});

const fold = (msgs: { type: string; id?: string; parentId?: string }[]) =>
  msgs.reduce<readonly string[]>((r, m) => nextSubagents(r, m), []);

test("a mini materializes on the first child record and dematerializes on the spawn's own result", () => {
  let r = fold([
    { type: "tool_use", id: "task-1" }, // the spawn itself proves nothing yet
  ]);
  assert.deepEqual(r, [], "a bare tool_use is not yet a subagent");
  r = nextSubagents(r, { type: "text_delta", parentId: "task-1" });
  assert.deepEqual(r, ["task-1"]);
  r = nextSubagents(r, { type: "tool_use", id: "c1", parentId: "task-1" });
  assert.deepEqual(r, ["task-1"], "no duplicate for more child traffic");
  r = nextSubagents(r, { type: "tool_result", id: "c1", parentId: "task-1" });
  assert.deepEqual(r, ["task-1"], "a CHILD's result is not the subagent finishing");
  r = nextSubagents(r, { type: "tool_result", id: "task-1" });
  assert.deepEqual(r, [], "the root result closes it");
});

test("three overlapping subagents finish out of order, mock-style", () => {
  let r = fold([
    { type: "tool_use", id: "c-a", parentId: "a" },
    { type: "tool_use", id: "c-b", parentId: "b" },
    { type: "tool_use", id: "c-c", parentId: "c" },
  ]);
  assert.deepEqual(r, ["a", "b", "c"]);
  r = nextSubagents(r, { type: "tool_result", id: "b" }); // second spawned, first done
  assert.deepEqual(r, ["a", "c"]);
});

test("turn boundaries and resets clear the roster; unrelated results don't", () => {
  const base = fold([{ type: "thinking_delta", parentId: "x" }]);
  assert.deepEqual(nextSubagents(base, { type: "turn_end" }), []);
  assert.deepEqual(nextSubagents(base, { type: "error" }), []);
  assert.deepEqual(nextSubagents(base, { type: "zone_reset" }), []);
  assert.equal(nextSubagents(base, { type: "tool_result", id: "not-a-task" }), base);
  assert.equal(nextSubagents([], { type: "turn_end" }).length, 0);
});

test("an unchanged roster returns the same reference — no wasted re-renders", () => {
  const r = fold([{ type: "text_delta", parentId: "a" }]);
  assert.equal(nextSubagents(r, { type: "text_delta", parentId: "a" }), r);
  assert.equal(nextSubagents(r, { type: "status" }), r);
});
