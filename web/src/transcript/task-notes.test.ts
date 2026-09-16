import { test } from "node:test";
import assert from "node:assert/strict";
import { TASK_LEDGER_CAP, recordTaskState, taskNoteFor } from "./task-notes";

test("a completion note fires on a live transition only; a replayed frame is remembered, not spoken", () => {
  const noted = new Map<string, string>();
  assert.equal(taskNoteFor(noted, { id: "t1", state: "running", label: "find auth" }), null);
  assert.deepEqual(taskNoteFor(noted, { id: "t1", state: "completed", label: "find auth" }), { text: "find auth finished", failed: false });
  // The engine republishes the same terminal state (a collab poll): no news.
  assert.equal(taskNoteFor(noted, { id: "t1", state: "completed", label: "find auth" }), null);
  assert.deepEqual(taskNoteFor(noted, { id: "t2", state: "failed" }), { text: "a task failed", failed: true });
  assert.deepEqual(taskNoteFor(noted, { id: "t3", state: "interrupted", label: "x" }), { text: "x was interrupted", failed: false });
});

// Release review 0.10.0: after a reload the replayed frames were skipped
// whole, so the ledger was empty and the next republication of an already
// shown terminal state produced a fresh completion note and announcement.
test("replayed task frames seed the ledger silently, so a later republication of the same state is not news", () => {
  const noted = new Map<string, string>();
  assert.equal(taskNoteFor(noted, { id: "t1", state: "completed", label: "find auth", replay: true }), null, "replay is silent");
  assert.equal(noted.get("t1"), "completed", "but remembered");
  assert.equal(taskNoteFor(noted, { id: "t1", state: "completed", label: "find auth" }), null, "the live republication says nothing new");
  assert.deepEqual(taskNoteFor(noted, { id: "t1", state: "failed", label: "find auth" }), { text: "find auth failed", failed: true }, "a real change still notes");
});

test("the ledger is bounded, oldest out first", () => {
  const noted = new Map<string, string>();
  for (let i = 0; i < TASK_LEDGER_CAP + 5; i++) recordTaskState(noted, `t${i}`, "running");
  assert.equal(noted.size, TASK_LEDGER_CAP);
  assert.equal(noted.has("t0"), false);
  assert.equal(noted.has(`t${TASK_LEDGER_CAP + 4}`), true);
  assert.equal(recordTaskState(noted, `t${TASK_LEDGER_CAP + 4}`, "running"), false, "same state is not a change");
});
