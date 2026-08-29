import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg } from "../protocol";
import { ReplayRing, msgBytes } from "./replay-ring";

const ring = (opts: Partial<ConstructorParameters<typeof ReplayRing>[0]> = {}) => {
  const delivered: WireMsg[] = [];
  const r = new ReplayRing({ coalesceMs: 0, deliver: (m) => delivered.push(r.push(m)), ...opts });
  return { r, delivered };
};

test("push stamps a strictly increasing seq on a copy and keeps bytes = Σ msgBytes", () => {
  const { r } = ring();
  const original: WireMsg = { type: "text_delta", text: "a" };
  const stamped = r.push(original);
  assert.equal(stamped.seq, 1);
  assert.equal((original as { seq?: number }).seq, undefined, "the adapter's object is untouched");
  r.push({ type: "turn_end" });
  assert.deepEqual(r.buffer.map((m) => m.seq), [1, 2]);
  assert.equal(r.bytes, r.buffer.reduce((sum, m) => sum + msgBytes(m), 0));
  assert.equal(r.nextSeq, 3);
});

test("trim evicts oldest-first on the count cap and on the byte cap, never the newest message", () => {
  const { r } = ring({ countCap: 3, byteCap: 100_000 });
  for (let i = 0; i < 5; i++) r.push({ type: "text_delta", text: `m${i}` });
  assert.deepEqual(r.buffer.map((m) => m.seq), [3, 4, 5]);
  const big = ring({ byteCap: 50 });
  big.r.push({ type: "text_delta", text: "x".repeat(200) });
  assert.equal(big.r.buffer.length, 1, "one payload over the whole budget still replays");
  big.r.push({ type: "text_delta", text: "y" });
  assert.equal(big.r.buffer.length, 1);
  assert.equal(big.r.buffer[0].type === "text_delta" && big.r.buffer[0].text, "y");
  assert.equal(big.r.bytes, msgBytes(big.r.buffer[0]));
});

test("canResume: false past the evicted edge, for a foreign seq, and for a restored ring", () => {
  const { r } = ring({ countCap: 3 });
  for (let i = 0; i < 5; i++) r.push({ type: "text_delta", text: `m${i}` });
  assert.equal(r.canResume(1), false, "seq 2 already fell off");
  assert.equal(r.canResume(2), true, "everything after 2 is retained");
  assert.equal(r.canResume(5), true, "nothing to replay is still a valid tail");
  assert.equal(r.canResume(6), false, "a seq we never issued");
  assert.deepEqual(r.replayAfter(3).map((m) => [m.seq, m.replay]), [[4, true], [5, true]]);
  assert.equal(r.buffer.every((m) => !("replay" in m)), true, "the ring itself stays unstamped");
  const restored = ReplayRing.restore(r.buffer, r.nextSeq, { coalesceMs: 0, deliver: () => {} });
  assert.equal(restored.canResume(4), false);
  assert.equal(restored.bytes, r.bytes);
});

test("offer merges same-lane deltas inside the window; anything else flushes first, in order", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { r, delivered } = ring({ coalesceMs: 50 });
  r.offer({ type: "text_delta", text: "a" });
  r.offer({ type: "text_delta", text: "b" });
  r.offer({ type: "text_delta", text: "c", parentId: "sub" }); // another lane flushes "ab"
  r.offer({ type: "thinking_delta", text: "t" }); // another type flushes "c"
  r.offer({ type: "status", state: "thinking" }); // a non-delta flushes "t" then delivers itself
  assert.deepEqual(
    delivered.map((m) => (m.type === "text_delta" || m.type === "thinking_delta" ? m.text : m.type)),
    ["ab", "c", "t", "status"],
  );
  r.offer({ type: "text_delta", text: "late" });
  assert.equal(delivered.length, 4, "held in the window");
  t.mock.timers.tick(50);
  const last = delivered.at(-1);
  assert.equal(last?.type === "text_delta" ? last.text : undefined, "late");
  assert.deepEqual(delivered.map((m) => m.seq), [1, 2, 3, 4, 5]);
});

test("review 2026-08-29: a cursor canResume accepts is one the replay can actually honor at a cap", () => {
  // A delta still coalescing at the count cap: the flush inside replayAfter()
  // pushes it and evicts the oldest retained message. The verdict must be
  // judged against THAT ring, or the viewport keeps its transcript while
  // silently missing the evicted message.
  const { r } = ring({ countCap: 3, coalesceMs: 50 });
  for (let i = 0; i < 4; i++) r.push({ type: "status", state: "thinking" });
  assert.deepEqual(r.buffer.map((m) => m.seq), [2, 3, 4]);
  r.offer({ type: "text_delta", text: "still coalescing" });
  assert.equal(r.canResume(1), false, "seq 2 is about to fall off");
  for (const after of [2, 3, 4]) {
    if (!r.canResume(after)) continue;
    const tail = r.replayAfter(after);
    assert.equal(tail[0]?.seq, after + 1, `resume after ${after} must replay from ${after + 1}, no hole`);
  }
});
