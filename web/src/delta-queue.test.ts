import { test } from "node:test";
import assert from "node:assert/strict";
import { queueDelta, type QueuedDelta } from "./delta-queue";

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
