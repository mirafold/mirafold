import assert from "node:assert/strict";
import { test } from "node:test";

import type { ZoneMsg } from "./session-bus";
import {
  createTranscriptProjection,
  type OutputZoneRow,
  type TranscriptProjection,
  type TranscriptSnapshot,
} from "./transcript-projection";

const NOW = 1_000_000;

function apply(
  projection: TranscriptProjection,
  ...messages: ZoneMsg[]
): TranscriptSnapshot {
  return projection.apply(messages, () => NOW).snapshot;
}

const rowKinds = (snapshot: TranscriptSnapshot) => snapshot.rows.map((row) => row.kind);
const rowsOf = <K extends OutputZoneRow["kind"]>(snapshot: TranscriptSnapshot, kind: K) =>
  snapshot.rows.filter(
    (row): row is Extract<OutputZoneRow, { kind: K }> => row.kind === kind,
  );

test("ignored shell messages are inert; prompt and reset return ordered tail intents", () => {
  const projection = createTranscriptProjection();
  const initial = apply(projection);
  const ignored = projection.apply([{ type: "status", state: "thinking" }], () => NOW);
  assert.strictEqual(ignored.snapshot, initial);
  assert.deepEqual(ignored.tailIntents, []);

  const changed = projection.apply([{ type: "user_prompt", text: "hello" }], () => NOW);
  assert.deepEqual(changed.tailIntents, ["arm-follow"]);
  assert.deepEqual(rowKinds(changed.snapshot), ["text"]);

  const reset = projection.apply([{ type: "zone_reset" }], () => NOW);
  assert.deepEqual(reset.tailIntents, ["reset-tail"]);
  assert.deepEqual(reset.snapshot.rows, []);

  const ordered = projection.apply(
    [
      { type: "user_prompt", text: "again" },
      { type: "zone_reset" },
    ],
    () => NOW,
  );
  assert.deepEqual(ordered.tailIntents, ["arm-follow", "reset-tail"]);
  assert.deepEqual(ordered.snapshot.rows, []);
});

test("root text, thinking, and text preserve the existing open-stream behavior", () => {
  const projection = createTranscriptProjection();
  const snapshot = apply(
    projection,
    { type: "text_delta", text: "A" },
    { type: "thinking_delta", text: "B" },
    { type: "text_delta", text: "C" },
  );
  assert.deepEqual(rowKinds(snapshot), ["text", "thinking"]);
  assert.deepEqual(rowsOf(snapshot, "text").map(({ text, done }) => ({ text, done })), [
    { text: "AC", done: false },
  ]);
  assert.deepEqual(rowsOf(snapshot, "thinking").map(({ text, done }) => ({ text, done })), [
    { text: "B", done: true },
  ]);

  const ended = apply(projection, { type: "turn_end" });
  assert.equal(rowsOf(ended, "text")[0]?.done, true);
});

test("a user prompt arriving mid-stream does not detach the assistant reply tail", () => {
  const projection = createTranscriptProjection();
  const result = projection.apply(
    [
      { type: "text_delta", text: "A" },
      { type: "user_prompt", text: "queued" },
      { type: "text_delta", text: "B" },
    ],
    () => NOW,
  );
  assert.deepEqual(result.tailIntents, ["arm-follow"]);
  assert.deepEqual(rowsOf(result.snapshot, "text").map((row) => [row.role, row.text]), [
    ["assistant", "AB"],
    ["user", "queued"],
  ]);
});

