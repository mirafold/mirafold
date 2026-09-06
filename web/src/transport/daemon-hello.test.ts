import { test } from "node:test";
import assert from "node:assert/strict";
import { daemonInfoFrom, withEntitlement, type AgentsHello } from "./daemon-hello";
import { admitWireFrame } from "./ws";

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


test("legacy and Desktop hellos pass the unchanged wire parser; only the literal Desktop host is retained", () => {
  for (const host of [undefined, "desktop", "future-host", true, { name: "desktop" }]) {
    // Absence is the pre-DA hello fixture, still accepted by both the wire
    // parser and hello state. Unknown future values must not select Desktop.
    const frame = JSON.parse(JSON.stringify({ ...hello(), host }));
    const admitted = admitWireFrame(frame);
    assert.ok(admitted && admitted.type === "agents");
    const info = daemonInfoFrom(admitted);
    assert.equal(Object.hasOwn(info, "host"), host === "desktop");
    assert.equal(info.host, host === "desktop" ? "desktop" : undefined);
    assert.deepEqual(info.agents, []);
  }
});

test("a new hello drops a held Desktop host; entitlement messages cannot establish or replace it", () => {
  const desktop = daemonInfoFrom(hello({ host: "desktop" }));
  const forged = JSON.parse('{"type":"entitlement","state":"valid","host":"desktop"}');
  assert.equal(withEntitlement(daemonInfoFrom(hello()), forged).host, undefined);
  assert.equal(withEntitlement(desktop, { type: "entitlement", state: "valid" }).host, "desktop");
  const refreshed = daemonInfoFrom(hello());
  assert.equal(Object.hasOwn(refreshed, "host"), false);
  assert.equal(withEntitlement(refreshed, forged).host, undefined);
});

test("DA.4C: the new config-problem field maps only its exact value into current Pair state", () => {
  const current = admitWireFrame(JSON.parse(JSON.stringify({
    ...hello(),
    relayConfigProblem: "invalid-entitlement-token",
  })));
  assert.ok(current?.type === "agents");
  const info = daemonInfoFrom(current);
  assert.equal(info.relayOff, "invalid-entitlement-token");
  assert.equal(Object.hasOwn(info, "relayConfigProblem"), false);

  // Future values in either wire field are ignored rather than reaching an
  // exhaustiveness fallback as raw React text.
  for (const frame of [
    { ...hello(), relayConfigProblem: "future-problem" },
    { ...hello(), relayOff: "future-reason" },
  ]) {
    const admitted = admitWireFrame(JSON.parse(JSON.stringify(frame)));
    assert.ok(admitted?.type === "agents");
    const future = daemonInfoFrom(admitted);
    assert.equal(future.relayOff, undefined);
    assert.equal(Object.hasOwn(future, "relayConfigProblem"), false);
  }
});
