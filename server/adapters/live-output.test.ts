import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg } from "../protocol";
import { LiveOutput, streamCapMarker } from "./live-output";
import { splitBudget } from "./types";

type Any = WireMsg & Record<string, any>;
const last = (arr: Any[]): Any => {
  const m = arr.at(-1);
  assert.ok(m, "expected at least one message");
  return m;
};

/** A LiveOutput on a fake clock; `tick` advances it and lets due timers run. */
function harness(opts: { capBytes: number; intervalMs?: number; legacyDeltas?: boolean }) {
  const msgs: Any[] = [];
  let now = 0;
  const live = new LiveOutput({
    emit: (m) => msgs.push(m as Any),
    capBytes: opts.capBytes,
    intervalMs: opts.intervalMs ?? 250,
    legacyDeltas: opts.legacyDeltas,
    now: () => now,
  });
  const snapshots = () => msgs.filter((m) => m.type === "tool_output_snapshot");
  const deltas = () => msgs.filter((m) => m.type === "tool_output_delta");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return { live, msgs, snapshots, deltas, advance: (ms: number) => (now += ms), sleep };
}

test("TF1.3a: crossing the cap freezes the head while the tail advances; byte accounting is exact", () => {
  const cap = 20;
  const { live, snapshots } = harness({ capBytes: cap });
  const { head, tail } = splitBudget(cap);
  live.append("t", "0123456789"); // under the cap: whole text is the head
  assert.deepEqual(last(snapshots()), { type: "tool_output_snapshot", id: "t", revision: 1, head: "0123456789" });
  live.settle("t");
  const h2 = harness({ capBytes: cap, intervalMs: 0 });
  h2.live.append("t", "0123456789ABCDEFGHIJ"); // exactly the cap: still exact
  assert.equal(last(h2.snapshots()).head, "0123456789ABCDEFGHIJ");
  h2.live.append("t", "klmnopqrstuvwxyz"); // 36 bytes total: head fixed, tail = newest 10
  const s = last(h2.snapshots());
  assert.equal(s.head, "0123456789".slice(0, head));
  assert.equal(s.tail, "qrstuvwxyz".slice(-tail));
  assert.equal(s.omittedBytes, 36 - head - tail);
  h2.live.append("t", "!"); // the tail slides by one
  const s2 = last(h2.snapshots());
  assert.equal(s2.head, s.head);
  assert.equal(s2.tail, "rstuvwxyz!");
  assert.equal(s2.omittedBytes, 37 - head - tail);
  assert.ok(s2.revision > s.revision);
});

test("TF1.3a: UTF-8 stays intact across chunk seams and the sliding tail window", () => {
  const h = harness({ capBytes: 12, intervalMs: 0 });
  h.live.append("u", "€€€€€"); // 15 bytes > 12: head 6 bytes = "€€", tail 6 bytes = "€€"
  const s = last(h.snapshots());
  assert.equal(s.head, "€€");
  assert.equal(s.tail, "€€");
  assert.equal(s.omittedBytes, 3);
  h.live.append("u", "ab"); // tail window now ends "…€€ab": 6 bytes = "€ab" + one dropped continuation-only prefix
  const s2 = last(h.snapshots());
  assert.ok(!s2.tail.includes("�"));
  assert.equal(s2.tail, "€ab");
  assert.equal(s2.omittedBytes, 17 - 6 - 5);
});

test("TF1.3a: concurrent ids stay separate; zero and tiny budgets remain valid", () => {
  const { live, snapshots } = harness({ capBytes: 0, intervalMs: 0 });
  live.append("a", "hello");
  live.append("b", "world!");
  const a = last(snapshots().filter((m) => m.id === "a"));
  const b = last(snapshots().filter((m) => m.id === "b"));
  assert.deepEqual(a, { type: "tool_output_snapshot", id: "a", revision: 1, head: "", omittedBytes: 5 });
  assert.deepEqual(b, { type: "tool_output_snapshot", id: "b", revision: 1, head: "", omittedBytes: 6 });
  const tiny = harness({ capBytes: 1, intervalMs: 0 });
  tiny.live.append("t", "€x");
  const s = last(tiny.snapshots());
  assert.equal(s.head, ""); // a 3-byte char does not fit one byte
  assert.equal(s.tail, undefined); // the tail budget is zero
  assert.equal(s.omittedBytes, 4);
});

