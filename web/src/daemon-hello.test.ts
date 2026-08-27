import { test } from "node:test";
import assert from "node:assert/strict";
import { NO_DAEMON_INFO, daemonInfoFrom, withEntitlement, type AgentsHello } from "./daemon-hello";

// Review 2026-08-26: the license-key read arrives as its own message after
// the hello, and the hello is re-sent every few seconds (refresh_agents). The
// shell must keep the read across a re-sent hello — but never inherit one
// from a daemon that no longer runs on a key.

const hello = (extra: Partial<AgentsHello> = {}): AgentsHello => ({
  type: "agents",
  agents: [],
  default: "claude-code",
  ...extra,
});

test("the read survives a re-sent hello from the same license-key daemon", () => {
  const held = withEntitlement(daemonInfoFrom(hello({ billing: "license-key" })), {
    type: "entitlement",
    state: "invalid",
    reason: "unknown license key",
  });
  assert.deepEqual(held.entitlement, { state: "invalid", reason: "unknown license key" });
  const again = daemonInfoFrom(hello({ billing: "license-key", version: "9.9.9" }), held);
  assert.deepEqual(again.entitlement, held.entitlement);
  assert.equal(again.version, "9.9.9");
});

test("a hello from a daemon without a key drops the stale read", () => {
  const held = withEntitlement(daemonInfoFrom(hello({ billing: "license-key" })), {
    type: "entitlement",
    state: "invalid",
  });
  // Relaunched with the key removed and a self-hosted relay: the QR must show.
  const relaunched = daemonInfoFrom(hello({ relay: { url: "http://127.0.0.1:1", code: "abcdefghijkl" } }), held);
  assert.equal(relaunched.entitlement, undefined);
  assert.equal(daemonInfoFrom(hello(), NO_DAEMON_INFO).entitlement, undefined);
});
