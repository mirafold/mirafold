import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLabel, connectHint } from "./agents-meta";

// "add an agent" must stay additive for old clients. A newer daemon can
// announce an agent name this bundle has never heard of; it must display as
// the raw string — never `undefined` — and simply carry no connect hint (R.4h).

test("known agents resolve to display labels and hints", () => {
  assert.equal(agentLabel("claude-code"), "Claude Code");
  assert.equal(agentLabel("codex"), "Codex");
  assert.equal(agentLabel("gemini-cli"), "Gemini CLI");
  assert.match(connectHint("codex")!, /codex login/);
});

test("an unknown agent name falls back to its raw string, hint-less", () => {
  assert.equal(agentLabel("aider"), "aider");
  assert.equal(connectHint("aider"), undefined);
});
