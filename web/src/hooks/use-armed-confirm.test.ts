import { test } from "node:test";
import assert from "node:assert/strict";
import { ArmerCore } from "./use-armed-confirm";

// 2026-07-29 bughunt: the disarm timer identified its owner by key VALUE, so
// re-arming the SAME key inherited the previous arming's timer — the second
// window was cut short and the user's confirm click re-armed instead of
// firing. The core now stands a timer down only for its own generation.

function harness() {
  let armed: string | null = null;
  const timers: (() => void)[] = [];
  const core = new ArmerCore<string>(
    (updater) => {
      armed = updater(armed);
    },
    (fn) => timers.push(fn as () => void),
  );
  return { core, timers, armed: () => armed };
}

test("re-arming the same key gets a FULL window — the old timer stands down", () => {
  const { core, timers, armed } = harness();
  core.arm("A"); // timer[0] armed for generation 1
  core.disarm(); // the confirm fired
  core.arm("A"); // timer[1] armed for generation 2
  assert.equal(armed(), "A");
  timers[0](); // generation 1's timer fires mid-window…
  assert.equal(armed(), "A", "…and must not cut the re-armed window short");
  timers[1]();
  assert.equal(armed(), null, "the current generation's timer disarms normally");
});

test("a different key's timer never disarms the newly armed key", () => {
  const { core, timers, armed } = harness();
  core.arm("A");
  core.arm("B");
  timers[0](); // A's timer
  assert.equal(armed(), "B");
  timers[1]();
  assert.equal(armed(), null);
});