test("notice leaves streams open; error closes text without folding thinking", () => {
  const projection = createTranscriptProjection();
  const noticed = apply(
    projection,
    { type: "text_delta", text: "A" },
    { type: "thinking_delta", text: "B" },
    { type: "notice", text: "retrying", kind: "retry" },
    { type: "text_delta", text: "C" },
  );
  assert.deepEqual(rowKinds(noticed), ["text", "thinking", "notice"]);
  assert.equal(rowsOf(noticed, "text")[0]?.text, "AC");
  assert.equal(rowsOf(noticed, "thinking")[0]?.done, true);

  const errors = createTranscriptProjection();
  const atError = apply(
    errors,
    { type: "text_delta", text: "before" },
    { type: "thinking_delta", text: "still open" },
    { type: "error", message: "boom" },
  );
  assert.equal(rowsOf(atError, "thinking")[0]?.done, false);

  const errored = apply(errors, { type: "text_delta", text: "after" });
  assert.deepEqual(rowsOf(errored, "text").map((row) => row.text), [
    "before",
    "**Error:** boom",
    "after",
  ]);
  assert.equal(rowsOf(errored, "thinking")[0]?.done, true);
});

test("parented prose keeps independent variant runs and true ledger chronology", () => {
  const projection = createTranscriptProjection();
  const hidden = apply(
    projection,
    { type: "text_delta", text: "A", parentId: "spawn" },
    { type: "thinking_delta", text: "B", parentId: "spawn" },
    { type: "text_delta", text: "C", parentId: "spawn" },
  );
  assert.equal(hidden.hasTranscriptContent, true);
  assert.deepEqual(hidden.rows, []);

  const snapshot = apply(
    projection,
    { type: "tool_use", id: "spawn", name: "Task", input: { description: "trace" } },
  );
  const deck = rowsOf(snapshot, "subagent-deck")[0];
  assert.ok(deck);
  assert.deepEqual(
    deck.items.map((item) => ({ kind: item.kind, text: item.kind === "subtext" ? item.text : undefined })),
    [
      { kind: "subtext", text: "AC" },
      { kind: "subtext", text: "B" },
    ],
  );
});

test("render and artifact updates retain position and key while preserving unrelated identities", () => {
  const projection = createTranscriptProjection();
  const before = apply(
    projection,
    { type: "text_delta", text: "intro" },
    { type: "render", id: "painting", component: "Meter", props: { value: 1 } },
    { type: "artifact", id: "artifact", html: "<p>one</p>", title: "A" },
  );
  const textBefore = rowsOf(before, "text")[0]!;
  const renderBefore = rowsOf(before, "render")[0]!;
  const artifactBefore = rowsOf(before, "artifact")[0]!;
  assert.strictEqual(before.paintingsById.get("painting"), renderBefore);
  assert.strictEqual(before.paintingsById.get("artifact"), artifactBefore);

  const after = apply(
    projection,
    { type: "render", id: "painting", component: "Meter", props: { value: 2 } },
  );
  const renderAfter = rowsOf(after, "render")[0]!;
  assert.equal(renderAfter.id, renderBefore.id);
  assert.notStrictEqual(renderAfter, renderBefore);
  assert.strictEqual(rowsOf(after, "text")[0], textBefore);
  assert.strictEqual(rowsOf(after, "artifact")[0], artifactBefore);
  assert.strictEqual(after.paintingsById.get("painting"), renderAfter);
  assert.deepEqual(rowKinds(after), ["text", "render", "artifact"]);

  const collisions = createTranscriptProjection();
  const collision = apply(
    collisions,
    { type: "render", id: "shared", component: "Meter", props: { value: 1 } },
    { type: "artifact", id: "shared", html: "<p>later</p>" },
  );
  assert.equal(collision.paintingsById.get("shared")?.kind, "render");
});

test("only the newest picker is active until the next user prompt", () => {
  const projection = createTranscriptProjection();
  const first = apply(projection, {
    type: "picker",
    id: "one",
    title: "One",
    rows: [{ label: "a", text: "a" }],
  });
  assert.equal(rowsOf(first, "picker")[0]?.active, true);

  const second = apply(projection, {
    type: "picker",
    id: "two",
    title: "Two",
    rows: [{ label: "b", text: "b" }],
  });
  assert.deepEqual(rowsOf(second, "picker").map((row) => row.active), [false, true]);

  const retired = apply(projection, { type: "user_prompt", text: "continue" });
  assert.deepEqual(rowsOf(retired, "picker").map((row) => row.active), [false, false]);
});

