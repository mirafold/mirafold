import { test } from "node:test";
import assert from "node:assert/strict";
import type { ZoneMsg } from "../transport/session-bus";
import {
  createTranscriptIngress,
  queueDelta,
  type QueuedDelta,
  type TranscriptIngressRuntime,
} from "./delta-queue";

test("consecutive same-type deltas merge into one entry whose text is the concatenation", () => {
  const q: QueuedDelta[] = [];
  queueDelta(q, { type: "text_delta", text: "hel" });
  queueDelta(q, { type: "text_delta", text: "lo" });
  assert.deepEqual(q, [{ type: "text_delta", text: "hello" }]);
});

test("a type switch starts a new entry — arrival order survives the merge", () => {
  const q: QueuedDelta[] = [];
  queueDelta(q, { type: "thinking_delta", text: "hm" });
  queueDelta(q, { type: "thinking_delta", text: "m" });
  queueDelta(q, { type: "text_delta", text: "Right" });
  queueDelta(q, { type: "text_delta", text: "." });
  queueDelta(q, { type: "thinking_delta", text: "more" });
  assert.deepEqual(q, [
    { type: "thinking_delta", text: "hmm" },
    { type: "text_delta", text: "Right." },
    { type: "thinking_delta", text: "more" },
  ]);
});

test("the queued entry is a copy — merging never mutates the wire message", () => {
  const q: QueuedDelta[] = [];
  const original: QueuedDelta = { type: "text_delta", text: "a" };
  queueDelta(q, original);
  queueDelta(q, { type: "text_delta", text: "b" });
  assert.equal(original.text, "a");
  assert.equal(q[0].text, "ab");
});

test("SA.2: a different parentId never merges — parallel subagents keep their prose apart", () => {
  const q: QueuedDelta[] = [];
  queueDelta(q, { type: "text_delta", text: "parent" });
  queueDelta(q, { type: "text_delta", text: "A1", parentId: "a" });
  queueDelta(q, { type: "text_delta", text: "A2", parentId: "a" });
  queueDelta(q, { type: "text_delta", text: "B1", parentId: "b" });
  queueDelta(q, { type: "thinking_delta", text: "B-think", parentId: "b" });
  assert.deepEqual(q, [
    { type: "text_delta", text: "parent" },
    { type: "text_delta", text: "A1A2", parentId: "a" },
    { type: "text_delta", text: "B1", parentId: "b" },
    { type: "thinking_delta", text: "B-think", parentId: "b" },
  ]);
});

test("TS.8: phase survives batching and commentary never merges into a final answer", () => {
  const q: QueuedDelta[] = [];
  queueDelta(q, { type: "text_delta", text: "check", phase: "commentary" });
  queueDelta(q, { type: "text_delta", text: "ing", phase: "commentary" });
  queueDelta(q, { type: "text_delta", text: "answer", phase: "final" });
  assert.deepEqual(q, [
    { type: "text_delta", text: "checking", phase: "commentary" },
    { type: "text_delta", text: "answer", phase: "final" },
  ]);
});

test("TS.11: tool output batches by call id without crossing subagent lanes", () => {
  const q: QueuedDelta[] = [];
  queueDelta(q, { type: "tool_output_delta", id: "one", text: "a", parentId: "task" });
  queueDelta(q, { type: "tool_output_delta", id: "one", text: "b", parentId: "task" });
  queueDelta(q, { type: "tool_output_delta", id: "two", text: "c", parentId: "task" });
  assert.deepEqual(q, [
    { type: "tool_output_delta", id: "one", text: "ab", parentId: "task" },
    { type: "tool_output_delta", id: "two", text: "c", parentId: "task" },
  ]);
});

class ManualIngressRuntime implements TranscriptIngressRuntime {
  frame: (() => void) | undefined;
  fallback: (() => void) | undefined;
  fallbackDelay: number | undefined;

  scheduleFrame(run: () => void): () => void {
    this.frame = run;
    return () => {
      if (this.frame === run) this.frame = undefined;
    };
  }

  scheduleAfter(delayMs: number, run: () => void): () => void {
    this.fallbackDelay = delayMs;
    this.fallback = run;
    return () => {
      if (this.fallback === run) this.fallback = undefined;
    };
  }

  runFrame(): void {
    this.frame?.();
  }

  runFallback(): void {
    this.fallback?.();
  }
}

test("the first frame publishes one coalesced delta batch and cancels the fallback", () => {
  const runtime = new ManualIngressRuntime();
  const batches: Array<readonly ZoneMsg[]> = [];
  const ingress = createTranscriptIngress((batch) => batches.push(batch), runtime);

  ingress.accept({ type: "text_delta", text: "hel" });
  ingress.accept({ type: "text_delta", text: "lo" });
  assert.equal(batches.length, 0);
  assert.equal(runtime.fallbackDelay, 50);

  runtime.runFrame();
  assert.deepEqual(batches, [[{ type: "text_delta", text: "hello" }]]);
  assert.equal(runtime.frame, undefined);
  assert.equal(runtime.fallback, undefined);
});

