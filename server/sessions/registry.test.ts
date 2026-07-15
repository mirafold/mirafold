import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCwd, SessionRegistry } from "./registry";
import type { Backend } from "../adapters";
import type { WireMsg } from "../protocol";

test("resolveCwd defaults to the process cwd", () => {
  assert.equal(resolveCwd(undefined), process.cwd());
});

test("resolveCwd resolves an existing dir to an absolute path", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "genui-cwd-"));
  assert.equal(resolveCwd(base), path.resolve(base));
});

test("resolveCwd expands a leading ~", () => {
  assert.equal(resolveCwd("~"), os.homedir());
});

test("resolveCwd throws on a missing directory", () => {
  assert.throws(() => resolveCwd("/no/such/dir/genui-nope"), /no such directory/);
});

test("resolveCwd throws when the path is a file, not a directory", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "genui-cwd-"));
  const file = path.join(base, "f.txt");
  writeFileSync(file, "x");
  assert.throws(() => resolveCwd(file), /not a directory/);
});

// Ring-buffer eviction and the resume boundary, unit-tested directly
// against SessionRegistry with a mock backend (live:false → the inert
// MockSession; no daemon, no network, and nothing emitted until a prompt is
// pushed, so the ring holds exactly what we broadcast). We drive
// broadcast()/canResume()/attach() by hand and inspect the ring (Q.3).
const MOCK_BACKEND: Backend = { agent: "claude-code", kind: "none", live: false };
// Mirror of BUFFER_CAP in registry.ts (module-private, so not importable). Kept
// in sync by hand — a cap change must update this, which is deliberate: pinning
// the absolute value is what makes an off-by-one in the ring size fail here.
const BUFFER_CAP = 4000;
const PUSH = BUFFER_CAP + 500; // exceed the cap so eviction fires

function freshSession() {
  const reg = new SessionRegistry(MOCK_BACKEND);
  const dir = mkdtempSync(path.join(os.tmpdir(), "genui-reg-"));
  const entry = reg.create({ cwd: dir });
  assert.equal(entry.buffer.length, 0); // create() streams nothing
  assert.equal(entry.nextSeq, 1);
  return { reg, entry };
}

const delta = (): WireMsg => ({ type: "text_delta", text: "x" });

test("Q.3 ring buffer stays bounded and holds exactly the newest window after eviction", () => {
  const { reg, entry } = freshSession();
  for (let i = 0; i < PUSH; i++) reg.broadcast(entry, delta());

  const cap = entry.buffer.length;
  assert.equal(cap, BUFFER_CAP); // bounded at EXACTLY the cap — a ±1 off-by-one fails here
  assert.equal(entry.nextSeq, PUSH + 1); // seqs 1..PUSH were issued in order

  // The retained window is the NEWEST `cap` messages, contiguous by seq, with
  // the oldest (seq 1) evicted — an off-by-one in the splice would fail one of
  // these.
  assert.equal(entry.buffer[cap - 1].seq, PUSH); // newest kept
  assert.equal(entry.buffer[0].seq, PUSH - cap + 1); // oldest kept = start of the newest window
  assert.ok(entry.buffer[0].seq! > 1, "seq 1 must have fallen off the ring");
  for (let k = 0; k < cap; k++) {
    assert.equal(entry.buffer[k].seq, PUSH - cap + 1 + k); // no gaps in the window
  }
  reg.end(entry.id);
});

test("Q.3 a late attach (no afterSeq) replays exactly the retained window, in order", () => {
  const { reg, entry } = freshSession();
  for (let i = 0; i < PUSH; i++) reg.broadcast(entry, delta());
  const cap = entry.buffer.length;

  const seen: number[] = [];
  reg.attach(entry, (m) => seen.push(m.seq!));
  assert.equal(seen.length, cap);
  assert.equal(seen[0], PUSH - cap + 1);
  assert.equal(seen[seen.length - 1], PUSH);
  for (let k = 1; k < seen.length; k++) assert.equal(seen[k], seen[k - 1] + 1); // contiguous
  reg.end(entry.id);
});

test("Q.3 canResume flips false at exactly the evicted edge (the off-by-one)", () => {
  const { reg, entry } = freshSession();
  for (let i = 0; i < PUSH; i++) reg.broadcast(entry, delta());
  const firstBuffered = entry.buffer[0].seq!;

  // A viewport that last saw (firstBuffered - 1) can tail-resume: every seq it
  // hasn't seen is still buffered. One earlier, and the message at
  // (firstBuffered - 1) has itself fallen off — a gap — so resume is refused.
  // These two lines are the boundary an off-by-one in either direction fails.
  assert.equal(reg.canResume(entry, firstBuffered - 1), true); // exact edge: resumable
  assert.equal(reg.canResume(entry, firstBuffered - 2), false); // one past: gap, must refuse

  // Range guards: saw-the-latest resumes (empty tail); a seq never issued and
  // malformed inputs are refused.
  assert.equal(reg.canResume(entry, entry.nextSeq - 1), true);
  assert.equal(reg.canResume(entry, entry.nextSeq), false);
  assert.equal(reg.canResume(entry, -1), false);
  assert.equal(reg.canResume(entry, 1.5), false);
  reg.end(entry.id);
});

test("Q.3 a valid post-eviction tail resume replays exactly the unseen tail", () => {
  const { reg, entry } = freshSession();
  for (let i = 0; i < PUSH; i++) reg.broadcast(entry, delta());
  const firstBuffered = entry.buffer[0].seq!;

  // Resume from the exact edge → the whole retained window, nothing dropped.
  const fromEdge: number[] = [];
  const vp1 = (m: WireMsg) => fromEdge.push(m.seq!);
  reg.attach(entry, vp1, firstBuffered - 1);
  assert.equal(fromEdge[0], firstBuffered);
  assert.equal(fromEdge[fromEdge.length - 1], PUSH);
  assert.equal(fromEdge.length, entry.buffer.length);
  reg.detach(entry, vp1);

  // Resume from a mid-window seq → only strictly-greater seqs replay.
  const mid = firstBuffered + 100;
  const fromMid: number[] = [];
  reg.attach(entry, (m) => fromMid.push(m.seq!), mid);
  assert.equal(fromMid[0], mid + 1);
  assert.equal(fromMid[fromMid.length - 1], PUSH);
  assert.ok(fromMid.every((s) => s > mid));
  reg.end(entry.id);
});

test("Q.3 canResume on a small (un-evicted) buffer: seq 0 replays from the very start", () => {
  const { reg, entry } = freshSession();
  for (let i = 0; i < 5; i++) reg.broadcast(entry, delta()); // seqs 1..5, nothing evicted
  assert.equal(entry.buffer[0].seq, 1);
  assert.equal(reg.canResume(entry, 0), true); // saw nothing yet → full tail replay
  assert.equal(reg.canResume(entry, 5), true); // saw all → empty tail
  assert.equal(reg.canResume(entry, 6), false); // beyond what was issued

  const seen: number[] = [];
  reg.attach(entry, (m) => seen.push(m.seq!), 0);
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  reg.end(entry.id);
});
