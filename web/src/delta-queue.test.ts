import { test } from "node:test";
import assert from "node:assert/strict";
import type { ZoneMsg } from "./session-bus";
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
