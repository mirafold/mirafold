import { test } from "node:test";
import assert from "node:assert/strict";
import { subagentSummary } from "./subagent-card";

// SA.1 — the card's calm-summary derivation. Pure data in, summary out; the
// component renders exactly what this returns, so pinning it here pins the
// card's one-glance truth without a DOM.

test("running: agent type, description, count, and the newest active call", () => {
  const s = subagentSummary(
    {
      name: "Task",
      detail: "trace the token path",
      input: { description: "trace the token path", subagent_type: "Explore" },
    },
    [
      { name: "Grep", detail: '-rn "token" .', output: "4 hits" },
      { name: "Read", detail: "server/relay/relay.ts" }, // no output — active
    ],
  );
  assert.equal(s.state, "running");
  assert.equal(s.agentType, "Explore");
  assert.equal(s.description, "trace the token path");
  assert.equal(s.toolCount, 2);
  assert.equal(s.currentAction, "Read server/relay/relay.ts");
  assert.equal(s.resultLine, undefined);
});

test("running with no active call still says it is working", () => {
  const s = subagentSummary(
    { name: "Task", input: { description: "d" } },
    [{ name: "Grep", detail: "x", output: "done" }],
  );
  assert.equal(s.state, "running");
  assert.equal(s.currentAction, "working…");
});

test("the NEWEST unanswered call wins over an older one", () => {
  const s = subagentSummary({ name: "Task", input: {} }, [
    { name: "Read", detail: "a.ts" }, // older, still open
    { name: "Grep", detail: "-rn foo" }, // newest open — what it's doing NOW
  ]);
  assert.equal(s.currentAction, "Grep -rn foo");
});

test("done: result line is the report's first line, verbatim and capped", () => {
  const s = subagentSummary(
    {
      name: "Agent",
      input: { description: "map sessions", subagent_type: "general-purpose" },
      output: "Sessions live in one registry.\nSecond line never shows.",
    },
    [{ name: "Grep", detail: "x", output: "hit" }],
  );
  assert.equal(s.state, "done");
  assert.equal(s.currentAction, undefined);
  assert.equal(s.resultLine, "Sessions live in one registry.");
  const long = subagentSummary(
    { name: "Agent", input: {}, output: "x".repeat(300) },
    [],
  );
  assert.equal(long.resultLine!.length, 121); // 120 + ellipsis
  assert.ok(long.resultLine!.endsWith("…"));
});

test("failed: an errored spawn reads failed, never done", () => {
  const s = subagentSummary(
    { name: "Task", input: { description: "d" }, output: "boom", isError: true },
    [],
  );
  assert.equal(s.state, "failed");
  assert.equal(s.resultLine, undefined);
});

test("description falls back input.description → detail → name; type absent stays absent", () => {
  assert.equal(subagentSummary({ name: "Task", detail: "the detail" }, []).description, "the detail");
  assert.equal(subagentSummary({ name: "task" }, []).description, "task");
  // OpenCode's task tool input uses `description` too but no subagent_type
  // guarantee — absence must not invent a type.
  assert.equal(subagentSummary({ name: "task", input: { description: "d" } }, []).agentType, undefined);
});

test("long action details are truncated with an explicit ellipsis", () => {
  const s = subagentSummary({ name: "Task" }, [{ name: "Bash", detail: "y".repeat(80) }]);
  assert.ok(s.currentAction!.startsWith("Bash "));
  assert.ok(s.currentAction!.endsWith("…"));
  assert.ok(s.currentAction!.length < 60);
});
