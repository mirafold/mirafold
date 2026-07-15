import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentName } from "./protocol";
import { allowedLocally, allowedOverRelay, type CredentialKind } from "./provider-policy";

// The whole matrix, cell by cell. This is the single source of truth for
// which credential runs where — if a provider's terms change, this test is the
// first thing that must change with it (R.4i).

const AGENTS: AgentName[] = ["claude-code", "codex", "gemini-cli"];
const KINDS: CredentialKind[] = ["api-key", "subscription", "local", "none"];

test("LOCAL use: api-key and local endpoints always run; none never does", () => {
  for (const agent of AGENTS) {
    assert.equal(allowedLocally(agent, "api-key"), true, `${agent} api-key`);
    assert.equal(allowedLocally(agent, "local"), true, `${agent} local`);
    assert.equal(allowedLocally(agent, "none"), false, `${agent} none`);
  }
});

test("LOCAL subscription: written bans honored; codex allowed as a DISCLOSED gray area", () => {
  // Anthropic + Google prohibit it in writing → refused outright. OpenAI has
  // no written permission either way but a visibly permissive posture, so the
  // disclosed-uncertainty rule (K.3 amendment, 2026-07-15) allows it locally —
  // the codex CONNECT_HINT must carry the uncertainty disclosure (asserted in
  // web/src/agents-meta.test.ts), and the relay still refuses it below.
  assert.equal(allowedLocally("codex", "subscription"), true, "disclosed-uncertainty rule");
  assert.equal(allowedLocally("claude-code", "subscription"), false, "Anthropic ToS ban");
  assert.equal(allowedLocally("gemini-cli", "subscription"), false, "Gemini ToS ban / tier cutoff");
});

test("RELAY: the terms gate refuses subscription only — api-key, local, demo pass", () => {
  for (const agent of AGENTS) {
    assert.equal(allowedOverRelay("api-key"), true);
    assert.equal(allowedOverRelay("local"), true);
    assert.equal(allowedOverRelay("none"), true, "a credential-less demo has no provider/ToS");
    // The key rule: even OpenAI's subscription — fine locally — is refused over
    // the paid relay (charging for remote access trips the reselling clauses).
    assert.equal(allowedOverRelay("subscription"), false, `${agent} subscription over relay`);
  }
});

test("RELAY: the gate is an allow-list — an unrecognized kind fails CLOSED (refused)", () => {
  // The gate guards a legal/reselling line, so a credential kind added in the
  // future must default to REFUSED, not allowed. Cast past the closed union to
  // prove the allow-list keeps an unknown kind off the relay.
  assert.equal(allowedOverRelay("some-future-kind" as CredentialKind), false);
  assert.equal(allowedOverRelay("" as CredentialKind), false);
});

test("every kind resolves to a boolean for every agent (no unreachable cell)", () => {
  for (const agent of AGENTS) {
    for (const kind of KINDS) {
      assert.equal(typeof allowedLocally(agent, kind), "boolean");
      assert.equal(typeof allowedOverRelay(kind), "boolean");
    }
  }
});
