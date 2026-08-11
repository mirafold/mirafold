import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { relayRefusalReason, startRelayClient } from "./relay-client";
import type { SessionRegistry } from "../sessions/registry";
import {
  CLOSE_BAD_CODE,
  CLOSE_CODE_TAKEN,
  CLOSE_OVERLOADED,
  CLOSE_UNENTITLED,
  ENTITLEMENT_HEADER,
  isRelayToDaemon,
} from "./relay-protocol";

// The dial-out refusal map: a relay close code the daemon can EXPLAIN vs. a
// routine drop it just retries. Keeps the paying-user failure modes (bad token
// = 4007, relay full = 4004) from reading as a silent reconnect loop.
test("relayRefusalReason: known refusals get an actionable line", () => {
  assert.match(relayRefusalReason(CLOSE_UNENTITLED)!, /subscription/);
  assert.match(relayRefusalReason(CLOSE_OVERLOADED)!, /capacity/);
  assert.match(relayRefusalReason(CLOSE_CODE_TAKEN)!, /already held/);
});

test("relayRefusalReason: an ordinary drop is not a refusal (null → retry quietly)", () => {
  // A normal close (1000/1006) or a not-paired code is a connection loss, not a
  // refusal the user must act on — the caller falls back to the generic path.
  assert.equal(relayRefusalReason(1000), null); // normal close
  assert.equal(relayRefusalReason(1006), null); // abnormal/transport drop
  assert.equal(relayRefusalReason(CLOSE_BAD_CODE), null); // no daemon under that id — transient race
});

test("relay envelopes reject valid-JSON scalars and wrong-shaped objects", () => {
  for (const value of [null, true, "open", [], {}, { t: 1 }, { t: "open" }, { t: "frame", v: "v", p: 1 }]) {
    assert.equal(isRelayToDaemon(value), false, JSON.stringify(value));
  }
  assert.equal(isRelayToDaemon({ t: "ping" }), true);
  assert.equal(isRelayToDaemon({ t: "open", v: "v1" }), true);
  assert.equal(isRelayToDaemon({ t: "frame", v: "v1", p: "ciphertext" }), true);
  assert.equal(isRelayToDaemon({ t: "close", v: "v1" }), true);
});

test("a relay sending JSON null is ignored without escaping the socket handler", async () => {
  let observed!: () => void;
  const survived = new Promise<void>((resolve) => (observed = resolve));
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send("null");
      setTimeout(observed, 25);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const client = startRelayClient({
    url: `ws://127.0.0.1:${port}`,
    code: "a-strong-pairing-code-for-tests",
    registry: {} as SessionRegistry,
  });
  try {
    await survived;
  } finally {
    client.stop();
    wss.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
});

// R.5: the dial-out presents the entitlement token as an upgrade header — and
// only re-exchanges it (refresh: true) after an unentitled refusal. Loopback
// WS server capturing what actually crosses the wire; the registry is never
// touched on this path (no viewport ever opens).
test("dial-out carries the entitlement header; a 4007 close makes the retry force-refresh", async () => {
  const seen: Array<string | undefined> = [];
  const refreshArgs: boolean[] = [];
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));

  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const h = req.headers[ENTITLEMENT_HEADER];
    seen.push(Array.isArray(h) ? h[0] : h);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (seen.length === 1) ws.close(CLOSE_UNENTITLED); // refuse the first dial
      else done(); // second dial observed with its refreshed token — enough
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const client = startRelayClient({
    url: `ws://127.0.0.1:${port}`,
    code: "a-strong-pairing-code-for-tests",
    registry: {} as SessionRegistry, // unused: no viewport opens in this test
    token: async ({ refresh }) => {
      refreshArgs.push(refresh);
      return refresh ? "refreshed-token" : "first-token";
    },
  });
  try {
    await finished;
    assert.deepEqual(refreshArgs, [false, true]); // 4007 → forced refresh on retry
    assert.deepEqual(seen, ["first-token", "refreshed-token"]);
  } finally {
    client.stop();
    wss.close();
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections?.();
    });
  }
});

test("dial-out with no token source sends no entitlement header", async () => {
  let done!: (h: string | undefined) => void;
  const gotHeader = new Promise<string | undefined>((r) => (done = r));
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const h = req.headers[ENTITLEMENT_HEADER];
    wss.handleUpgrade(req, socket, head, () => done(Array.isArray(h) ? h[0] : h));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;

  const client = startRelayClient({
    url: `ws://127.0.0.1:${port}`,
    code: "a-strong-pairing-code-for-tests",
    registry: {} as SessionRegistry,
  });
  try {
    assert.equal(await gotHeader, undefined);
  } finally {
    client.stop();
    wss.close();
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections?.();
    });
  }
});