test("TF1.3b: snapshots are throttled to the interval; settle flushes the newest immediately", async () => {
  const h = harness({ capBytes: 100, intervalMs: 250 });
  h.live.append("t", "one\n");
  assert.equal(h.snapshots().length, 1, "the first snapshot goes out at once");
  h.live.append("t", "two\n");
  h.live.append("t", "three\n");
  assert.equal(h.snapshots().length, 1, "inside the window nothing more is sent");
  h.live.settle("t");
  assert.equal(h.snapshots().length, 2, "settling flushes the pending state");
  assert.equal(last(h.snapshots()).head, "one\ntwo\nthree\n");
  assert.equal(last(h.snapshots()).revision, 2);
  // A settled id is forgotten: later bytes for it start over, nothing leaks
  // from the earlier life.
  h.live.append("t", "late");
  assert.equal(last(h.snapshots()).head, "late");
  assert.equal(last(h.snapshots()).revision, 1);
});

test("TF1.3b: the timer fires the deferred snapshot; clear() flushes and leaves no timer", async () => {
  const h = harness({ capBytes: 100, intervalMs: 20 });
  h.live.append("t", "a");
  h.live.append("t", "b");
  assert.equal(h.snapshots().length, 1);
  h.advance(20);
  await h.sleep(40);
  assert.equal(h.snapshots().length, 2, "the deferred snapshot fired");
  assert.equal(last(h.snapshots()).head, "ab");
  h.live.append("t", "c");
  h.live.append("u", "x");
  h.live.clear();
  assert.equal(last(h.snapshots().filter((m) => m.id === "t")).head, "abc");
  assert.equal(last(h.snapshots().filter((m) => m.id === "u")).head, "x");
  await h.sleep(40);
  const after = h.snapshots().length;
  await h.sleep(30);
  assert.equal(h.snapshots().length, after, "no timer survived teardown");
});

test("TF1.3b: legacy deltas stay bounded at the cap with one marker; snapshots keep advancing", () => {
  const cap = 10;
  const h = harness({ capBytes: cap, intervalMs: 0 });
  h.live.append("t", "0123456789abcdef");
  h.live.append("t", "ghij");
  const texts = h.deltas().map((m) => m.text);
  assert.deepEqual(texts, ["0123456789" + streamCapMarker(cap)]);
  assert.equal(last(h.snapshots()).tail, "fghij");
  assert.equal(last(h.snapshots()).omittedBytes, 20 - 5 - 5);
  const quiet = harness({ capBytes: cap, intervalMs: 0, legacyDeltas: false });
  quiet.live.append("t", "hello");
  assert.equal(quiet.deltas().length, 0);
  assert.equal(quiet.snapshots().length, 1);
});

test("TF1.3b: replace() forwards only the new suffix of a republished whole; a non-extension is a reset", () => {
  const h = harness({ capBytes: 100, intervalMs: 0 });
  h.live.replace("t", "line1\n");
  h.live.replace("t", "line1\nline2\n");
  h.live.replace("t", "line1\nline2\n"); // identical: nothing new
  assert.deepEqual(h.deltas().map((m) => m.text), ["line1\n", "line2\n"]);
  assert.equal(last(h.snapshots()).head, "line1\nline2\n");
  h.live.replace("t", "fresh\n"); // the engine rolled its buffer: the head keeps what was seen
  assert.equal(last(h.deltas()).text, "fresh\n");
  assert.equal(last(h.snapshots()).head, "line1\nline2\nfresh\n");
});

test("PR #120 round 3: the comparison state is bounded, and clear(keepChildren) keeps a child's revision counter", () => {
  const h = harness({ capBytes: 100_000, intervalMs: 0 });
  // A whole far larger than the tail window still extends by suffix only.
  let full = "";
  for (let i = 0; i < 40; i++) {
    full += `line ${i} ${"x".repeat(200)}\n`;
    h.live.replace("t", full);
  }
  const suffixes = h.deltas().filter((m) => m.id === "t").map((m) => m.text);
  assert.equal(suffixes.join("").length > 0, true);
  assert.ok(suffixes.every((s) => s.length <= 220), "each republish yields only its new suffix");
  // A reset that changes earlier text is detected through the tail window.
  h.live.replace("t", "fresh start\n");
  assert.equal(last(h.deltas().filter((m) => m.id === "t")).text, "fresh start\n");
  // Root clear keeps a parented track's revisions advancing.
  const c = harness({ capBytes: 64, intervalMs: 0 });
  c.live.append("root", "r1\n");
  c.live.append("child", "c1\n", "spawn");
  c.live.clear({ keepChildren: true });
  c.live.append("child", "c2\n", "spawn");
  const childSnaps = c.snapshots().filter((m) => m.id === "child");
  assert.deepEqual(childSnaps.map((m) => m.revision), [1, 2], "the child's counter continued");
  assert.equal(c.live.has("root"), false);
  c.live.clear();
  assert.equal(c.live.has("child"), false);
});

test("parentId rides every snapshot and delta of a child's call", () => {
  const h = harness({ capBytes: 100, intervalMs: 0 });
  h.live.append("c", "child out", "spawn-1");
  assert.equal(h.deltas()[0].parentId, "spawn-1");
  assert.equal(h.snapshots()[0].parentId, "spawn-1");
});