test("running tool output waits for one frame instead of repainting per chunk", () => {
  const runtime = new ManualIngressRuntime();
  const batches: Array<readonly ZoneMsg[]> = [];
  const ingress = createTranscriptIngress((batch) => batches.push(batch), runtime);

  ingress.accept({ type: "tool_output_delta", id: "c1", text: "one\n" });
  ingress.accept({ type: "tool_output_delta", id: "c1", text: "two\n" });
  assert.equal(batches.length, 0);
  runtime.runFrame();
  assert.deepEqual(batches, [
    [{ type: "tool_output_delta", id: "c1", text: "one\ntwo\n" }],
  ]);
});

test("the 50 ms fallback publishes when no animation frame arrives", () => {
  const runtime = new ManualIngressRuntime();
  const batches: Array<readonly ZoneMsg[]> = [];
  const ingress = createTranscriptIngress((batch) => batches.push(batch), runtime);

  ingress.accept({ type: "thinking_delta", text: "wait" });
  runtime.runFallback();
  assert.deepEqual(batches, [[{ type: "thinking_delta", text: "wait" }]]);
  assert.equal(runtime.frame, undefined);
  assert.equal(runtime.fallback, undefined);
});

test("every non-delta follows pending deltas in one ordered batch, even when transcript-inert", () => {
  const runtime = new ManualIngressRuntime();
  const batches: Array<readonly ZoneMsg[]> = [];
  const ingress = createTranscriptIngress((batch) => batches.push(batch), runtime);

  ingress.accept({ type: "text_delta", text: "before" });
  ingress.accept({ type: "status", state: "thinking" });
  assert.deepEqual(batches, [
    [
      { type: "text_delta", text: "before" },
      { type: "status", state: "thinking" },
    ],
  ]);
  assert.equal(runtime.frame, undefined);
  assert.equal(runtime.fallback, undefined);
});

test("dispose cancels scheduled work, drops queued deltas, and ignores later messages", () => {
  const runtime = new ManualIngressRuntime();
  const batches: Array<readonly ZoneMsg[]> = [];
  const ingress = createTranscriptIngress((batch) => batches.push(batch), runtime);

  ingress.accept({ type: "text_delta", text: "discard" });
  ingress.dispose();
  runtime.runFrame();
  runtime.runFallback();
  ingress.accept({ type: "user_prompt", text: "also discarded" });

  assert.deepEqual(batches, []);
  assert.equal(runtime.frame, undefined);
  assert.equal(runtime.fallback, undefined);
});

test("attach history publishes once at its boundary despite frames and timers between messages", () => {
  const runtime = new ManualIngressRuntime();
  const batches: Array<readonly ZoneMsg[]> = [];
  const ingress = createTranscriptIngress((batch) => batches.push(batch), runtime);
  const history: ZoneMsg[] = [
    { type: "session_created", sessionId: "one", cwd: "/w", replayPending: true },
    { type: "user_prompt", text: "old question", replay: true },
    { type: "text_delta", text: "old answer", replay: true },
    { type: "turn_end", replay: true },
    { type: "user_prompt", text: "latest question", replay: true },
    { type: "text_delta", text: "latest answer", replay: true },
  ];
  for (const message of history) {
    ingress.accept(message);
    runtime.runFrame();
    runtime.runFallback();
    assert.deepEqual(batches, [], "partial history must not become visible");
  }
  ingress.accept({ type: "replay_complete" });
  assert.deepEqual(batches, [history]);
  ingress.accept({ type: "text_delta", text: " live continuation" });
  assert.equal(batches.length, 1);
  runtime.runFrame();
  assert.deepEqual(batches[1], [{ type: "text_delta", text: " live continuation" }]);
});

test("an interrupted replay keeps its prefix on resume and discards it on a full reset", () => {
  for (const resumed of [true, false]) {
    const batches: Array<readonly ZoneMsg[]> = [];
    const ingress = createTranscriptIngress((batch) => batches.push(batch), new ManualIngressRuntime());
    ingress.accept({ type: "session_created", sessionId: "one", cwd: "/w", replayPending: true });
    ingress.accept({ type: "text_delta", text: "prefix", replay: true });
    if (!resumed) ingress.accept({ type: "zone_reset" });
    ingress.accept({ type: "session_created", sessionId: "one", cwd: "/w", replayPending: true, resumed });
    ingress.accept({ type: "text_delta", text: "tail", replay: true });
    ingress.accept({ type: "replay_complete" });
    const text = batches.flat().filter((m) => m.type === "text_delta").map((m) => m.text);
    assert.deepEqual(text, resumed ? ["prefix", "tail"] : ["tail"]);
  }
});

test("empty replay completes, old daemons render without a marker, and disposed replay never publishes", () => {
  const runtime = new ManualIngressRuntime();
  const batches: Array<readonly ZoneMsg[]> = [];
  const ingress = createTranscriptIngress((batch) => batches.push(batch), runtime);
  const created = { type: "session_created", sessionId: "one", cwd: "/w" } as const;
  ingress.accept({ ...created, replayPending: true });
  ingress.accept({ type: "replay_complete" });
  assert.equal(batches.length, 1);
  ingress.accept(created);
  ingress.accept({ type: "text_delta", text: "legacy history", replay: true });
  runtime.runFrame();
  assert.equal(batches.length, 3);
  ingress.accept({ ...created, replayPending: true });
  ingress.accept({ type: "text_delta", text: "discard", replay: true });
  ingress.dispose();
  ingress.accept({ type: "replay_complete" });
  assert.equal(batches.length, 3);
});
