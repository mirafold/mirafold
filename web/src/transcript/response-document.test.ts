import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupResponseDocuments,
  type TranscriptDisplayItem,
} from "./response-document";
import type {
  OutputZoneRow,
  SubagentDeckRow,
  ToolRow,
} from "./transcript-projection";

const assistant = (id: number, text = `assistant ${id}`): OutputZoneRow => ({
  kind: "text",
  id,
  role: "assistant",
  text,
  done: false,
});

const user = (id: number, text = `user ${id}`): OutputZoneRow => ({
  kind: "text",
  id,
  role: "user",
  text,
  done: true,
});

const render = (id: number): OutputZoneRow => ({
  kind: "render",
  id,
  renderId: `render-${id}`,
  component: "card",
  props: { title: `card ${id}` },
});

const artifact = (id: number): OutputZoneRow => ({
  kind: "artifact",
  id,
  artifactId: `artifact-${id}`,
  html: `<p>${id}</p>`,
});

const documentItems = (items: readonly TranscriptDisplayItem[]) =>
  items.filter(
    (item): item is Extract<TranscriptDisplayItem, { kind: "response-document" }> =>
      item.kind === "response-document",
  );

test("assistant text becomes one response document immediately", () => {
  const row = assistant(1);
  const grouped = groupResponseDocuments([row]);

  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0], {
    kind: "response-document",
    key: 1,
    responseKey: 1,
    continuation: false,
    rows: [row],
  });
});

test("text, render, text, artifact, text stay in exact order and retain row references", () => {
  const rows = [assistant(1), render(2), assistant(3), artifact(4), assistant(5)];
  const original = [...rows];
  const grouped = groupResponseDocuments(rows);
  const documents = documentItems(grouped);

  assert.equal(documents.length, 1);
  assert.deepEqual(documents[0]!.rows, rows);
  documents[0]!.rows.forEach((row, index) => assert.strictEqual(row, rows[index]));
  assert.deepEqual(rows, original, "the source array was mutated");
});

test("a user prompt is a hard response boundary", () => {
  const before = assistant(1);
  const prompt = user(2);
  const after = assistant(3);
  const grouped = groupResponseDocuments([before, prompt, after]);

  assert.deepEqual(
    grouped.map((item) =>
      item.kind === "entry"
        ? [item.kind, item.row.id]
        : [item.kind, item.key, item.responseKey, item.continuation],
    ),
    [
      ["response-document", 1, 1, false],
      ["entry", 2],
      ["response-document", 3, 3, false],
    ],
  );
});

test("a bang command is a hard response boundary", () => {
  const bang: OutputZoneRow = {
    kind: "bang",
    id: 2,
    bangId: "bang-2",
    command: "pwd",
    output: "/workspace",
    done: true,
    exitCode: 0,
  };
  const grouped = groupResponseDocuments([assistant(1), bang, assistant(3)]);
  const documents = documentItems(grouped);

  assert.deepEqual(
    documents.map(({ key, responseKey, continuation }) => ({
      key,
      responseKey,
      continuation,
    })),
    [
      { key: 1, responseKey: 1, continuation: false },
      { key: 3, responseKey: 3, continuation: false },
    ],
  );
});

test("shell rows are soft interruptions outside documents without resetting response identity", () => {
  const task: ToolRow = {
    kind: "tool",
    id: 6,
    toolId: "task-6",
    name: "Agent",
    startedAt: 0,
  };
  const deck: SubagentDeckRow = {
    kind: "subagent-deck",
    id: 6,
    task,
    items: [],
    summary: {
      description: "inspect",
      state: "running",
      toolCount: 0,
      currentAction: "working…",
    },
  };
  const shells: OutputZoneRow[] = [
    { kind: "thinking", id: 2, text: "thinking", done: false },
    { kind: "tool", id: 3, toolId: "tool-3", name: "Read", startedAt: 0 },
    { kind: "tool-fold", id: 4, items: [], actionCount: 2, summary: "Read ×2", live: false },
    { kind: "notice", id: 5, text: "retrying", noticeKind: "retry" },
    deck,
    {
      kind: "picker",
      id: 7,
      pickerId: "picker-7",
      title: "Choose",
      rows: [],
      active: true,
    },
  ];
  const rows: OutputZoneRow[] = [assistant(1)];
  let nextAssistantId = 8;
  for (const shell of shells) {
    rows.push(shell, assistant(nextAssistantId++));
  }

  const grouped = groupResponseDocuments(rows);
  const documents = documentItems(grouped);

  assert.equal(documents.length, shells.length + 1);
  assert.ok(documents.every((document) => document.responseKey === 1));
  assert.equal(documents[0]!.continuation, false);
  assert.ok(documents.slice(1).every((document) => document.continuation));
  assert.deepEqual(
    grouped.filter((item) => item.kind === "entry").map((item) => item.row),
    shells,
  );
});

test("appending eligible rows preserves the existing segment and response keys", () => {
  const first = assistant(11);
  const painting = render(12);
  const before = documentItems(groupResponseDocuments([first, painting]))[0]!;
  const after = documentItems(
    groupResponseDocuments([first, painting, assistant(13)]),
  )[0]!;

  assert.equal(after.key, before.key);
  assert.equal(after.responseKey, before.responseKey);
  assert.strictEqual(after.rows[0], first);
  assert.strictEqual(after.rows[1], painting);
});

test("an update-in-place painting keeps its segment key and uses the newest projected row", () => {
  const initial = render(21);
  const updated: OutputZoneRow = {
    kind: "render",
    id: 21,
    renderId: "render-21",
    component: "card",
    props: { title: "updated card 21" },
  };
  const before = documentItems(groupResponseDocuments([initial]))[0]!;
  const after = documentItems(groupResponseDocuments([updated]))[0]!;

  assert.equal(after.key, before.key);
  assert.equal(after.responseKey, before.responseKey);
  assert.strictEqual(after.rows[0], updated);
  assert.notStrictEqual(after.rows[0], initial);
});
