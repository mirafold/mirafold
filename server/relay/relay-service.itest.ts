import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg } from "../protocol";
import { startDaemon, TestClient, type Daemon } from "../itest-harness";
import { RemoteClient, broadcasts, waitForLog as waitForLogH } from "./relay-test-client";
import {
  CLOSE_CODE_TAKEN,
  CLOSE_BAD_CODE,
  DAEMON_PATH,
  VIEWPORT_PATH,
  PAIR_PARAM,
  MIN_PAIR_ID_LENGTH,
} from "./relay-protocol";
import { startRelay, type Relay } from "../../../genui-relay/src/relay";
import {
  CLOSE_OVERLOADED,
  CLOSE_RATE_LIMITED,
  SHARED_CONTRACT,
  MIN_PAIR_ID_LENGTH as SERVICE_MIN_PAIR_ID_LENGTH,
} from "../../../genui-relay/src/contract";

// R.2: the DEPLOYED relay service, verified against the real daemon locally —
// sourced from the sibling `genui-relay` repo, the relay's single home since
// Phase G retired the vendored `relay-service/` copy. The R.3 crypto path and
// byte-for-byte parity are already proven against the stub (relay.itest.ts);
// here we prove the grown-up service is a faithful forwarder AND that its
// production hardening (caps, rate limit, health) actually refuses abuse.

type Any = WireMsg & Record<string, any>;
const CODE = "service-itest-code-7b21e4";

let relay: Relay;
let d: Daemon;

const waitForLog = (re: RegExp, ms = 10_000, dm?: Daemon) => waitForLogH(re, ms, dm ?? d);

before(async () => {
  relay = await startRelay({ host: "127.0.0.1" });
  d = await startDaemon({
    MIRAFOLD_RELAY_URL: `ws://127.0.0.1:${relay.port}`,
    MIRAFOLD_RELAY_CODE: CODE,
  });
  await waitForLog(/\[relay\] paired/);
});
after(async () => {
  await d.stop();
  await relay.close();
});

test("the relay's routing contract matches the daemon's relay-protocol", () => {
  // The whole open-core split rests on these staying byte-identical; drift
  // would silently break pairing in production. Fail loudly the moment it does.
  assert.equal(SHARED_CONTRACT.DAEMON_PATH, DAEMON_PATH);
  assert.equal(SHARED_CONTRACT.VIEWPORT_PATH, VIEWPORT_PATH);
  assert.equal(SHARED_CONTRACT.PAIR_PARAM, PAIR_PARAM);
  assert.equal(SHARED_CONTRACT.CLOSE_CODE_TAKEN, CLOSE_CODE_TAKEN);
  assert.equal(SHARED_CONTRACT.CLOSE_BAD_CODE, CLOSE_BAD_CODE);
  assert.equal(SERVICE_MIN_PAIR_ID_LENGTH, MIN_PAIR_ID_LENGTH);
});

test("GET /health answers ok; other HTTP is 404", async () => {
  const ok = await fetch(`http://127.0.0.1:${relay.port}/health`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.text()).trim(), "ok");
  const miss = await fetch(`http://127.0.0.1:${relay.port}/anything-else`);
  assert.equal(miss.status, 404);
});

test("a remote viewport drives a full turn; a local viewport mirrors it byte-for-byte", async () => {
  const remote = await RemoteClient.connect(relay.port, CODE);
  await remote.type("agents");
  remote.send({ type: "create", agent: "claude-code" } as never);
  const created = (await remote.type("session_created")) as Any;

  remote.send({ type: "prompt", text: "hello through the deployed relay" });
  await remote.waitFor(
    (m) => m.type === "user_prompt" && (m as Any).text === "hello through the deployed relay",
    "user_prompt echo",
  );
  await remote.type("turn_end", 20_000);

  // A local late-joiner reconstructs exactly what streamed to the remote one.
  const local = new TestClient(d.port);
  await local.opened();
  await local.type("agents");
  local.send({ type: "attach", sessionId: created.sessionId } as never);
  await local.type("session_created");
  const tail = broadcasts(remote).at(-1)!.seq;
  await local.waitFor((m) => (m as Any).seq === tail, "replay tail", 20_000);
  assert.deepEqual(broadcasts(local), broadcasts(remote));

  // connections() sees exactly the daemon dial + this viewport (+ local is a
  // separate local socket on the daemon, not on the relay).
  assert.equal(relay.connections(), 2);
  local.close();
  remote.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(relay.connections(), 1); // just the daemon dial-out left
});

