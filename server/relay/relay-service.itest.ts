import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, sign as signMessage, type KeyObject } from "node:crypto";
import type { WireMsg } from "../protocol";
import { attachSession, broadcasts, startDaemon, stripReplay, TestClient, type Daemon } from "../testing/itest-harness";
import { closeCode, RemoteClient } from "./relay-test-client";
import {
  CLOSE_CODE_TAKEN,
  CLOSE_BAD_CODE,
  CLOSE_OVERLOADED as PROTO_CLOSE_OVERLOADED,
  CLOSE_UNENTITLED as PROTO_CLOSE_UNENTITLED,
  DAEMON_PATH,
  ENTITLEMENT_HEADER as PROTO_ENTITLEMENT_HEADER,
  VIEWPORT_PATH,
  PAIR_PARAM,
  MIN_PAIR_ID_LENGTH,
} from "./relay-protocol";
import { MAX_ENVELOPE } from "./relay-client";
import { startRelay, type Relay } from "../../../mirafold-relay/src/relay";
import { LIMITS as SERVICE_LIMITS } from "../../../mirafold-relay/src/limits";
import {
  CLOSE_FORBIDDEN_ORIGIN as SERVICE_CLOSE_FORBIDDEN_ORIGIN,
  CLOSE_OVERLOADED,
  CLOSE_RATE_LIMITED,
  CLOSE_UNENTITLED,
  SHARED_CONTRACT,
  MIN_PAIR_ID_LENGTH as SERVICE_MIN_PAIR_ID_LENGTH,
} from "../../../mirafold-relay/src/contract";
import { viewportRefusalReason } from "../../web/src/ws";

// Mints a token the exact way the R.5 billing backend does — the compact
// "<b64url({exp})>.<b64url(Ed25519 sig)>" the relay verifies offline.
const mintToken = (priv: KeyObject, expSeconds: number): string => {
  const seg = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  const sig = signMessage(null, Buffer.from(seg), priv).toString("base64url");
  return `${seg}.${sig}`;
};

// The DEPLOYED relay service, verified against the real daemon locally —
// sourced from the sibling `mirafold-relay` repo, the relay's single home since
// Phase G retired the vendored `relay-service/` copy. The R.3 crypto path and
// byte-for-byte parity are already proven against the stub (relay.itest.ts);
// here we prove the grown-up service is a faithful forwarder AND that its
// production hardening (caps, rate limit, health) actually refuses abuse (R.2).

type Any = WireMsg & Record<string, any>;
const CODE = "service-itest-code-7b21e4";

let relay: Relay;
let d: Daemon;

