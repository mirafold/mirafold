import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTodos, resultText } from "./claude-code";
import { mcpText, extractRenderId } from "./codex";
import { parseRenderId } from "./gemini-cli";
import type { McpToolCallItem } from "@openai/codex-sdk";

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
  assert.equal(normalizeTodos({ todos: [] }), null);
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

test("extractRenderId prefers structured content, then parseable text, then the arg id", () => {
  assert.equal(
    extractRenderId({ result: { structured_content: { renderId: "sc-id" } } } as unknown as McpToolCallItem),
    "sc-id",
  );
  assert.equal(
    extractRenderId({
      result: { content: [{ type: "text", text: "Rendered card (id: abc12345)" }] },
    } as unknown as McpToolCallItem),
    "abc12345",
  );
  assert.equal(
    extractRenderId({ arguments: { id: "arg-id" } } as unknown as McpToolCallItem),
    "arg-id",
  );
});

test("parseRenderId reads the id from stub text, else a fresh uuid", () => {
  assert.equal(parseRenderId("Rendered card (id: deadbeef12)"), "deadbeef12");
  assert.match(parseRenderId("no id here"), /[0-9a-f-]{8,}/); // uuid fallback
});
