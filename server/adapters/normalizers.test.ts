import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTodos, resultText } from "./claude-code/claude-code";
import { mcpText, extractRenderId, type CodexMcpToolCall } from "./codex/codex";
import { parseRenderId } from "./gemini-cli/gemini-cli";

test("normalizeTodos keeps valid items and defaults an unknown status to pending", () => {
  const out = normalizeTodos({
    todos: [
      { content: "a", status: "completed" },
      { content: "b", status: "bogus" },
      { content: "", status: "pending" }, // empty content is dropped
    ],
  });
  assert.deepEqual(out, [
    { content: "a", status: "completed" },
    { content: "b", status: "pending" },
  ]);
});

test("normalizeTodos returns null for non-todo input", () => {
  assert.equal(normalizeTodos(null), null);
  assert.equal(normalizeTodos({}), null);
});

// 2026-07-29 bughunt: a valid EMPTY TodoWrite is the agent clearing its
// list — it used to collapse to null (indistinguishable from junk), so the
// clear was skipped and deleted tasks lingered in the adapter's mirror.
test("normalizeTodos keeps a valid empty list distinct from junk", () => {
  assert.deepEqual(normalizeTodos({ todos: [] }), []);
});

test("resultText flattens strings, block arrays, and objects", () => {
  assert.equal(resultText("hi"), "hi");
  assert.equal(resultText([{ type: "text", text: "a" }, { type: "image" }]), "a\n[image]");
  assert.equal(resultText(null), "");
});

test("mcpText joins text blocks and stringifies the rest", () => {
  assert.equal(mcpText([{ type: "text", text: "x" }, { type: "text", text: "y" }]), "x\ny");
  assert.equal(mcpText("plain"), "plain");
  assert.equal(mcpText(null), "");
});

test("extractRenderId prefers structured content, then the arg id, then parseable text", () => {
  // The ack text carries whatever id the agent chose — not only a uuid
  // (update-in-place names ids like "deploy-status").
  assert.equal(
    extractRenderId({
      result: { content: [{ type: "text", text: "Rendered progress (id: deploy-status)" }] },
    } as CodexMcpToolCall),
    "deploy-status",
  );
  assert.equal(
    extractRenderId({ result: { content: [], structuredContent: { renderId: "sc-id" } } } as CodexMcpToolCall),
    "sc-id",
  );
  assert.equal(
    extractRenderId({
      result: { content: [{ type: "text", text: "Rendered card (id: abc12345)" }] },
    } as CodexMcpToolCall),
    "abc12345",
  );
  assert.equal(
    extractRenderId({ arguments: { id: "arg-id" } } as CodexMcpToolCall),
    "arg-id",
  );
});

test("parseRenderId reads the id from stub text, else a fresh uuid", () => {
  assert.equal(parseRenderId("Rendered card (id: deadbeef12)"), "deadbeef12");
  assert.match(parseRenderId("no id here"), /[0-9a-f-]{8,}/); // uuid fallback
});