test("settled successful tools become a render-ready fold without reordering", () => {
  const projection = createTranscriptProjection();
  const snapshot = apply(
    projection,
    { type: "user_prompt", text: "work" },
    { type: "tool_use", id: "read", name: "Read", detail: "a.ts" },
    { type: "tool_result", id: "read", output: "a" },
    { type: "thinking_delta", text: "next" },
    { type: "tool_use", id: "grep", name: "Grep", detail: "needle" },
    { type: "tool_result", id: "grep", output: "b" },
    { type: "turn_end" },
  );
  assert.deepEqual(rowKinds(snapshot), ["text", "tool-fold"]);
  const fold = rowsOf(snapshot, "tool-fold")[0]!;
  assert.equal(fold.actionCount, 2);
  assert.equal(fold.summary, "Read · Grep");
  assert.deepEqual(
    fold.items.map((item) =>
      item.kind === "tool" ? `tool:${item.tool.toolId}` : `thinking:${item.thinking.text}`,
    ),
    ["tool:read", "thinking:next", "tool:grep"],
  );
});

test("failed and interrupted tools stay visible and never enter a fold", () => {
  const projection = createTranscriptProjection();
  const failed = apply(
    projection,
    { type: "user_prompt", text: "work" },
    { type: "tool_use", id: "bad", name: "Write" },
    { type: "tool_result", id: "bad", output: "denied", isError: true },
    { type: "tool_use", id: "lost", name: "Read" },
    { type: "turn_end" },
  );
  assert.deepEqual(rowKinds(failed), ["text", "tool", "tool"]);
  assert.equal("batchId" in rowsOf(failed, "tool")[0]!, false);
  assert.equal("settled" in rowsOf(failed, "tool")[0]!, false);
  assert.equal(rowsOf(failed, "tool")[0]?.isError, true);
  assert.deepEqual(
    rowsOf(failed, "tool").map(({ output, isError }) => ({ output, isError })),
    [
      { output: "denied", isError: true },
      { output: "(interrupted — no result)", isError: true },
    ],
  );
});

test("tool start time is read at each tool message and private settlement fields stay behind the seam", () => {
  const projection = createTranscriptProjection();
  const times = [100, 200];
  const snapshot = projection.apply(
    [
      { type: "tool_use", id: "one", name: "Read" },
      { type: "tool_use", id: "two", name: "Grep" },
    ],
    () => times.shift()!,
  ).snapshot;
  const tools = rowsOf(snapshot, "tool");
  assert.deepEqual(tools.map((tool) => tool.startedAt), [100, 200]);
  for (const tool of tools) {
    assert.equal("batchId" in tool, false);
    assert.equal("settled" in tool, false);
  }
});

test("queued prompts assign later tools to the oldest still-open turn", () => {
  const projection = createTranscriptProjection();
  apply(
    projection,
    { type: "user_prompt", text: "first" },
    { type: "user_prompt", text: "second" },
    { type: "tool_use", id: "first-tool", name: "Read" },
    { type: "tool_result", id: "first-tool", output: "one" },
    { type: "turn_end" },
  );
  const beforeSecondEnd = apply(
    projection,
    { type: "tool_use", id: "second-tool", name: "Grep" },
    { type: "tool_result", id: "second-tool", output: "two" },
  );
  assert.deepEqual(rowKinds(beforeSecondEnd), ["text", "text", "tool", "tool"]);

  const afterSecondEnd = apply(projection, { type: "turn_end" });
  assert.deepEqual(rowKinds(afterSecondEnd), ["text", "text", "tool", "tool"]);
  assert.equal(rowsOf(afterSecondEnd, "tool")[1]?.output, "two");
});

