import assert from "node:assert/strict";
import { test } from "node:test";

import type { ZoneMsg } from "../transport/session-bus";
import {
  createTranscriptProjection,
  ORPHAN_BANG_COMMAND,
  type TextRow,
  type OutputZoneRow,
  type ToolRow,
  type ToolFoldItem,
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

test("notice leaves streams open; a terminal error closes text and settles thinking", () => {
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
  // The turn is over: the reasoning row is done, not left pulsing (PR #120
  // review) — its text is retained either way.
  assert.equal(rowsOf(atError, "thinking")[0]?.done, true);

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

const foldItemLabels = (fold: { items: readonly ToolFoldItem[] }) =>
  fold.items.map((item) =>
    item.kind === "tool" ? `tool:${item.tool.toolId}` : `thinking:${item.thinking.text}`,
  );

const READ = [{ kind: "read" as const, target: "a.ts" }];
const SEARCH = [{ kind: "search" as const, target: "needle" }];

test("R2: settled routine reads and searches become one meaningful group without reordering", () => {
  const projection = createTranscriptProjection();
  const snapshot = apply(
    projection,
    { type: "user_prompt", text: "work" },
    { type: "tool_use", id: "read", name: "Read", detail: "a.ts", actions: READ },
    { type: "tool_result", id: "read", output: "a" },
    { type: "thinking_delta", text: "next" },
    { type: "tool_use", id: "grep", name: "Grep", detail: "needle", actions: SEARCH },
    { type: "tool_result", id: "grep", output: "b" },
    { type: "tool_use", id: "read2", name: "Read", detail: "b.ts", actions: [{ kind: "read", target: "b.ts" }] },
    { type: "tool_result", id: "read2", output: "c" },
    { type: "turn_end" },
  );
  assert.deepEqual(rowKinds(snapshot), ["text", "tool-fold"]);
  const fold = rowsOf(snapshot, "tool-fold")[0]!;
  assert.equal(fold.actionCount, 3);
  assert.equal(fold.summary, "Read 2 files · 1 search");
  assert.deepEqual(fold.targets, ["a.ts", "needle", "b.ts"]);
  assert.equal(fold.live, false);
  assert.deepEqual(foldItemLabels(fold), ["tool:read", "thinking:next", "tool:grep", "tool:read2"]);
});

test("the group forms live: finished routine calls fold mid-turn, the in-flight call stays its own row, and turn_end only relabels", () => {
  const projection = createTranscriptProjection();
  const midTurn = apply(
    projection,
    { type: "user_prompt", text: "work" },
    { type: "tool_use", id: "read", name: "Read", actions: READ },
    { type: "tool_result", id: "read", output: "a" },
    { type: "tool_use", id: "grep", name: "Grep", actions: SEARCH },
    { type: "tool_result", id: "grep", output: "b" },
    { type: "tool_use", id: "read2", name: "Read", detail: "c.ts", actions: READ },
  );
  assert.deepEqual(rowKinds(midTurn), ["text", "tool-fold", "tool"]);
  const liveFold = rowsOf(midTurn, "tool-fold")[0]!;
  assert.equal(liveFold.live, true, "a group in a running turn is live");
  assert.equal(liveFold.actionCount, 2);
  assert.equal(rowsOf(midTurn, "tool")[0]?.output, undefined, "the running call is the visible row");

  const grown = apply(projection, { type: "tool_result", id: "read2", output: "ok" });
  assert.deepEqual(rowKinds(grown), ["text", "tool-fold"], "the finished routine call joins the group");
  assert.equal(rowsOf(grown, "tool-fold")[0]?.actionCount, 3);
  assert.equal(rowsOf(grown, "tool-fold")[0]?.id, liveFold.id, "the group keeps its anchor identity");

  const settled = apply(projection, { type: "turn_end" });
  const fold = rowsOf(settled, "tool-fold")[0]!;
  assert.equal(fold.live, false);
  assert.equal(fold.id, liveFold.id);
});

test("R1/R2: assistant prose of any length is a boundary — never absorbed; commands and edits stay their own rows", () => {
  const projection = createTranscriptProjection();
  const paragraph =
    "Here is a fuller account of what I found while reading the file. The protocol " +
    "module defines every message type and the two sides of the wire are additive-only, " +
    "so the next step is a careful read of the handlers.";
  const snapshot = apply(
    projection,
    { type: "user_prompt", text: "work" },
    { type: "tool_use", id: "read", name: "Read", actions: READ },
    { type: "tool_result", id: "read", output: "a" },
    { type: "tool_use", id: "grep", name: "Grep", actions: SEARCH },
    { type: "tool_result", id: "grep", output: "a" },
    { type: "text_delta", text: "Typecheck is clean — running lint next.", phase: "commentary" },
    { type: "tool_use", id: "lint", name: "Bash", detail: "yarn lint" },
    { type: "tool_result", id: "lint", output: "b", exitCode: 0, durationMs: 900 },
    { type: "text_delta", text: paragraph },
    { type: "tool_use", id: "edit", name: "Edit", detail: "a.ts", input: { file_path: "a.ts", old_string: "x", new_string: "y" } },
    { type: "tool_result", id: "edit", output: "ok" },
    { type: "tool_use", id: "test", name: "Bash", detail: "yarn test" },
    { type: "tool_result", id: "test", output: "1 failing", exitCode: 1 },
    { type: "tool_use", id: "r3", name: "Read", actions: READ },
    { type: "tool_result", id: "r3", output: "c" },
    { type: "tool_use", id: "r4", name: "Read", actions: READ },
    { type: "tool_result", id: "r4", output: "d" },
    { type: "turn_end" },
  );
  assert.deepEqual(rowKinds(snapshot), ["text", "tool-fold", "text", "tool", "text", "tool", "tool", "tool-fold"]);
  const texts = rowsOf(snapshot, "text").map((row) => row.text);
  assert.equal(texts[1], "Typecheck is clean — running lint next.", "a short commentary remark keeps its own row");
  assert.equal(texts[2], paragraph, "the paragraph stays its own row");
  const tools = rowsOf(snapshot, "tool");
  assert.deepEqual(tools.map((t) => [t.name, t.exitCode, t.durationMs]), [["Bash", 0, 900], ["Edit", undefined, undefined], ["Bash", 1, undefined]]);
  const [first, second] = rowsOf(snapshot, "tool-fold");
  assert.deepEqual(foldItemLabels(first!), ["tool:read", "tool:grep"]);
  assert.deepEqual(foldItemLabels(second!), ["tool:r3", "tool:r4"]);
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
  assert.equal(endRow.silent, undefined, "a plain ! row carries no silent flag");
});

test("a silent (!!) bang row carries the flag from bang_start through its end", () => {
  const projection = createTranscriptProjection();
  const rows = apply(
    projection,
    { type: "bang_start", id: "s", command: "git status", silent: true },
    { type: "bang_output", id: "s", data: "clean" },
    { type: "bang_end", id: "s", exitCode: 0 },
  );
  const row = rowsOf(rows, "bang")[0]!;
  assert.deepEqual(
    { silent: row.silent, output: row.output, done: row.done },
    { silent: true, output: "clean", done: true },
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


test("engine-declared commentary is narration and the final answer never folds (TS.8)", () => {
  const projection = createTranscriptProjection();
  const long = "A long piece of narration. ".repeat(40); // far past the length heuristic
  const tool = (id: string) => [
    { type: "tool_use", name: "Shell", detail: "ls", id, input: {} },
    { type: "tool_result", output: "ok", id },
  ] as const;
  const result = projection.apply(
    [
      { type: "user_prompt", text: "go" },
      ...tool("t1"),
      { type: "text_delta", text: long, phase: "commentary" },
      ...tool("t2"),
      { type: "text_delta", text: "Short.", phase: "final" },
      ...tool("t3"),
      { type: "turn_end" },
    ] as ZoneMsg[],
    () => 0,
  );
  const rows = result.snapshot.rows;
  // R1: commentary of any length stays a readable row between the calls
  // (styled as commentary by its phase), and the answer keeps its own row.
  assert.ok(!rows.some((r) => r.kind === "tool-fold"), "commands never group, and prose never folds");
  const commentary = rows.find((r): r is TextRow => r.kind === "text" && r.role === "assistant" && r.text === long);
  assert.ok(commentary, "the commentary is present as its own row");
  assert.equal(commentary.phase, "commentary");
  const finalRow = rows.find((r): r is TextRow => r.kind === "text" && r.role === "assistant" && r.text === "Short.");
  assert.ok(finalRow, "the final answer is its own visible row");
  assert.equal(finalRow.phase, "final");
  assert.deepEqual(rowKinds(result.snapshot), ["text", "tool", "text", "tool", "text", "tool"]);
});

test("R4: task_update drives the deck's state; a finished spawn call is not the child finishing", () => {
  const projection = createTranscriptProjection();
  const spawned = apply(
    projection,
    { type: "user_prompt", text: "go" },
    { type: "tool_use", id: "cb1", name: "spawnAgent", detail: "Audit the watcher", input: { prompt: "Audit the watcher" } },
    { type: "task_update", id: "cb1", state: "running", label: "Audit the watcher" },
    { type: "tool_result", id: "cb1", output: "t-child: running", isError: false },
  );
  assert.deepEqual(rowKinds(spawned), ["text", "subagent-deck"]);
  let deck = rowsOf(spawned, "subagent-deck")[0]!;
  assert.deepEqual([deck.summary.state, deck.summary.reported, deck.summary.toolCount], ["running", true, 0]);
  const ended = apply(projection, { type: "turn_end" });
  deck = rowsOf(ended, "subagent-deck")[0]!;
  assert.equal(deck.summary.state, "running", "turn_end does not mark a reported-running task done or interrupted");
  const report = "Audit complete.\n" + "detail\n".repeat(10) + "FINAL: two findings.";
  const done = apply(projection, { type: "task_update", id: "cb1", state: "completed", label: "Audit the watcher", report });
  deck = rowsOf(done, "subagent-deck")[0]!;
  assert.deepEqual([deck.summary.state, deck.summary.resultLine, deck.summary.report?.text], ["done", "Audit complete.", report]);
  assert.ok(deck.summary.report!.text.endsWith("FINAL: two findings."), "the full report survives, not the first line");
  const failed = apply(projection, { type: "task_update", id: "cb1", state: "failed", label: "Audit the watcher", report: "boom" });
  assert.equal(rowsOf(failed, "subagent-deck")[0]!.summary.state, "failed", "a later failure is not rewritten by the earlier success");
});

test("R4: two concurrent children and a background job keep independent identities; a spawn with no engine word at turn end is unknown", () => {
  const projection = createTranscriptProjection();
  const snapshot = apply(
    projection,
    { type: "user_prompt", text: "go" },
    { type: "tool_use", id: "a", name: "Agent", input: { description: "one" } },
    { type: "tool_use", id: "b", name: "Agent", input: { description: "two" } },
    { type: "task_update", id: "a", state: "running", label: "one", agentType: "Explore" },
    { type: "task_update", id: "b", state: "running", label: "two" },
    // A background job the engine reports with no announcing call of its own.
    { type: "task_update", id: "task:bg", state: "running", label: "watch the build" },
    { type: "tool_use", id: "a1", name: "Grep", parentId: "a", actions: SEARCH },
    { type: "tool_result", id: "a1", output: "hit", parentId: "a" },
    { type: "task_update", id: "b", state: "failed", label: "two", report: "child exploded" },
    // A spawn the engine never reported on, still unsettled when the turn ends.
    { type: "tool_use", id: "c", name: "Agent", input: { description: "three" } },
    { type: "text_delta", text: "child c is working", parentId: "c" },
    { type: "turn_end" },
  );
  const decks = rowsOf(snapshot, "subagent-deck");
  assert.deepEqual(
    decks.map((d) => [d.task.toolId, d.summary.description, d.summary.state, d.summary.reported, d.summary.toolCount]),
    [
      ["a", "one", "running", true, 1],
      ["b", "two", "failed", true, 0],
      ["task:bg", "watch the build", "running", true, 0],
      ["c", "three", "unknown", true, 0],
    ],
  );
  assert.equal(decks[2]!.task.synthetic, true);
  assert.equal(decks[3]!.task.isError, undefined, "an unreported task is not fabricated as interrupted");
  // The real announcement for the background job fills its placeholder in.
  const announced = apply(projection, { type: "tool_use", id: "task:bg", name: "Bash", detail: "make watch" });
  const bg = rowsOf(announced, "subagent-deck").find((d) => d.task.toolId === "task:bg")!;
  assert.deepEqual([bg.task.name, bg.task.synthetic, bg.id], ["Bash", undefined, decks[2]!.id]);
});

test("PR #120 review: a partial task update keeps the report, duration, and identity; a terminal error settles the thinking row", () => {
  const projection = createTranscriptProjection();
  const snapshot = apply(
    projection,
    { type: "user_prompt", text: "go" },
    { type: "tool_use", id: "t1", name: "Agent", input: { description: "d" } },
    { type: "task_update", id: "t1", state: "running", label: "d", agentType: "Explore", action: "Grep" },
    { type: "task_update", id: "t1", state: "completed", label: "d", agentType: "Explore", report: "R", reportTail: "T", reportOmittedBytes: 3, elapsedMs: 9 },
    { type: "task_update", id: "t1", state: "completed" },
  );
  const deck = rowsOf(snapshot, "subagent-deck")[0]!;
  assert.deepEqual(deck.lifecycle, { state: "completed", label: "d", agentType: "Explore", report: "R", reportTail: "T", reportOmittedBytes: 3, elapsedMs: 9 });
  assert.equal(deck.summary.report?.text, "R");
  const errored = apply(projection, { type: "thinking_delta", text: "still…" }, { type: "error", message: "engine died" });
  assert.equal(rowsOf(errored, "thinking").at(-1)?.done, true, "a terminal error settles the open reasoning row");
  const scoped = apply(projection, { type: "thinking_delta", text: "again" }, { type: "error", message: "refused", terminal: false });
  assert.equal(rowsOf(scoped, "thinking").at(-1)?.done, false, "a request-scoped error ends nothing");
});

test("release review 0.10.0: a task running again after a terminal word is a new attempt — the old report and duration do not ride into it", () => {
  const projection = createTranscriptProjection();
  const failed = apply(
    projection,
    { type: "user_prompt", text: "go" },
    { type: "tool_use", id: "t1", name: "Agent", input: { description: "d" } },
    { type: "task_update", id: "t1", state: "running", label: "d" },
    { type: "task_update", id: "t1", state: "failed", report: "quota exceeded", elapsedMs: 9 },
  );
  assert.deepEqual(rowsOf(failed, "subagent-deck")[0]!.lifecycle, { state: "failed", label: "d", report: "quota exceeded", elapsedMs: 9 });
  // The anchor call itself settled with the launcher's output (an OpenCode
  // task call, a Codex collab call): not this attempt's report either.
  apply(projection, { type: "tool_result", id: "t1", output: "launched, first attempt" });
  // The restart lands five seconds later on the clock: the anchor's start
  // must move to it, or the live elapsed counter shows the first attempt's age.
  const restarted = projection.apply([{ type: "task_update", id: "t1", state: "running" }], () => NOW + 5_000).snapshot;
  const deck = rowsOf(restarted, "subagent-deck")[0]!;
  assert.deepEqual(deck.lifecycle, { state: "running", label: "d", restarted: true }, "running again carries the identity, not the failure");
  assert.equal(deck.summary.report, undefined, "the anchor's earlier output is not shown as this attempt's report");
  assert.equal(deck.task.startedAt, NOW + 5_000, "the live clock restarts with the attempt");
  const still = apply(projection, { type: "task_update", id: "t1", state: "running", action: "Grep" });
  assert.equal(rowsOf(still, "subagent-deck")[0]!.summary.report, undefined, "and stays hidden until this attempt reports");
  const done = apply(projection, { type: "task_update", id: "t1", state: "completed", report: "second time lucky" });
  assert.deepEqual(rowsOf(done, "subagent-deck")[0]!.lifecycle, { state: "completed", label: "d", report: "second time lucky" });
  // A partial frame while still running keeps carrying, as before.
  const again = apply(projection, { type: "task_update", id: "t1", state: "running", report: "progress" }, { type: "task_update", id: "t1", state: "running", action: "Grep" });
  assert.equal(rowsOf(again, "subagent-deck")[0]!.lifecycle?.report, "progress");
});

test("PR #120 review: an outcome replayed before its task anchor settles the placeholder instead of vanishing", () => {
  const projection = createTranscriptProjection();
  const snapshot = apply(
    projection,
    { type: "zone_reset" },
    { type: "tool_result", id: "sp1", output: "<task_result>CHILD DONE</task_result>", replay: true },
    { type: "task_update", id: "sp1", state: "completed", label: "probe child", report: "CHILD DONE", replay: true },
    { type: "turn_end", replay: true },
    { type: "replay_complete", evicted: true },
  );
  const decks = rowsOf(snapshot, "subagent-deck");
  assert.equal(decks.length, 1);
  assert.deepEqual([decks[0]!.task.synthetic, decks[0]!.task.output, decks[0]!.summary.state], [true, "<task_result>CHILD DONE</task_result>", "done"]);
  assert.equal(rowsOf(snapshot, "tool").filter((t) => t.orphaned).length, 0, "nothing is left over as an orphan");
});

test("PR #120 round 5: an orphaned child outcome whose parent deck was evicted too shows at the root", () => {
  const snapshot = apply(
    createTranscriptProjection(),
    { type: "zone_reset" },
    { type: "tool_result", id: "kid", output: "child done", parentId: "gone-parent", replay: true },
    { type: "turn_end", replay: true },
    { type: "replay_complete", evicted: true },
  );
  const rows = rowsOf(snapshot, "tool");
  assert.deepEqual(rows.map((r) => [r.toolId, r.orphaned, r.output]), [["kid", true, "child done"]], "visible, not hidden under an absent deck");
  assert.equal(rowsOf(snapshot, "subagent-deck").length, 0);
});

test("PR #120 round 4: a live reasoning row and its replayed twin share one disclosure key", () => {
  const live = apply(createTranscriptProjection(), { type: "user_prompt", text: "go", seq: 1 }, { type: "thinking_delta", text: "hmm", seq: 2 }, { type: "thinking_delta", text: " more", seq: 3 });
  const replayed = apply(createTranscriptProjection(), { type: "user_prompt", text: "go", seq: 1, replay: true }, { type: "thinking_delta", text: "hmm more", seq: 2, replay: true });
  assert.equal(rowsOf(live, "thinking")[0]?.wireKey, "seq:2");
  assert.equal(rowsOf(replayed, "thinking")[0]?.wireKey, "seq:2");
});

test("PR #120 round 3: a running task's child call survives the root turn end; a live-only orphan keeps running past replay end", () => {
  const projection = createTranscriptProjection();
  const snapshot = apply(
    projection,
    { type: "user_prompt", text: "go" },
    { type: "tool_use", id: "sp", name: "task", input: { description: "bg" } },
    { type: "task_update", id: "sp", state: "running", label: "bg" },
    { type: "tool_use", id: "c1", name: "bash", detail: "make", parentId: "sp" },
    { type: "tool_output_snapshot", id: "c1", revision: 1, head: "one\n", parentId: "sp" },
    { type: "turn_end" },
    { type: "tool_output_snapshot", id: "c1", revision: 2, head: "one\ntwo\n", parentId: "sp" },
  );
  const deck = rowsOf(snapshot, "subagent-deck")[0]!;
  const child = deck.items.find((i): i is ToolRow => i.kind === "tool" && i.toolId === "c1")!;
  assert.deepEqual([child.output, child.live?.head, deck.summary.currentAction], [undefined, "one\ntwo\n", "bash make"]);

  const late = createTranscriptProjection();
  const replayed = apply(
    late,
    { type: "zone_reset" },
    { type: "user_prompt", text: "go", replay: true },
    { type: "tool_output_snapshot", id: "gone", revision: 5, head: "partial", replay: true },
    { type: "replay_complete", evicted: true },
    { type: "tool_output_snapshot", id: "gone", revision: 6, head: "partial more" },
  );
  const orphan = rowsOf(replayed, "tool").find((t) => t.toolId === "gone")!;
  assert.deepEqual([orphan.orphaned, orphan.output, orphan.live?.revision], [true, undefined, 6], "replay end is not the call's end");
  const ended = apply(late, { type: "tool_result", id: "gone", output: "done", exitCode: 0 });
  assert.deepEqual([rowsOf(ended, "tool")[0]!.output, rowsOf(ended, "tool")[0]!.live], ["done", undefined]);
});

test("R7: head/tail results, snapshot revisions, and an interruption keep the observed evidence", () => {
  const projection = createTranscriptProjection();
  const live = apply(
    projection,
    { type: "user_prompt", text: "go" },
    { type: "tool_use", id: "c1", name: "Bash", detail: "make" },
    { type: "tool_output_delta", id: "c1", text: "legacy prefix" },
    { type: "tool_output_snapshot", id: "c1", revision: 2, head: "H", tail: "T2", omittedBytes: 5 },
    { type: "tool_output_snapshot", id: "c1", revision: 1, head: "H", tail: "T1", omittedBytes: 1 },
    { type: "tool_output_delta", id: "c1", text: " ignored once a snapshot exists" },
  );
  let row = rowsOf(live, "tool")[0]!;
  assert.deepEqual(row.live, { head: "H", tail: "T2", omittedBytes: 5, revision: 2 }, "an older revision never overwrites newer state");
  assert.equal(row.streamed, undefined);
  const settled = apply(projection, { type: "tool_result", id: "c1", output: "head", tail: "FAIL: 1 test", omittedBytes: 99, truncatedBytes: 111, exitCode: 1, durationMs: 3000 });
  row = rowsOf(settled, "tool")[0]!;
  assert.deepEqual([row.output, row.tail, row.omittedBytes, row.truncatedBytes, row.exitCode, row.durationMs, row.live], ["head", "FAIL: 1 test", 99, 111, 1, 3000, undefined]);

  const interrupted = apply(
    projection,
    { type: "tool_use", id: "c2", name: "Bash", detail: "sleep" },
    { type: "tool_output_snapshot", id: "c2", revision: 1, head: "started", tail: "still going", omittedBytes: 40 },
    { type: "turn_end" },
  );
  const cut = rowsOf(interrupted, "tool").find((t) => t.toolId === "c2")!;
  assert.deepEqual([cut.isError, cut.output, cut.tail, cut.omittedBytes], [true, "started", "still going\n(interrupted — no result)", 40]);
});

test("R7: an outcome whose opening was evicted becomes an explicit orphan record; evicted history is said once", () => {
  const projection = createTranscriptProjection();
  const replayed = apply(
    projection,
    { type: "zone_reset" },
    { type: "tool_result", id: "gone", output: "the build passed", exitCode: 0, replay: true },
    { type: "tool_output_snapshot", id: "gone2", revision: 3, head: "partial", replay: true },
    { type: "text_delta", text: "Build is green.", replay: true },
    { type: "turn_end", replay: true },
    { type: "replay_complete", evicted: true },
  );
  // Orphans sit at the top (after the notice): their openings are older than
  // everything retained, so the bottom would reorder history.
  assert.deepEqual(rowKinds(replayed), ["notice", "tool", "tool", "text"]);
  const notice = rowsOf(replayed, "notice")[0]!;
  assert.match(notice.text, /no longer retained/);
  const [gone, gone2] = rowsOf(replayed, "tool");
  assert.deepEqual([gone!.toolId, gone!.name, gone!.orphaned, gone!.output, gone!.exitCode, gone!.replayed], ["gone", "(earlier call)", true, "the build passed", 0, true]);
  assert.deepEqual([gone2!.toolId, gone2!.orphaned, gone2!.output, gone2!.isError], ["gone2", true, "partial", true]);
  // Said once: a second replay_complete adds nothing; a tool_result for a
  // known row is never treated as an orphan.
  const again = apply(projection, { type: "replay_complete", evicted: true }, { type: "tool_use", id: "k", name: "Read", actions: READ }, { type: "tool_result", id: "k", output: "x" }, { type: "turn_end" });
  assert.equal(rowsOf(again, "notice").length, 1);
  assert.equal(rowsOf(again, "tool").filter((t) => t.orphaned).length, 2);
});

test("a phase change starts a new prose row; trailing commentary keeps its phase for the narration style (TS.8)", () => {
  const projection = createTranscriptProjection();
  const result = projection.apply(
    [
      { type: "user_prompt", text: "go" },
      { type: "text_delta", text: "Looking… ", phase: "commentary" },
      { type: "text_delta", text: "Here it is.", phase: "final" },
      { type: "text_delta", text: " More.", phase: "final" },
      { type: "text_delta", text: "One more check.", phase: "commentary" },
      { type: "turn_end" },
    ] as ZoneMsg[],
    () => 0,
  );
  const texts = result.snapshot.rows.filter((r): r is TextRow => r.kind === "text" && r.role === "assistant");
  assert.deepEqual(
    texts.map((r) => [r.text, r.phase]),
    [
      ["Looking… ", "commentary"],
      ["Here it is. More.", "final"],
      ["One more check.", "commentary"],
    ],
  );
});


test("streamed tool output accumulates on the running row and the result closes it (TS.11)", () => {
  const projection = createTranscriptProjection();
  const result = projection.apply(
    [
      { type: "user_prompt", text: "go" },
      { type: "tool_use", name: "Shell", detail: "yarn test", id: "c1", input: {} },
      { type: "tool_output_delta", id: "c1", text: "running 1\n" },
      { type: "tool_output_delta", id: "c1", text: "running 2\n" },
      { type: "tool_output_delta", id: "nope", text: "orphan" },
    ] as ZoneMsg[],
    () => 0,
  );
  const running = result.snapshot.rows.find((r) => r.kind === "tool");
  assert.ok(running && running.kind === "tool");
  assert.equal(running.output, undefined);
  assert.equal(running.streamed, "running 1\nrunning 2\n");
  const done = projection.apply([{ type: "tool_result", id: "c1", output: "running 1\nrunning 2\nok\n" }] as ZoneMsg[], () => 0);
  const closed = done.snapshot.rows.find((r) => r.kind === "tool");
  assert.ok(closed && closed.kind === "tool");
  assert.equal(closed.output, "running 1\nrunning 2\nok\n");
});

test("a tool update refreshes structured input in place without reopening a completed row", () => {
  const projection = createTranscriptProjection();
  const result = projection.apply(
    [
      { type: "user_prompt", text: "go" },
      { type: "tool_use", name: "apply_patch", id: "p1", input: { changes: [] } },
      {
        type: "tool_update",
        id: "p1",
        detail: "Updated a.ts",
        input: { changes: [{ path: "a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b\n" }] },
      },
      { type: "tool_result", id: "p1", output: "Updated a.ts" },
      { type: "tool_update", id: "p1", detail: "must not replace settled input", input: { changes: [] } },
    ] as ZoneMsg[],
    () => 0,
  );
  const rows = result.snapshot.rows.filter((row): row is ToolRow => row.kind === "tool");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail, "Updated a.ts");
  assert.deepEqual(rows[0].input, {
    changes: [{ path: "a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b\n" }],
  });
  assert.equal(rows[0].output, "Updated a.ts");
});

test("streamed output survives an interruption and the settled row releases the copy (PR #80 review)", () => {
  const interrupted = createTranscriptProjection().apply(
    [
      { type: "user_prompt", text: "go" },
      { type: "tool_use", name: "Shell", detail: "sleep 99", id: "c1", input: {} },
      { type: "tool_output_delta", id: "c1", text: "tick 1\ntick 2\n" },
      { type: "turn_end" },
    ] as ZoneMsg[],
    () => 0,
  );
  const row = interrupted.snapshot.rows.find((r): r is ToolRow => r.kind === "tool");
  assert.ok(row, "the interrupted call stays a visible row");
  assert.equal(row.output, "tick 1\ntick 2\n\n(interrupted — no result)");
  assert.equal(row.isError, true);
  assert.equal(row.streamed, undefined, "the copy is released");

  const settled = createTranscriptProjection().apply(
    [
      { type: "user_prompt", text: "go" },
      { type: "tool_use", name: "Shell", detail: "ls", id: "c2", input: {} },
      { type: "tool_output_delta", id: "c2", text: "a\n" },
      { type: "tool_result", id: "c2", output: "a\nok\n" },
    ] as ZoneMsg[],
    () => 0,
  );
  const done = settled.snapshot.rows.find((r): r is ToolRow => r.kind === "tool");
  assert.ok(done);
  assert.equal(done.output, "a\nok\n");
  assert.equal(done.streamed, undefined, "the authoritative result releases the streamed copy");
});

test("subagent narration whose anchor row never arrived is shown inline, not dropped (release review 2026-09-01)", () => {
  const result = createTranscriptProjection().apply(
    [
      { type: "user_prompt", text: "go" },
      { type: "text_delta", text: "child says hi\n", parentId: "evicted-task" },
      { type: "turn_end" },
    ] as ZoneMsg[],
    () => 0,
  );
  const texts = result.snapshot.rows.filter((r): r is TextRow => r.kind === "text" && r.role === "assistant").map((r) => r.text);
  assert.deepEqual(texts, ["child says hi\n"]);
  // With the anchor present the same narration groups under it, as before.
  const anchored = createTranscriptProjection().apply(
    [
      { type: "user_prompt", text: "go" },
      { type: "tool_use", name: "Agent", detail: "delegate", id: "task", input: {} },
      { type: "text_delta", text: "child says hi\n", parentId: "task" },
      { type: "tool_result", output: "done", id: "task" },
      { type: "turn_end" },
    ] as ZoneMsg[],
    () => 0,
  );
  assert.equal(anchored.snapshot.rows.filter((r) => r.kind === "text" && r.role === "assistant").length, 0);
});

test("an orphaned subagent's reasoning is a thinking row, never the assistant speaking (cold review 2026-09-01)", () => {
  const result = createTranscriptProjection().apply(
    [
      { type: "user_prompt", text: "go" },
      { type: "thinking_delta", text: "secret child reasoning", parentId: "evicted-task" },
      { type: "turn_end" },
    ] as ZoneMsg[],
    () => 0,
  );
  const rows = result.snapshot.rows;
  assert.equal(rows.filter((r) => r.kind === "text" && r.role === "assistant").length, 0, "reasoning never reads as prose");
  assert.deepEqual(rows.filter((r) => r.kind === "thinking").map((r) => r.kind === "thinking" && r.text), ["secret child reasoning"]);
});

test("a turn that dies by error orphans anchorless narration the same as turn_end (review 2026-09-01)", () => {
  const result = createTranscriptProjection().apply(
    [
      { type: "user_prompt", text: "go" },
      { type: "text_delta", text: "child says hi\n", parentId: "evicted-task" },
      { type: "error", message: "adapter crashed" },
    ] as ZoneMsg[],
    () => 0,
  );
  const texts = result.snapshot.rows.filter((r): r is TextRow => r.kind === "text" && r.role === "assistant").map((r) => r.text);
  assert.deepEqual(texts, ["child says hi\n", "**Error:** adapter crashed"]);
});

test("a request-scoped error (terminal: false) ends no turn, so it orphans nothing (cold review 2026-09-01)", () => {
  const result = createTranscriptProjection().apply(
    [
      { type: "user_prompt", text: "go" },
      { type: "text_delta", text: "child hi\n", parentId: "task" },
      { type: "error", message: "requests are arriving too fast", terminal: false },
      { type: "tool_use", name: "Agent", detail: "delegate", id: "task", input: {} },
      { type: "tool_result", output: "done", id: "task" },
      { type: "turn_end" },
    ] as ZoneMsg[],
    () => 0,
  );
  const rows = result.snapshot.rows;
  assert.equal(rows.filter((r) => r.kind === "text" && r.role === "assistant" && r.text.startsWith("child")).length, 0, "not narrated inline");
  assert.equal(rows.filter((r) => r.kind === "subagent-deck").length, 1, "grouped under its anchor once it lands");
});

// PR #125 review: the restart mark must survive a full replay (the ring
// coalesces the terminal frame away and marks the lone running frame), a
// reportless terminal frame, and a tail-resumed restart must not start a
// live clock at reconnection time.
test("a restart replayed as one marked running frame, or settled without a report, still hides the anchor's old output; a tail-replayed restart shows no live clock", () => {
  const replayed = createTranscriptProjection();
  const afterReplay = apply(
    replayed,
    { type: "user_prompt", text: "go", replay: true },
    { type: "tool_use", id: "t1", name: "Agent", input: { description: "d" }, replay: true },
    { type: "tool_result", id: "t1", output: "launched, first attempt", replay: true },
    { type: "task_update", id: "t1", state: "running", label: "d", attempt: 2, replay: true },
    { type: "replay_complete" },
  );
  const deck = rowsOf(afterReplay, "subagent-deck")[0]!;
  assert.equal(deck.summary.report, undefined, "the ring's mark keeps the anchor's old output out of the report");
  assert.equal(deck.summary.state, "running");

  const live = createTranscriptProjection();
  apply(
    live,
    { type: "user_prompt", text: "go" },
    { type: "tool_use", id: "t2", name: "Agent", input: { description: "d" } },
    { type: "tool_result", id: "t2", output: "launched, first attempt" },
    { type: "task_update", id: "t2", state: "failed", report: "quota exceeded" },
    { type: "task_update", id: "t2", state: "running" },
  );
  const settledQuiet = apply(live, { type: "task_update", id: "t2", state: "completed" });
  assert.equal(rowsOf(settledQuiet, "subagent-deck")[0]!.summary.report, undefined, "a reportless terminal frame does not revive the old output");

  const resumed = createTranscriptProjection();
  apply(
    resumed,
    { type: "user_prompt", text: "go" },
    { type: "tool_use", id: "t3", name: "Agent", input: { description: "d" } },
    { type: "task_update", id: "t3", state: "failed", report: "x" },
  );
  const tail = resumed.apply([{ type: "task_update", id: "t3", state: "running", replay: true }], () => NOW + 9_000).snapshot;
  assert.equal(rowsOf(tail, "subagent-deck")[0]!.task.replayed, true, "a tail-replayed restart's real time is unknown: no live clock");
});

// PR #125 round 3: `unknown` (the turn end's word for a task that never
// spoke) is not a terminal attempt; its first `running` is the same attempt.
test("a task's first running word after an unknown state is not a restart", () => {
  const projection = createTranscriptProjection();
  apply(
    projection,
    { type: "user_prompt", text: "go" },
    { type: "tool_use", id: "t1", name: "Agent", input: { description: "d" } },
    { type: "tool_result", id: "t1", output: "launched" },
    { type: "task_update", id: "t1", state: "unknown", label: "d" },
  );
  const running = projection.apply([{ type: "task_update", id: "t1", state: "running" }], () => NOW + 5_000).snapshot;
  const deck = rowsOf(running, "subagent-deck")[0]!;
  assert.equal(deck.lifecycle?.restarted, undefined);
  assert.equal(deck.summary.report?.text, "launched", "the anchor's output is still this attempt's evidence");
  assert.equal(deck.task.startedAt, NOW, "the clock is not reset");
});

// PR #125 round 4: a viewport that last saw the old attempt still running,
// then tail-resumes onto the ring's coalesced `running, attempt: 2` frame,
// must not carry that old attempt's progress report or clock either.
test("a wire-marked restart on a locally-running task drops the old attempt's report and clock", () => {
  const projection = createTranscriptProjection();
  apply(
    projection,
    { type: "user_prompt", text: "go" },
    { type: "tool_use", id: "t1", name: "Agent", input: { description: "d" } },
    { type: "task_update", id: "t1", state: "running", label: "d", report: "progress so far", elapsedMs: 40_000 },
  );
  const resumed = projection.apply([{ type: "task_update", id: "t1", state: "running", attempt: 2, replay: true }], () => NOW + 60_000).snapshot;
  const deck = rowsOf(resumed, "subagent-deck")[0]!;
  assert.deepEqual(deck.lifecycle, { state: "running", label: "d", restarted: true, attempt: 2, replayed: true });
  assert.equal(deck.summary.report, undefined);
  assert.equal(deck.task.replayed, true, "the restart time is unknown: no live clock");
});

// PR #125 round 5: the ring keeps the restart mark on every reportless frame
// of the new attempt, so a progress frame must not restart the clock again;
// and the old attempt's still-open child call must not become the new
// attempt's "current action".
test("a restarted attempt resets its clock once and retires the old attempt's open child call", () => {
  const projection = createTranscriptProjection();
  apply(
    projection,
    { type: "user_prompt", text: "go" },
    { type: "tool_use", id: "t1", name: "Agent", input: { description: "d" } },
    { type: "task_update", id: "t1", state: "running", label: "d" },
    { type: "tool_use", id: "c1", name: "Bash", detail: "sleep 99", parentId: "t1" },
    { type: "task_update", id: "t1", state: "failed", report: "boom" },
  );
  const restarted = projection.apply([{ type: "task_update", id: "t1", state: "running", attempt: 2 }], () => NOW + 5_000).snapshot;
  const deck = rowsOf(restarted, "subagent-deck")[0]!;
  assert.equal(deck.task.startedAt, NOW + 5_000);
  assert.notEqual(deck.summary.currentAction, "Bash sleep 99", "the old attempt's open call is not this attempt's action");
  const oldCall = deck.items.find((item) => item.kind === "tool" && item.toolId === "c1");
  assert.ok(oldCall && oldCall.kind === "tool" && /interrupted/.test(oldCall.output ?? ""), "the old attempt's call is retired with an honest outcome");
  // Two more reportless frames still carrying the ring's mark: no clock reset.
  const later = projection.apply([{ type: "task_update", id: "t1", state: "running", attempt: 2, action: "Grep" }], () => NOW + 30_000).snapshot;
  assert.equal(rowsOf(later, "subagent-deck")[0]!.task.startedAt, NOW + 5_000, "a progress frame does not restart the clock");
  const again = projection.apply([{ type: "task_update", id: "t1", state: "running", attempt: 2 }], () => NOW + 60_000).snapshot;
  assert.equal(rowsOf(again, "subagent-deck")[0]!.task.startedAt, NOW + 5_000);
});

// PR #125 round 6: a viewport that tail-resumes AFTER the new attempt has
// already reported sees a frame with a report and a new attempt number — it
// must still treat that as the boundary (fresh clock, old calls retired).
test("a resumed frame that already carries the new attempt's report is still an attempt boundary", () => {
  const projection = createTranscriptProjection();
  apply(
    projection,
    { type: "user_prompt", text: "go" },
    { type: "tool_use", id: "t1", name: "Agent", input: { description: "d" } },
    { type: "task_update", id: "t1", state: "running", label: "d" },
    { type: "tool_use", id: "c1", name: "Bash", detail: "sleep 99", parentId: "t1" },
  );
  const resumed = projection.apply([{ type: "task_update", id: "t1", state: "running", attempt: 2, report: "second attempt progress", replay: true }], () => NOW + 9_000).snapshot;
  const deck = rowsOf(resumed, "subagent-deck")[0]!;
  assert.equal(deck.summary.report?.text, "second attempt progress");
  assert.equal(deck.task.replayed, true, "replayed boundary: no live clock");
  assert.notEqual(deck.summary.currentAction, "Bash sleep 99", "the old attempt's open call was retired");
  const later = projection.apply([{ type: "task_update", id: "t1", state: "running", attempt: 2, action: "Grep" }], () => NOW + 20_000).snapshot;
  assert.equal(rowsOf(later, "subagent-deck")[0]!.summary.report?.text, "second attempt progress", "same attempt: the report carries");
});

// PR #125 round 8: on a full replay the ring's re-appended task frame trails
// the current attempt's own calls; a first-seen marked frame must not retire
// them as the "old attempt's" leftovers.
test("a full replay of a restarted task keeps the current attempt's open call running", () => {
  const projection = createTranscriptProjection();
  const replayed = apply(
    projection,
    { type: "user_prompt", text: "go", replay: true },
    { type: "tool_use", id: "t1", name: "Agent", input: { description: "d" }, replay: true },
    { type: "tool_result", id: "t1", output: "launched", replay: true },
    // The ring stamps a subagent's call with its attempt (round 9), so the
    // replayed current-attempt call says which attempt it belongs to.
    { type: "tool_use", id: "c2", name: "Bash", detail: "sleep 5", parentId: "t1", attempt: 2, replay: true },
    { type: "task_update", id: "t1", state: "running", label: "d", attempt: 2, replay: true },
    { type: "replay_complete" },
  );
  const deck = rowsOf(replayed, "subagent-deck")[0]!;
  assert.equal(deck.summary.currentAction, "Bash sleep 5", "the current attempt's call is still what the task is doing");
  assert.equal(deck.summary.report, undefined, "and the anchor's old output is still not this attempt's report");
});

// PR #125 round 9: on a tail resume the ring's re-appended task frame can
// trail the current attempt's call; the call carries its attempt, so the
// boundary retires only earlier attempts' open calls.
test("a resumed call stamped with the new attempt survives the boundary; the old attempt's call is retired", () => {
  const projection = createTranscriptProjection();
  apply(
    projection,
    { type: "user_prompt", text: "go" },
    { type: "tool_use", id: "t1", name: "Agent", input: { description: "d" } },
    { type: "task_update", id: "t1", state: "running", label: "d" },
    { type: "tool_use", id: "c1", name: "Bash", detail: "old attempt", parentId: "t1" },
  );
  // Disconnected through the failure and restart; the resume delivers the
  // new attempt's call (stamped) before the re-appended task frame.
  const resumed = projection.apply(
    [
      { type: "tool_use", id: "c2", name: "Bash", detail: "new attempt", parentId: "t1", attempt: 2, replay: true },
      { type: "task_update", id: "t1", state: "running", attempt: 2, replay: true },
    ],
    () => NOW + 5_000,
  ).snapshot;
  const deck = rowsOf(resumed, "subagent-deck")[0]!;
  assert.equal(deck.summary.currentAction, "Bash new attempt", "the current attempt's call is still running");
  const old = deck.items.find((item) => item.kind === "tool" && item.toolId === "c1");
  assert.ok(old && old.kind === "tool" && /interrupted/.test(old.output ?? ""), "the old attempt's call is retired");
});

// PR #125 round 10: a full replay of attempt 2 can still carry attempt 1's
// unanswered call; with calls carrying their attempt, the first-seen marked
// frame retires that older call while sparing attempt 2's.
test("a first-seen replayed attempt retires an older attempt's open call but not its own", () => {
  const projection = createTranscriptProjection();
  const replayed = apply(
    projection,
    { type: "user_prompt", text: "go", replay: true },
    { type: "tool_use", id: "t1", name: "Agent", input: { description: "d" }, replay: true },
    { type: "tool_use", id: "c1", name: "Bash", detail: "old attempt", parentId: "t1", replay: true },
    { type: "tool_use", id: "c2", name: "Bash", detail: "new attempt", parentId: "t1", attempt: 2, replay: true },
    { type: "task_update", id: "t1", state: "running", label: "d", attempt: 2, replay: true },
    { type: "replay_complete" },
  );
  const deck = rowsOf(replayed, "subagent-deck")[0]!;
  const old = deck.items.find((item) => item.kind === "tool" && item.toolId === "c1");
  assert.ok(old && old.kind === "tool" && /interrupted/.test(old.output ?? ""), "attempt 1's open call is retired");
  assert.equal(deck.summary.currentAction, "Bash new attempt", "attempt 2's call is what the task is doing");
});

// Release review 0.10.0 (fix round B): a terminal error ended the turn
// without settling it — the open batch and its in-flight calls stayed open,
// and the next prompt's calls were filed behind the abandoned batch, so the
// next turn_end settled the wrong batch and left the new turn's group live.
test("a terminal error settles the turn like turn_end: in-flight calls interrupt at once, the next turn's calls settle on its own turn_end, a trailing turn_end is harmless", () => {
  const projection = createTranscriptProjection();
  const routineTurn = (prefix: string) =>
    [
      { type: "tool_use", id: `${prefix}1`, name: "Read", detail: "a.ts", actions: READ },
      { type: "tool_result", id: `${prefix}1`, output: "a" },
      { type: "tool_use", id: `${prefix}2`, name: "Grep", detail: "needle", actions: SEARCH },
      { type: "tool_result", id: `${prefix}2`, output: "b" },
    ] as const;
  apply(projection, { type: "user_prompt", text: "work" }, { type: "tool_use", id: "A", name: "Bash" });
  const died = apply(projection, { type: "error", message: "engine died" });
  assert.deepEqual(rowKinds(died), ["text", "tool", "text"]);
  assert.deepEqual(
    rowsOf(died, "tool").map(({ output, isError }) => ({ output, isError })),
    [{ output: "(interrupted — no result)", isError: true }],
    "the in-flight call is interrupted at the error, not at some later turn_end",
  );
  const next = apply(projection, { type: "user_prompt", text: "again" }, ...routineTurn("B"));
  assert.equal(rowsOf(next, "tool-fold")[0]?.live, true, "the next turn's group is live while its turn runs");
  const ended = apply(projection, { type: "turn_end" });
  assert.equal(rowsOf(ended, "tool-fold")[0]?.live, false, "its own turn_end settles the next turn's calls — they were filed under the next turn, not the dead one");
  // A turn_end trailing the error (an adapter that sends both) changes nothing.
  const trailing = apply(
    projection,
    { type: "user_prompt", text: "once more" },
    { type: "tool_use", id: "C", name: "Bash" },
    { type: "error", message: "died again" },
    { type: "turn_end" },
  );
  assert.deepEqual(
    rowsOf(trailing, "tool").slice(-1).map(({ output, isError }) => ({ output, isError })),
    [{ output: "(interrupted — no result)", isError: true }],
  );
  assert.equal(rowKinds(trailing).length, rowKinds(ended).length + 3, "no extra rows from the trailing turn_end");
  const after = apply(projection, { type: "user_prompt", text: "still works" }, ...routineTurn("D"), { type: "turn_end" });
  assert.equal(rowsOf(after, "tool-fold").slice(-1)[0]?.live, false, "a turn after the trailing turn_end still settles its own calls");
});

test("a `!` command's output whose start was evicted becomes an orphan row that later frames still address", () => {
  const projection = createTranscriptProjection();
  const replayed = apply(
    projection,
    { type: "zone_reset" },
    { type: "bang_output", id: "b-gone", data: "line one\n", replay: true },
    { type: "bang_output", id: "b-gone", data: "line two\n", replay: true },
    { type: "replay_complete", evicted: true },
  );
  const [row] = rowsOf(replayed, "bang");
  assert.deepEqual([row!.bangId, row!.command, row!.output, row!.done], ["b-gone", ORPHAN_BANG_COMMAND, "line one\nline two\n", false]);
  assert.equal(rowsOf(replayed, "bang").length, 1, "one row, however many frames arrive before its end");

  const ended = apply(projection, { type: "bang_output", id: "b-gone", data: "done\n" }, { type: "bang_end", id: "b-gone", exitCode: 0 });
  const [closed] = rowsOf(ended, "bang");
  assert.deepEqual([closed!.output, closed!.done, closed!.exitCode], ["line one\nline two\ndone\n", true, 0]);

  // A command whose start WAS retained is never mistaken for an orphan.
  const known = apply(projection, { type: "bang_start", id: "b-k", command: "ls" }, { type: "bang_output", id: "b-k", data: "a\n" });
  assert.deepEqual(rowsOf(known, "bang").map((r) => [r.bangId, r.command]), [["b-gone", ORPHAN_BANG_COMMAND], ["b-k", "ls"]]);
});

test("an orphan `!` row takes its command and silent flag from the attach snapshot when the daemon gave one", () => {
  const projection = createTranscriptProjection();
  const seeded = apply(
    projection,
    { type: "session_created", sessionId: "s1", cwd: "/w", bang: { id: "b-run", command: "tail -f build.log", silent: true } },
    { type: "zone_reset" },
    { type: "bang_output", id: "b-run", data: "still building\n", replay: true },
    { type: "replay_complete", evicted: true },
  );
  const [row] = rowsOf(seeded, "bang");
  assert.deepEqual([row!.bangId, row!.command, row!.silent, row!.output, row!.done], ["b-run", "tail -f build.log", true, "still building\n", false]);
  // Output for a different evicted command still gets the honest placeholder.
  const other = apply(projection, { type: "bang_output", id: "b-old", data: "x\n", replay: true });
  assert.deepEqual(rowsOf(other, "bang").map((r) => [r.bangId, r.command, r.silent]), [["b-run", "tail -f build.log", true], ["b-old", ORPHAN_BANG_COMMAND, undefined]]);
});

test("a running `!` known only from the attach snapshot gets its row at replay_complete, so its end has a place to land", () => {
  const projection = createTranscriptProjection();
  const quiet = apply(
    projection,
    { type: "session_created", sessionId: "s1", cwd: "/w", bang: { id: "b-quiet", command: "sleep 600" } },
    { type: "zone_reset" },
    { type: "text_delta", text: "unrelated history", replay: true },
    { type: "turn_end", replay: true },
    { type: "replay_complete", evicted: true },
  );
  assert.deepEqual(rowsOf(quiet, "bang").map((r) => [r.bangId, r.command, r.done]), [["b-quiet", "sleep 600", false]]);
  const ended = apply(projection, { type: "bang_end", id: "b-quiet", exitCode: null });
  assert.deepEqual(rowsOf(ended, "bang").map((r) => [r.done, r.exitCode]), [[true, null]]);
  // With the start retained, replay_complete adds nothing.
  const fresh = createTranscriptProjection();
  const kept = apply(
    fresh,
    { type: "session_created", sessionId: "s1", cwd: "/w", bang: { id: "b-k", command: "ls" } },
    { type: "zone_reset" },
    { type: "bang_start", id: "b-k", command: "ls", replay: true },
    { type: "replay_complete" },
  );
  assert.equal(rowsOf(kept, "bang").length, 1);
});
