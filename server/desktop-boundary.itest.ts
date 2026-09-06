import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WireMsg } from "./protocol";
import { waitFor } from "./testing/wait-for";
import { startRelay } from "../../mirafold-relay/src/relay";
import { RemoteClient } from "./relay/relay-test-client";
import { desktopDaemon, fakeDesktopBilling, assertDesktopSecretAbsent, fixtureFiles, type DesktopDaemon, DESKTOP_TEST_KEY as KEY, DESKTOP_TEST_AMBIENT as AMBIENT } from "./testing/desktop-harness";

async function localTurn(run: DesktopDaemon, sessionId?: string) {
  run.client.send(sessionId ? { type: "attach", sessionId } : { type: "create", agent: "claude-code", cwd: run.cwd });
  const created = await run.client.type("session_created") as Extract<WireMsg, { type: "session_created" }>;
  if (sessionId) assert.equal(created.sessionId, sessionId);
  run.client.send({ type: "prompt", text: "a local turn survives credential failure" });
  await run.client.type("turn_end");
  assert.ok(run.client.received.some((message) => message.type === "text_delta"));
  return created.sessionId;
}

test("DA.3: the real diagnostic sink redacts a reported Mirafold key", async (t) => {
  const run = await desktopDaemon(t);
  run.client.send({ type: "client_error", message: `DA.3 diagnostic ${KEY}` });
  await run.waitLog(/DA\.3 diagnostic/);
  assertDesktopSecretAbsent(run);
  assert.match(run.stderr(), /\[redacted-key\]/);
});

test("DA.3: a billing refusal cannot reflect the private key into local hello, subscription replies, or logs", async (t) => {
  const relay = await startRelay({ host: "127.0.0.1" });
  t.after(() => relay.close());
  const billing = await fakeDesktopBilling(t, () => ({ status: 403, body: { reason: `Refused ${KEY}: inactive` } }));
  const run = await desktopDaemon(t, { chunks: [KEY.slice(0, 9), KEY.slice(9)], env: {
    MIRAFOLD_RELAY_URL: `ws://127.0.0.1:${relay.port}`,
    MIRAFOLD_ENTITLEMENT_URL: billing.url,
  } });
  await run.waitLog(/entitlement refused/);
  run.client.send({ type: "refresh_agents" });
  const hello = await run.client.type("agents");
  assert.equal(hello.type === "agents" && hello.entitlement?.state, "invalid");
  for (const [i, type] of ["subscription_status", "subscription_cancel", "subscription_uncancel"].entries()) {
    run.client.send({ type, id: String(i) } as never);
    const reply = await run.client.type("subscription");
    assert.ok(reply.type === "subscription" && reply.error);
  }
  assertDesktopSecretAbsent(run);
});

