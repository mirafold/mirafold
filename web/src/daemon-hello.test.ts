import { test } from "node:test";
import assert from "node:assert/strict";
import { daemonInfoFrom, withEntitlement, type AgentsHello } from "./daemon-hello";

// Review 2026-08-26 (twice): the license-key read must never outlive the
// daemon that produced it. It rides ON the hello, so every hello — the
// 3-second refresh_agents re-send included — states it whole; a hello
// without one drops what was held. Between hellos, the change message
// updates it in place.

const hello = (extra: Partial<AgentsHello> = {}): AgentsHello => ({
  type: "agents",
  agents: [],
  default: "claude-code",
  ...extra,
});

test("the read comes with the hello and a change message updates it in place", () => {
  const info = daemonInfoFrom(hello({ billing: "license-key", entitlement: { state: "checking" } }));
  assert.deepEqual(info.entitlement, { state: "checking" });
  const changed = withEntitlement(info, { type: "entitlement", state: "invalid", reason: "unknown license key" });
  assert.deepEqual(changed.entitlement, { state: "invalid", reason: "unknown license key" });
  assert.equal(changed.billing, "license-key");
});

test("a hello without a read drops the held one — whatever the hello says about billing", () => {
  // A relaunch that keeps the key but dials an ungated self-hosted relay
  // (billing still on, the exchange no longer the gate): the QR must show.
  const held = daemonInfoFrom(hello({ billing: "license-key", entitlement: { state: "invalid" } }));
  const relaunched = daemonInfoFrom(
    hello({ billing: "license-key", relay: { url: "http://127.0.0.1:1", code: "abcdefghijkl" } }),
  );
  assert.equal(relaunched.entitlement, undefined);
  assert.notEqual(held.entitlement, undefined);
});
