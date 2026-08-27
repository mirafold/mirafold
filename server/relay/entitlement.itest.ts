import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { WireMsg } from "../protocol";
import { startDaemon, TestClient } from "../testing/itest-harness";
import { startRelayStub } from "./relay-stub";
import { RemoteClient } from "./relay-test-client";

// Phase PB.2: the daemon's read on its own license key reaches LOCAL viewports
// (after the hello, and again on change) so the pair card can present on it —
// and never a remote one: billing is the business of the machine holding the
// key, and a paired phone is proof the relay carried it anyway.

type Any = WireMsg & Record<string, any>;
const CODE = "itest-entitlement-code-7b2e";

function billingStub(answer: (path: string) => { status: number; body: unknown }): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        const { status, body } = answer(req.url ?? "");
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

test("a refused license key reaches the local viewport as an `entitlement` read; a remote viewport never sees one", async () => {
  const stub = await startRelayStub({});
  const billing = await billingStub(() => ({ status: 403, body: { reason: "unknown license key" } }));
  const d = await startDaemon({
    MIRAFOLD_RELAY_URL: stub.url,
    MIRAFOLD_RELAY_CODE: CODE,
    MIRAFOLD_LICENSE_KEY: "mf_itest_bogus_key_000000000",
    MIRAFOLD_ENTITLEMENT_URL: `http://127.0.0.1:${billing.port}/api/entitlement`,
  });
  try {
    // The boot exchange is fire-and-forget; its warning line marks it landed.
    await d.waitForLog(/entitlement refused for license \[license key\]: unknown license key/, "refusal logged");
    await d.waitForLog(/\[relay\] paired/, "paired"); // the stub is ungated — the dial still lands

    const local = new TestClient(d.port);
    await local.opened();
    const hello = (await local.type("agents")) as Any;
    assert.equal(hello.billing, "license-key");
    const read = (await local.type("entitlement")) as Any;
    assert.deepEqual(read, { type: "entitlement", state: "invalid", reason: "unknown license key" });
    // The log line elided the key; so does the wire.
    assert.ok(!JSON.stringify(local.received).includes("mf_itest_bogus"), "the license key rode the wire");
    local.close();

    const remote = await RemoteClient.connect(stub.port, CODE);
    const rhello = (await remote.type("agents")) as Any;
    assert.equal(rhello.billing, undefined);
    assert.equal(rhello.relay, undefined);
    remote.send({ type: "ping" } as never);
    await remote.type("pong"); // a round-trip AFTER the hello: anything sent with it has arrived
    assert.ok(
      !remote.received.some((m) => m.type === "entitlement"),
      `remote viewport received an entitlement read: ${remote.received.map((m) => m.type).join(",")}`,
    );
    remote.close();
  } finally {
    await d.stop();
    await stub.stop();
    await new Promise((resolve) => billing.server.close(resolve));
  }
});