test("DA.3: the private key buys a gated real-relay connection, encrypted pairing, and local subscription actions", async (t) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const exp = Math.floor(Date.now() / 1000) + 48 * 60 * 60;
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  const token = `${payload}.${sign(null, Buffer.from(payload), privateKey).toString("base64url")}`;
  const relay = await startRelay({ host: "127.0.0.1", entitlementPublicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64") });
  t.after(() => relay.close());
  const billing = await fakeDesktopBilling(t, (route) => ({ body: route.endsWith("/entitlement") ? { token, exp } : { status: "active" } }));
  const run = await desktopDaemon(t, { chunks: [KEY.slice(0, 1), KEY.slice(1, 19), KEY.slice(19)], env: {
    MIRAFOLD_RELAY_URL: `ws://127.0.0.1:${relay.port}`,
    MIRAFOLD_ENTITLEMENT_URL: billing.url,
  } });
  await run.waitLog(/\[relay\] paired/);
  run.client.send({ type: "refresh_agents" });
  const hello = await run.client.type("agents") as Extract<WireMsg, { type: "agents" }>;
  assert.equal(hello.host, "desktop");
  assert.equal(hello.billing, "license-key");
  assert.equal(hello.entitlement?.state, "valid");
  assert.ok(hello.relay?.code, "the honest QR inputs must be available");
  const remote = await RemoteClient.connect(relay.port, hello.relay.code);
  t.after(() => remote.close());
  const remoteHello = await remote.type("agents");
  for (const field of ["host", "relay", "relayOff", "relayConfigProblem", "entitlement", "billing"]) assert.equal(Object.hasOwn(remoteHello, field), false, `remote hello carried ${field}`);
  remote.send({ type: "create", agent: "claude-code", cwd: run.cwd });
  const created = await remote.type("session_created");
  assert.equal(created.type === "session_created" && created.demo, true);
  remote.send({ type: "prompt", text: "hello over the encrypted Desktop relay" });
  await remote.type("turn_end");
  assert.ok(remote.received.some((message) => message.type === "text_delta"));
  for (const [i, type] of ["subscription_status", "subscription_cancel", "subscription_uncancel"].entries()) {
    run.client.send({ type, id: `local-${i}` } as never);
    const reply = await run.client.type("subscription");
    assert.equal(reply.type === "subscription" && reply.status, "active");
    const before = billing.requests.length;
    remote.send({ type, id: `remote-${i}` } as never);
    const refused = await remote.type("subscription");
    assert.equal(refused.type === "subscription" && refused.error, "no subscription is configured on this daemon");
    assert.equal(billing.requests.length, before, "a remote billing request reached the service");
  }
  assert.ok(billing.requests.length >= 4);
  assert.ok(billing.requests.every((request) => request.key === KEY));
  await run.stop();
  assertDesktopSecretAbsent(run, [KEY, token], remote.received);
});

test("DA.3: every rejected private-input class leaves local sessions usable and never falls back to an ambient key", async (t) => {
  const cases = [
    { name: "empty EOF", chunks: [] },
    { name: "early EOF", chunks: [KEY.slice(0, 12)] },
    { name: "newline", chunks: [KEY, "\n"] },
    { name: "invalid UTF-8", chunks: [Buffer.from([0xff]), KEY] },
    { name: "oversized", chunks: [KEY, "z".repeat(100_000)] },
    { name: "missing EOF", chunks: [KEY.slice(0, 8), KEY.slice(8)], eof: false },
    { name: "non-pipe input", chunks: [], ignoreStdin: true },
  ];
  for (const { name, ...options } of cases) await t.test(name, async (t) => {
    const billing = await fakeDesktopBilling(t, () => ({ body: { status: "active" } }));
    const run = await desktopDaemon(t, { ...options, env: { MIRAFOLD_LICENSE_KEY: AMBIENT, MIRAFOLD_ENTITLEMENT_URL: billing.url } });
    assert.equal(run.hello.host, "desktop");
    assert.equal(run.hello.billing, undefined);
    assert.equal(run.hello.relayOff, "unentitled");
    await localTurn(run);
    await run.stop();
    assert.deepEqual(billing.requests, []);
    assert.ok(fixtureFiles(path.join(run.root, "sessions")).length > 0);
    assertDesktopSecretAbsent(run, [KEY, AMBIENT]);
  });
});

test("DA.3: billing transport, parser, and service failures never disclose the key or prevent local turns", async (t) => {
  const relay = await startRelay({ host: "127.0.0.1" });
  t.after(() => relay.close());
  const cases = [
    { name: "bad request", reply: { status: 400, body: { error: `rejected ${KEY}` } } },
    { name: "service failure", reply: { status: 503, body: { reason: KEY } } },
    { name: "malformed JSON", reply: { raw: `{"reason":"${KEY}"` } },
    { name: "wrong JSON shape", reply: { body: { token: KEY, exp: KEY, status: { key: KEY } } } },
    { name: "oversized JSON", reply: { body: { padding: KEY.repeat(2_400) } } },
    { name: "closed connection", reply: { closeEarly: true } },
    { name: "request deadline", reply: { stall: true } },
  ];
  for (const { name, reply } of cases) await t.test(name, async (t) => {
    const billing = await fakeDesktopBilling(t, () => reply);
    const run = await desktopDaemon(t, { chunks: [KEY.slice(0, 10), KEY.slice(10)], env: {
      MIRAFOLD_RELAY_URL: `ws://127.0.0.1:${relay.port}`, MIRAFOLD_ENTITLEMENT_URL: billing.url,
    } });
    await waitFor(() => run.client.received.some((message) =>
      message.type === "entitlement" && message.state === "unreachable" ||
      message.type === "agents" && message.entitlement?.state === "unreachable"), "failed entitlement read", 15_000);
    for (const type of ["subscription_status", "subscription_cancel", "subscription_uncancel"] as const) {
      run.client.send({ type, id: type });
      const result = await run.client.type("subscription");
      assert.ok(result.type === "subscription" && result.error);
    }
    await localTurn(run);
    await run.stop();
    assert.ok(billing.requests.length >= 4);
    assertDesktopSecretAbsent(run);
  });
});

test("DA.3: restarting needs a fresh private pipe while the saved local session stays usable", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mirafold-desktop-restart-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const billing = await fakeDesktopBilling(t, () => ({ body: { status: "active" } }));
  const options = { root, env: { MIRAFOLD_RELAY_URL: "off", MIRAFOLD_ENTITLEMENT_URL: billing.url } };
  const first = await desktopDaemon(t, options);
  const sessionId = await localTurn(first);
  await first.stop();
  assertDesktopSecretAbsent(first);
  const second = await desktopDaemon(t, { ...options, chunks: [] });
  assert.equal(second.hello.billing, undefined, "a restart must not reload a saved key");
  await localTurn(second, sessionId);
  await second.stop();
  assertDesktopSecretAbsent(second);
  const third = await desktopDaemon(t, { ...options, chunks: [KEY.slice(0, 6), KEY.slice(6)] });
  assert.equal(third.hello.billing, "license-key");
  third.client.send({ type: "subscription_status", id: "restarted" });
  const result = await third.client.type("subscription");
  assert.equal(result.type === "subscription" && result.status, "active");
  await localTurn(third, sessionId);
  await third.stop();
  assertDesktopSecretAbsent(third);
});

for (const kind of ["uncaughtException", "unhandledRejection"]) {
  test(`DA.3: ${kind} crash text and the flight recorder remove a reflected key`, async (t) => {
    const run = await desktopDaemon(t, { imports: [path.resolve(import.meta.dirname, "testing/fixtures/desktop-crash.mjs")] });
    await localTurn(run);
    await fetch(`http://127.0.0.1:${run.port}/desktop-test-crash/${kind}`).catch(() => {});
    await waitFor(() => run.child.exitCode !== null, "expected fixture crash", 5_000);
    await run.stop();
    assert.equal(run.child.exitCode, 1);
    assert.match(run.stderr(), new RegExp(`crashed \\(${kind}\\)`));
    assert.match(run.stderr(), /\[redacted-key\]/);
    assertDesktopSecretAbsent(run);
  });
}