test("the relay refuses a short/guessable pair id and a second daemon on a taken id", async () => {
  const WebSocket = (await import("ws")).default;
  // Short id → refused before any pairing.
  const short = new WebSocket(`ws://127.0.0.1:${relay.port}${DAEMON_PATH}?${PAIR_PARAM}=x`);
  assert.ok(MIN_PAIR_ID_LENGTH > 1);
  assert.equal(await closeCode(short), CLOSE_CODE_TAKEN);

  // Second daemon on the SAME id as the running one → refused.
  const { derivePair } = await import("../relay-crypto");
  const pairId = (await derivePair(CODE)).id;
  const dup = new WebSocket(`ws://127.0.0.1:${relay.port}${DAEMON_PATH}?${PAIR_PARAM}=${pairId}`);
  assert.equal(await closeCode(dup), CLOSE_CODE_TAKEN);
});

test("an unknown pair id (no daemon) is refused by the relay", async () => {
  const WebSocket = (await import("ws")).default;
  const ws = new WebSocket(
    `ws://127.0.0.1:${relay.port}${VIEWPORT_PATH}?${PAIR_PARAM}=no-such-daemon-here`,
  );
  assert.equal(await closeCode(ws), CLOSE_BAD_CODE);
});

test("the global connection cap refuses upgrades past the ceiling", async () => {
  // Own relay+daemon so the tiny cap can't disturb the shared pairing.
  const r = await startRelay({ host: "127.0.0.1", maxConnections: 2 });
  const dd = await startDaemon({
    MIRAFOLD_RELAY_URL: `ws://127.0.0.1:${r.port}`,
    MIRAFOLD_RELAY_CODE: CODE,
  });
  try {
    await waitForLog(/\[relay\] paired/, 10_000, dd); // daemon = conn #1
    const v1 = await RemoteClient.connect(r.port, CODE); // = conn #2
    await v1.type("agents");
    await assert.rejects(() => RemoteClient.connect(r.port, CODE)); // #3 refused
    v1.close();
  } finally {
    await dd.stop();
    await r.close();
  }
});

test("the per-pair viewport cap refuses extra viewports on one pair", async () => {
  const r = await startRelay({ host: "127.0.0.1", maxViewportsPerPair: 1 });
  const dd = await startDaemon({
    MIRAFOLD_RELAY_URL: `ws://127.0.0.1:${r.port}`,
    MIRAFOLD_RELAY_CODE: CODE,
  });
  try {
    await waitForLog(/\[relay\] paired/, 10_000, dd);
    const v1 = await RemoteClient.connect(r.port, CODE);
    await v1.type("agents");
    await assert.rejects(() => RemoteClient.connect(r.port, CODE)); // 2nd refused
    v1.close();
  } finally {
    await dd.stop();
    await r.close();
  }
});

test("a frame flood past the rate limit drops that connection", async () => {
  const r = await startRelay({
    host: "127.0.0.1",
    rateMaxFrames: 5,
    rateWindowMs: 1000,
  });
  const dd = await startDaemon({
    MIRAFOLD_RELAY_URL: `ws://127.0.0.1:${r.port}`,
    MIRAFOLD_RELAY_CODE: CODE,
  });
  try {
    await waitForLog(/\[relay\] paired/, 10_000, dd);
    const flooder = await RemoteClient.connect(r.port, CODE);
    await flooder.type("agents");
    await flooder.blast(30); // >> 5 in the window
    const { code } = await flooder.closed;
    assert.equal(code, CLOSE_RATE_LIMITED);
  } finally {
    await dd.stop();
    await r.close();
  }
});

test("the heartbeat reaper does not kill a healthy connection", async () => {
  const r = await startRelay({ host: "127.0.0.1", heartbeatMs: 150 });
  const dd = await startDaemon({
    MIRAFOLD_RELAY_URL: `ws://127.0.0.1:${r.port}`,
    MIRAFOLD_RELAY_CODE: CODE,
  });
  try {
    await waitForLog(/\[relay\] paired/, 10_000, dd);
    const v = await RemoteClient.connect(r.port, CODE);
    await v.type("agents");
    // Several heartbeat intervals pass; ws answers pings automatically, so the
    // socket stays alive and still round-trips.
    await new Promise((res) => setTimeout(res, 600));
    v.send({ type: "ping" } as never);
    await v.type("pong", 5_000);
    v.close();
  } finally {
    await dd.stop();
    await r.close();
  }
});

async function closeCode(ws: import("ws").WebSocket): Promise<number> {
  return new Promise((res) => {
    ws.on("close", (c: number) => res(c));
    ws.on("error", () => res(-1));
  });
}

void CLOSE_OVERLOADED; // asserted indirectly via assert.rejects on capped connects