before(async () => {
  relay = await startRelay({ host: "127.0.0.1" });
  d = await startDaemon({
    MIRAFOLD_RELAY_URL: `ws://127.0.0.1:${relay.port}`,
    MIRAFOLD_RELAY_CODE: CODE,
  });
  await d.waitForLog(/\[relay\] paired/, "paired");
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
  // The refusal codes the daemon now INTERPRETS to explain a turned-away
  // dial-out (relay-client.ts): they must match the values the relay SENDS.
  assert.equal(CLOSE_OVERLOADED, PROTO_CLOSE_OVERLOADED);
  assert.equal(CLOSE_UNENTITLED, PROTO_CLOSE_UNENTITLED);
  // R.5: the daemon SENDS its entitlement token on this header; the relay
  // READS the same one. Drift = every paid pairing refused in production.
  assert.equal(SHARED_CONTRACT.ENTITLEMENT_HEADER, PROTO_ENTITLEMENT_HEADER);
  // 2026-07-29 bughunt: the daemon's dial-out inbound cap must cover every
  // frame the relay may lawfully forward. When it didn't (~1.5 MB vs the
  // relay's 8 MB viewport cap), one oversized phone paste was a ws protocol
  // violation on the daemon socket — closing the WHOLE pairing, every
  // viewport, instead of the offender.
  assert.ok(
    MAX_ENVELOPE >= SERVICE_LIMITS.maxPayloadBytes,
    `daemon MAX_ENVELOPE (${MAX_ENVELOPE}) < relay maxPayloadBytes (${SERVICE_LIMITS.maxPayloadBytes})`,
  );
  // 2026-07-29 bughunt: web/src/ws.ts hand-mirrors the viewport refusal
  // codes, and its comment CLAIMED this guard pinned them — it didn't
  // (CLOSE_FORBIDDEN_ORIGIN exists only in contract.ts). Now it does: the
  // phone's refusal wording must track the codes the relay actually sends.
  assert.match(viewportRefusalReason(SHARED_CONTRACT.CLOSE_BAD_CODE)!, /Desktop not reachable/);
  assert.match(viewportRefusalReason(CLOSE_OVERLOADED)!, /capacity/);
  assert.match(viewportRefusalReason(SERVICE_CLOSE_FORBIDDEN_ORIGIN)!, /allowed to connect/);
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

  // A local late-joiner reconstructs exactly what streamed to the remote one
  // (its copies carry the replay stamp, 2026-07-29 — content identical).
  const { client: local } = await attachSession(d.port, created.sessionId);
  const tail = broadcasts(remote).at(-1)!.seq;
  await local.waitFor((m) => (m as Any).seq === tail, "replay tail", 20_000);
  assert.ok(broadcasts(local).every((m) => m.replay === true));
  assert.deepEqual(stripReplay(broadcasts(local)), stripReplay(broadcasts(remote)));

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
  const { derivePair } = await import("./relay-crypto");
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
    await dd.waitForLog(/\[relay\] paired/, "paired", 10_000); // daemon = conn #1
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
    await dd.waitForLog(/\[relay\] paired/, "paired", 10_000);
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
    await dd.waitForLog(/\[relay\] paired/, "paired", 10_000);
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
    await dd.waitForLog(/\[relay\] paired/, "paired", 10_000);
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

// The real-daemon proof of tonight's dial-out refusal handling: the relay's own
// tests cover the gate at the raw-WS level, but only a REAL daemon exercises
// relay-client.ts. With the entitlement gate ON and a daemon that sends no
// token (the R.5 token-send isn't built yet), this IS the paying-user-with-a-
// bad-token path — and it must read as an actionable refusal, never a false
// "paired" then a silent retry loop.
test("an unentitled real daemon: refused (4007), surfaces WHY, and never claims to be paired", async () => {
  const { publicKey } = generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const gated = await startRelay({ host: "127.0.0.1", entitlementPublicKey: pubB64 });
  const ud = await startDaemon({
    MIRAFOLD_RELAY_URL: `ws://127.0.0.1:${gated.port}`,
    MIRAFOLD_RELAY_CODE: "unentitled-service-itest-code-9f3a2b",
  });
  try {
    // relay-client interpreted CLOSE_UNENTITLED into the actionable line.
    await ud.waitForLog(/refused: remote access needs a valid subscription/, "refusal line", 10_000);
    // The confirm-timer held: a refused dial-out never logged a false "paired"
    // (the refusal close cancels PAIR_CONFIRM_MS before it can fire).
    assert.ok(!ud.logs().includes("[relay] paired with"), "must not falsely claim to be paired");
    // The gate held server-side: no daemon was ever tracked.
    assert.equal(gated.connections(), 0);
  } finally {
    await ud.stop();
    await gated.close();
  }
});

// R.5 positive case: the gate ON and a daemon holding a hand-issued token
// (MIRAFOLD_ENTITLEMENT_TOKEN — the comped-beta path) pairs for real, and the
// pairing actually WORKS (viewport drives a turn), not merely connects.
test("an entitled real daemon (token override): pairs through the gated relay and serves a viewport", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const token = mintToken(privateKey, Math.floor(Date.now() / 1000) + 48 * 3600);
  const gated = await startRelay({ host: "127.0.0.1", entitlementPublicKey: pubB64 });
  const ed = await startDaemon({
    MIRAFOLD_RELAY_URL: `ws://127.0.0.1:${gated.port}`,
    MIRAFOLD_RELAY_CODE: "entitled-service-itest-code-4d8c1e",
    MIRAFOLD_ENTITLEMENT_TOKEN: token,
  });
  try {
    await ed.waitForLog(/entitlement: hand-issued token/, "token mode", 10_000);
    await ed.waitForLog(/\[relay\] paired/, "paired", 10_000);
    const v = await RemoteClient.connect(gated.port, "entitled-service-itest-code-4d8c1e");
    await v.type("agents");
    v.close();
  } finally {
    await ed.stop();
    await gated.close();
  }
});

// R.5 license-key path, end-to-end with ZERO cloud: a throwaway local HTTP
// server plays the billing backend's /api/entitlement (minting real signed
// tokens), the daemon exchanges MIRAFOLD_LICENSE_KEY there, and the gated
// REAL relay admits the result. This is the whole paying-customer flow minus
// Paddle/Cloudflare, which the site repo's own tests cover.
test("license-key exchange: the daemon trades its key for a token and pairs; a lapsed key degrades to the refusal line", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  let lapsed = false;
  const seenKeys: string[] = [];
  const billing = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seenKeys.push((JSON.parse(body) as { licenseKey: string }).licenseKey);
      if (lapsed) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ reason: "subscription lapsed" }));
      } else {
        const exp = Math.floor(Date.now() / 1000) + 48 * 3600;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: mintToken(privateKey, exp), exp }));
      }
    });
  });
  await new Promise<void>((r) => billing.listen(0, "127.0.0.1", r));
  const billingPort = (billing.address() as { port: number }).port;
  const gated = await startRelay({ host: "127.0.0.1", entitlementPublicKey: pubB64 });

  // Active subscription: exchange → signed token → pairs → viewport works.
  const ld = await startDaemon({
    MIRAFOLD_RELAY_URL: `ws://127.0.0.1:${gated.port}`,
    MIRAFOLD_RELAY_CODE: "license-service-itest-code-6a9b3f",
    MIRAFOLD_LICENSE_KEY: "mf_itest_active_key",
    MIRAFOLD_ENTITLEMENT_URL: `http://127.0.0.1:${billingPort}/api/entitlement`,
  });
  try {
    await ld.waitForLog(/entitlement: license key/, "license-key mode", 10_000);
    await ld.waitForLog(/\[relay\] paired/, "paired", 10_000);
    assert.deepEqual([...new Set(seenKeys)], ["mf_itest_active_key"]);
    const v = await RemoteClient.connect(gated.port, "license-service-itest-code-6a9b3f");
    await v.type("agents");
    v.close();
  } finally {
    await ld.stop();
  }

  // Lapsed subscription: the exchange 403s, the dial carries no token, the
  // gated relay refuses with the actionable line — and the LOCAL product is
  // untouched (a local viewport still answers).
  lapsed = true;
  const dd = await startDaemon({
    MIRAFOLD_RELAY_URL: `ws://127.0.0.1:${gated.port}`,
    MIRAFOLD_RELAY_CODE: "lapsed-service-itest-code-2e7f8a",
    MIRAFOLD_LICENSE_KEY: "mf_itest_lapsed_key",
    MIRAFOLD_ENTITLEMENT_URL: `http://127.0.0.1:${billingPort}/api/entitlement`,
  });
  try {
    await dd.waitForLog(/refused: remote access needs a valid subscription/, "refusal line", 10_000);
    assert.ok(!dd.logs().includes("[relay] paired with"), "no false paired on a lapsed key");
    const local = new TestClient(dd.port);
    await local.opened();
    await local.type("agents"); // local product alive and answering
    local.close();
  } finally {
    await dd.stop();
    await gated.close();
    await new Promise<void>((r) => billing.close(() => r()));
  }
});
