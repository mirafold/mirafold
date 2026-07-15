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
  // Disclosed-uncertainty rule (K.3 amendment, 2026-07-15): codex may
  // suggest `codex login`, but ONLY with the uncertainty stated — the hint
  // must never assert OpenAI permission, and must keep the API-key path.
  assert.match(connectHint("codex")!, /codex login/);
  assert.match(connectHint("codex")!, /not clearly permitted/);
  assert.match(connectHint("codex")!, /your account, your call/);
  assert.match(connectHint("codex")!, /OPENAI_API_KEY/);
  assert.doesNotMatch(connectHint("codex")!, /OpenAI permits/);
});

test("an unknown agent name falls back to its raw string, hint-less", () => {
  assert.equal(agentLabel("aider"), "aider");
  assert.equal(connectHint("aider"), undefined);
});
