import { test } from "node:test";
import assert from "node:assert/strict";
import { agentLabel, backingLine, connectHint, localLiveHint } from "./agents-meta";

// "add an agent" must stay additive for old clients. A newer daemon can
// announce an agent name this bundle has never heard of; it must display as
// the raw string — never `undefined` — and simply carry no connect hint (R.4h).

test("known agents resolve to display labels and hints", () => {
  assert.equal(agentLabel("claude-code"), "Claude Agent");
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

// Hosted open models ride the same BYO mechanism as local ones; the copy must
// say so — and stay per-agent truthful. Both agents' configured endpoints now
// appear in the picker menu (claude's env ANTHROPIC_BASE_URL; codex's
// config.toml default provider, read by the daemon's codex-config.ts), so
// both hints promise it — and both name where the recipe lives.
test("connect hints name the hosted open-model route", () => {
  assert.match(connectHint("claude-code")!, /ANTHROPIC_BASE_URL/);
  assert.match(connectHint("claude-code")!, /DeepSeek/);
  assert.match(connectHint("codex")!, /config\.toml/);
  assert.match(connectHint("codex")!, /docs\/local-models\.md/);
});

test("the live hint's hosted clause is agent-specific and truthful", () => {
  assert.match(localLiveHint("claude-code"), /ANTHROPIC_BASE_URL/);
  assert.match(localLiveHint("claude-code"), /custom endpoint/);
  assert.match(localLiveHint("codex"), /config\.toml/);
  assert.match(localLiveHint("codex"), /appears here/);
  assert.match(localLiveHint("codex"), /docs\/local-models\.md/);
  // An unknown agent gets the base promise only — no agent-specific knobs.
  assert.doesNotMatch(localLiveHint("aider"), /ANTHROPIC_BASE_URL|config\.toml/);
});

// The one-click row must NAME its backing (2026-07-20). A single usable
// backend skips the second step — where the credential used to be named — so
// the row itself has to say it, in the second step's own vocabulary.
test("backingLine names the credential a one-click row would use", () => {
  assert.equal(backingLine("gemini-cli", "api-key", undefined), "Gemini API key");
  assert.equal(backingLine("claude-code", "api-key", "claude-sonnet-5"), "Claude API key · claude-sonnet-5");
  assert.equal(backingLine("codex", "subscription", undefined), "ChatGPT subscription");
  // A local detail already leads with its own label — never prefixed twice.
  assert.equal(backingLine("claude-code", "local", "local endpoint"), "local endpoint");
  assert.equal(backingLine("claude-code", "local", undefined), "local endpoint");
  // An older daemon sends no kind: the detail rides alone, exactly as before.
  assert.equal(backingLine("gemini-cli", undefined, "gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(backingLine("gemini-cli", undefined, undefined), undefined);
});
