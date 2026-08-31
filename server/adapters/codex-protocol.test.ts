import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CODEX_HANDLED_ITEMS,
  CODEX_HANDLED_METHODS,
  CODEX_IGNORED_ITEMS,
  CODEX_IGNORED_METHODS,
} from "./codex-events";

// The vendored digest of Codex's app-server protocol (scripts/
// codex-protocol-digest.mjs). The Tier-4 live test regenerates it from the
// installed Codex; this test holds the adapter to it offline.
type Digest = {
  items: Record<string, string[]>;
  notifications: string[];
  requests: string[];
  fields: Record<string, string>;
};
const digest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "codex-protocol.digest.json"), "utf8"),
) as Digest;

// Item kinds the adapter knows about but does not yet map — each one is
// reported to the user when it arrives (UnknownKindReporter), and each has a
// plan step. Shrinks as TS.8–TS.11 land; never grows silently.
const UNMAPPED_ITEMS_WITH_A_PLAN_STEP: Record<string, string> = {
  plan: "TS.8",
  collabAgentToolCall: "TS.9",
  subAgentActivity: "TS.9",
  imageView: "TS.10",
  imageGeneration: "TS.10",
  dynamicToolCall: "TS.9 — Codex apps/dynamic tools, shown as tool rows",
  enteredReviewMode: "TS.8 — review mode notice",
  exitedReviewMode: "TS.8 — review mode notice",
  hookPrompt: "TS.8 — a hook's prompt fragments",
  sleep: "TS.9 — the agent waiting on a timer",
};
const UNMAPPED_METHODS_WITH_A_PLAN_STEP: Record<string, string> = {
  "item/commandExecution/outputDelta": "TS.11",
  "item/fileChange/outputDelta": "TS.11",
  "item/fileChange/patchUpdated": "TS.11",
  "turn/diff/updated": "TS.11 — turn-level diff",
  "thread/compacted": "TS.8 — compaction notice (item form is handled)",
  "model/rerouted": "TS.8 — model reroute notice",
  "account/rateLimits/updated": "TS.8 — rate limits like Claude's",
  deprecationNotice: "TS.8 — engine notices",
  configWarning: "TS.8 — engine notices",
  guardianWarning: "TS.8 — engine notices",
};

test("every Codex thread-item kind is handled, deliberately ignored, or unmapped with a plan step", () => {
  const kinds = Object.keys(digest.items).sort();
  assert.ok(kinds.length >= 19, `digest lists ${kinds.length} item kinds`);
  for (const kind of kinds) {
    const placed =
      (CODEX_HANDLED_ITEMS as readonly string[]).includes(kind) ||
      kind in CODEX_IGNORED_ITEMS ||
      kind in UNMAPPED_ITEMS_WITH_A_PLAN_STEP;
    assert.ok(placed, `Codex item kind "${kind}" is neither handled, ignored, nor planned`);
  }
  // Nothing claimed that the protocol no longer has.
  for (const kind of [...CODEX_HANDLED_ITEMS, ...Object.keys(CODEX_IGNORED_ITEMS), ...Object.keys(UNMAPPED_ITEMS_WITH_A_PLAN_STEP)]) {
    assert.ok(kinds.includes(kind), `"${kind}" is in the adapter's ledger but not in Codex's protocol`);
  }
});

test("every Codex server notification is handled, deliberately ignored, or unmapped with a plan step", () => {
  assert.ok(digest.notifications.length >= 70);
  for (const method of digest.notifications) {
    const placed =
      (CODEX_HANDLED_METHODS as readonly string[]).includes(method) ||
      method in CODEX_IGNORED_METHODS ||
      method in UNMAPPED_METHODS_WITH_A_PLAN_STEP;
    assert.ok(placed, `Codex notification "${method}" is neither handled, ignored, nor planned`);
  }
  for (const method of [...CODEX_HANDLED_METHODS, ...Object.keys(CODEX_IGNORED_METHODS), ...Object.keys(UNMAPPED_METHODS_WITH_A_PLAN_STEP)]) {
    assert.ok(digest.notifications.includes(method), `"${method}" is in the adapter's ledger but not in Codex's protocol`);
  }
});

test("the field shapes the adapter reads are what the protocol says they are", () => {
  const f = digest.fields;
  // The bug class that hid a month of diffs: `kind` is an object with `type`.
  assert.equal(f["FileUpdateChange.kind"], "oneOf(add|delete|update)");
  assert.equal(f["FileUpdateChange.diff"], "string");
  assert.equal(f["FileUpdateChange.path"], "string");
  assert.match(f["ThreadItem.fileChange.changes"], /^array<FileUpdateChange:object\{diff,kind,path\}>$/);
  assert.equal(f["ThreadItem.commandExecution.command"], "string");
  assert.equal(f["ThreadItem.commandExecution.aggregatedOutput"], "string|null");
  assert.equal(f["ThreadItem.commandExecution.exitCode"], "integer|null");
  assert.match(f["ThreadItem.commandExecution.status"], /inProgress\|completed\|failed\|declined/);
  assert.equal(f["ThreadItem.agentMessage.text"], "string");
  assert.match(f["ThreadItem.agentMessage.phase"], /commentary.*final_answer/);
  assert.equal(f["ThreadItem.mcpToolCall.server"], "string");
  assert.equal(f["ThreadItem.mcpToolCall.tool"], "string");
  assert.match(f["ThreadItem.mcpToolCall.result"], /content,structuredContent/);
  assert.equal(f["CommandExecutionOutputDeltaNotification.delta"], "string");
});
