import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionMsg } from "../protocol";
import { changesTranscriptTail, transcriptTail } from "./transcript-tail";

test("transcriptTail keeps the visible text in stream order", () => {
  const messages: SessionMsg[] = [
    { type: "user_prompt", text: "inspect the parser" },
    { type: "status", state: "thinking" },
    { type: "thinking_delta", text: "checking the grammar\n" },
    { type: "tool_use", name: "Read", detail: "parser.ts", id: "t1" },
    { type: "tool_result", output: "42 lines", id: "t1" },
    { type: "text_delta", text: "The parser is sound." },
  ];

  assert.deepEqual(transcriptTail(messages), {
    text:
      "❯ inspect the parser\nchecking the grammar\n\n[Read · parser.ts]\n\n42 lines\nThe parser is sound.",
  });
});

test("transcriptTail takes the bounded tail, marks the cut, and never splits a surrogate", () => {
  const messages: SessionMsg[] = [{ type: "text_delta", text: "😀abcdef" }];
  assert.deepEqual(transcriptTail(messages, 7), { text: "abcdef", truncated: true });
  assert.equal(transcriptTail(messages, 5)?.text, "bcdef");
});

test("transcriptTail omits stream plumbing and labels structured transcript records", () => {
  assert.equal(
    transcriptTail([
      { type: "status", state: "thinking" },
      { type: "usage", inputTokens: 1, outputTokens: 2 },
      { type: "turn_end" },
    ]),
    undefined,
  );
  assert.deepEqual(
    transcriptTail([
      { type: "render", component: "table", props: {}, id: "r1" },
      { type: "artifact", html: "<b>never copied</b>", id: "a1", title: "Report" },
    ]),
    { text: "[table painting]\n\n[Report]" },
  );
});

test("BUGHUNT: transcript completion and source-elision facts stay visible", () => {
  assert.deepEqual(
    transcriptTail([
      { type: "bang_start", command: "false", id: "b1" },
      { type: "bang_end", id: "b1", exitCode: 1 },
    ]),
    { text: "! false\n\n[exit 1]" },
  );
  assert.deepEqual(
    transcriptTail([{ type: "bang_end", id: "b2", exitCode: null }]),
    { text: "[killed]" },
  );
  assert.deepEqual(
    transcriptTail([{ type: "bang_end", id: "b3", exitCode: 0 }]),
    { text: "[done]" },
  );

  const capped = transcriptTail(
    [
      {
        type: "tool_result",
        output: "x".repeat(100),
        truncatedBytes: 4_096,
        id: "t1",
      },
    ],
    40,
  );
  assert.equal(capped?.truncated, true);
  assert.match(capped?.text ?? "", /⋯ 4096 bytes elided$/);
  assert.deepEqual(
    transcriptTail([{ type: "tool_result", output: "", truncatedBytes: 1, id: "t2" }]),
    { text: "⋯ 1 byte elided" },
  );
});

test("changesTranscriptTail uses the same inclusion rule as the projection", () => {
  assert.equal(changesTranscriptTail({ type: "text_delta", text: "live" }), true);
  assert.equal(changesTranscriptTail({ type: "bang_end", id: "b", exitCode: 1 }), true);
  assert.equal(
    changesTranscriptTail({ type: "tool_result", output: "", truncatedBytes: 8, id: "t" }),
    true,
  );
  assert.equal(changesTranscriptTail({ type: "turn_end" }), false);
});