test("a subagent deck owns successful child activity; failed children remain top-level", () => {
  const projection = createTranscriptProjection();
  const snapshot = apply(
    projection,
    { type: "user_prompt", text: "delegate" },
    {
      type: "tool_use",
      id: "spawn",
      name: "Agent",
      input: { description: "trace", subagent_type: "Explore" },
    },
    { type: "text_delta", text: "before", parentId: "spawn" },
    { type: "tool_use", id: "child-ok", name: "Read", parentId: "spawn" },
    { type: "tool_result", id: "child-ok", output: "ok", parentId: "spawn" },
    { type: "thinking_delta", text: "after", parentId: "spawn" },
    { type: "tool_use", id: "child-bad", name: "Write", parentId: "spawn" },
    {
      type: "tool_result",
      id: "child-bad",
      output: "failed",
      isError: true,
      parentId: "spawn",
    },
    { type: "tool_result", id: "spawn", output: "done" },
    { type: "turn_end" },
  );
  assert.deepEqual(rowKinds(snapshot), ["text", "subagent-deck", "tool"]);
  const deck = rowsOf(snapshot, "subagent-deck")[0]!;
  assert.equal(deck.summary.agentType, "Explore");
  assert.equal(deck.summary.description, "trace");
  assert.equal(deck.summary.state, "done");
  assert.deepEqual(
    deck.items.map((item) => (item.kind === "tool" ? item.toolId : `${item.variant}:${item.text}`)),
    ["text:before", "child-ok", "thinking:after"],
  );
  assert.equal(rowsOf(snapshot, "tool")[0]?.toolId, "child-bad");
});

test("zone reset clears every hidden parent-prose cursor before replay", () => {
  const projection = createTranscriptProjection();
  apply(projection, { type: "text_delta", text: "stale", parentId: "spawn" });
  apply(projection, { type: "zone_reset" });
  const replayed = apply(
    projection,
    { type: "text_delta", text: "replayed", parentId: "spawn" },
    { type: "tool_use", id: "spawn", name: "Task", replay: true },
  );
  const deck = rowsOf(replayed, "subagent-deck")[0]!;
  assert.equal(deck.items[0]?.kind, "subtext");
  assert.equal((deck.items[0] as { text: string }).text, "replayed");
  assert.equal(deck.task.replayed, true);
});

test("bang start, output, and end update one stable row", () => {
  const projection = createTranscriptProjection();
  const started = apply(projection, { type: "bang_start", id: "b", command: "pwd" });
  const startRow = rowsOf(started, "bang")[0]!;
  const ended = apply(
    projection,
    { type: "bang_output", id: "b", data: "/tmp" },
    { type: "bang_end", id: "b", exitCode: 0 },
  );
  const endRow = rowsOf(ended, "bang")[0]!;
  assert.equal(endRow.id, startRow.id);
  assert.deepEqual(
    { output: endRow.output, done: endRow.done, exitCode: endRow.exitCode },
    { output: "/tmp", done: true, exitCode: 0 },
  );
});

test("unchanged rows retain identity; unmatched updates still publish like the existing state map", () => {
  const projection = createTranscriptProjection();
  const before = apply(
    projection,
    { type: "text_delta", text: "first" },
    { type: "render", id: "painting", component: "Meter", props: { value: 1 } },
  );
  const firstText = rowsOf(before, "text")[0]!;
  const painting = rowsOf(before, "render")[0]!;

  const after = apply(projection, { type: "text_delta", text: "second" });
  assert.strictEqual(rowsOf(after, "text")[0], firstText);
  assert.strictEqual(rowsOf(after, "render")[0], painting);

  const unmatched = apply(projection, { type: "tool_result", id: "missing", output: "x" });
  assert.notStrictEqual(unmatched, after);
  assert.equal(unmatched.revision, after.revision + 1);
  assert.strictEqual(unmatched.rows, after.rows);
  assert.strictEqual(unmatched.paintingsById, after.paintingsById);
});
