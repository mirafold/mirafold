import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { WireMsg } from "../protocol";
import { attachSession, broadcasts, startDaemon, stripReplay, TestClient, type Daemon } from "../testing/itest-harness";
import { startRelayStub, type RelayStub } from "./relay-stub";
import {
  CLOSE_BAD_CODE,
  CLOSE_CODE_TAKEN,
  DAEMON_PATH,
  PAIR_PARAM,
  VIEWPORT_PATH,
} from "./relay-protocol";
import { derivePair } from "./relay-crypto";
import { closeCode, RemoteClient } from "./relay-test-client";

// R.1 + R.3: the relay seam over real processes — the daemon (child) dials
// OUT to the stub (in this test process); remote viewports handshake and talk
// AES-GCM end-to-end, and must be indistinguishable from local ones: same
// hello, same grammar, same replay, byte-for-byte the same broadcast stream.
// The stub's tap records exactly what a relay operator could observe — the
// tests prove that is pair ids and ciphertext, never the code or a plaintext
// frame. The daemon opens no listening port for any of it.

const CODE = "itest-pairing-code-3f9a7c";

type Any = WireMsg & Record<string, any>;

let stub: RelayStub;
let d: Daemon;
let remote: RemoteClient; // the long-lived remote viewport (created in test 1)
let sessionId: string;
const tapped: { dir: string; p: string }[] = [];
const tappedUrls: string[] = [];
const tap = {
  frame: (dir: "c2d" | "d2c", p: string) => tapped.push({ dir, p }),
  url: (u: string) => tappedUrls.push(u),
};

before(async () => {
  stub = await startRelayStub({ tap });
  d = await startDaemon({ MIRAFOLD_RELAY_URL: stub.url, MIRAFOLD_RELAY_CODE: CODE });
  await d.waitForLog(/\[relay\] paired/, "paired");
});
after(async () => {
  remote?.close();
  await d.stop();
  await stub.stop();
});

test("a remote viewport handshakes, creates a session, and runs a full mock turn", async () => {
  remote = await RemoteClient.connect(stub.port, CODE);
  await remote.type("agents"); // the same hello a local viewport gets
  remote.send({ type: "create", agent: "claude-code" } as never);
  const created = (await remote.type("session_created")) as Any;
  sessionId = created.sessionId;

  remote.send({ type: "prompt", text: "hello through the relay" });
  await remote.waitFor(
    (m) => m.type === "user_prompt" && (m as Any).text === "hello through the relay",
    "user_prompt echo",
  );
  await remote.type("render", 20_000); // the mock turn's component lands too
  await remote.type("turn_end", 20_000);
});

test("local and remote viewports mirror the stream byte for byte (replay + live)", async () => {
  const { client: local } = await attachSession(d.port, sessionId);

  // Replay: the local late-joiner must reconstruct exactly what streamed to
  // the remote viewport live, through the encrypted path.
  const remoteSeen = broadcasts(remote);
  assert.ok(remoteSeen.length > 0, "remote viewport saw no broadcasts (prior turn never streamed?)");
  const remoteTail = remoteSeen.at(-1)!.seq;
  await local.waitFor((m) => (m as Any).seq === remoteTail, "replay tail");
  // The late joiner's copies carry the replay stamp (2026-07-29) — content
  // must still mirror the live stream exactly.
  assert.ok(broadcasts(local).every((m) => m.replay === true));
  assert.deepEqual(stripReplay(broadcasts(local)), stripReplay(broadcasts(remote)));

  // Live: a turn driven from the LOCAL side fans out to both identically.
  local.send({ type: "prompt", text: "drive it from the local tab" });
  await local.type("turn_end", 20_000);
  await remote.type("turn_end", 20_000);
  assert.deepEqual(stripReplay(broadcasts(remote)), stripReplay(broadcasts(local)));
  local.close();
});

test("interrupt sent through the relay halts the in-flight turn", async () => {
  const from = remote.mark();
  remote.send({ type: "prompt", text: "tell me a long story" }); // template turn, seconds long
  await remote.waitFor((m) => m.type === "thinking_delta", "turn underway", 20_000);
  remote.send({ type: "interrupt" });
  await remote.type("turn_end", 5_000);
  // An uninterrupted template turn always renders a component and reports
  // usage before turn_end; the interrupt cancels both.
  const slice = remote.received.slice(from);
  assert.ok(!slice.some((m) => m.type === "render" || m.type === "usage"));
});

test("a permission answered FROM THE PHONE resolves for the local viewport too (2026-07-28)", async () => {
  // Kyle's report: the phone's allow/deny looked like it worked (its own bar
  // cleared locally) while the desktop's copy of the ask sat there and — once
  // the ask went stale — a tap resolved nothing. The fix: the adapter
  // announces every resolution on the stream; here the REMOTE viewport
  // answers and the LOCAL one must hear it before the allowed tool moves.
  const { client: local } = await attachSession(d.port, sessionId);

  remote.send({ type: "prompt", text: "do something dangerous" });
  const askLocal = (await local.type("permission_request", 20_000)) as Any;
  const askRemote = (await remote.type("permission_request", 20_000)) as Any;
  assert.equal(askRemote.id, askLocal.id);

  remote.send({ type: "permission_response", id: askRemote.id, allow: true } as never);
  const next = (await local.waitFor(() => true, "frame after the ask", 20_000)) as Any;
  assert.equal(next.type, "permission_resolved", `expected the resolution first, got ${next.type}`);
  assert.equal(next.id, askLocal.id);
  assert.equal(next.allow, true);
  // …and the allowed turn completes on both sides.
  await local.type("turn_end", 20_000);
  await remote.type("turn_end", 20_000);
  local.close();
});

test("the pairing code rides the LOCAL hello only — the relay-path hello omits it", async () => {
  const local = new TestClient(d.port);
  await local.opened();
  const localHello = (await local.type("agents")) as Any;
  assert.equal(localHello.relay?.code, CODE); // the R.4 QR's data source
  assert.match(localHello.relay?.url, /^http:/);
  local.close();

  const remoteHello = remote.received.find((m) => m.type === "agents") as Any;
  assert.ok(remoteHello, "remote viewport got the hello");
  assert.equal(remoteHello.relay, undefined); // never re-sent over the relay
});

test("a sudo-style prompt answered from the phone: the secret reaches the PTY only", async () => {
  // The 4.9 ephemeral-path invariant, now load-bearing over the relay: the
  // remote viewport types into a password prompt; the secret must appear in
  // no viewport's stream (echo-off PTY), no replay, and no relay frame.
  const { client: watcher } = await attachSession(d.port, sessionId);

  remote.send({
    type: "bang",
    command: `bash -c 'read -s -p "Password: " x; echo; echo "got ok"'`,
    id: "relay-bang-1",
  } as never);
  await remote.waitFor(
    (m) => m.type === "bang_output" && (m as Any).data.includes("Password:"),
    "password prompt",
  );
  remote.send({ type: "bang_input", data: "hunter2-relay\n", id: "relay-bang-1" } as never);
  await remote.waitFor((m) => m.type === "bang_end", "bang_end", 20_000);
  await watcher.waitFor((m) => m.type === "bang_end", "watcher bang_end", 20_000);

  const leak = (msgs: WireMsg[]) => msgs.some((m) => JSON.stringify(m).includes("hunter2"));
  assert.ok(!leak(remote.received), "secret leaked into the issuing viewport's stream");
  assert.ok(!leak(watcher.received), "secret leaked into another viewport's stream");
  assert.ok(
    remote.received.some(
      (m) => m.type === "bang_output" && (m as Any).data.includes("got ok"),
    ),
    "the command actually consumed the typed secret",
  );
  watcher.close();
});

test("the relay observed only pair ids and ciphertext — never the code or a plaintext frame", () => {
  assert.ok(tapped.length > 50, `expected real traffic through the tap, saw ${tapped.length}`);
  for (const { p } of tapped) {
    // Ciphertext is base64url; any JSON delimiter or field name means a leak.
    assert.ok(/^[A-Za-z0-9_-]+$/.test(p), `frame is not ciphertext: ${p.slice(0, 80)}`);
    assert.ok(!p.includes(CODE));
    assert.ok(!p.includes("hunter2"), "the bang_input secret crossed the relay in the clear");
  }
  assert.ok(tappedUrls.length >= 2); // daemon dial-in + viewports
  for (const u of tappedUrls) {
    assert.ok(!u.includes(CODE), `pairing code leaked into a relay URL: ${u}`);
  }
});

test("a tampered frame fails closed: the daemon drops the viewport", async () => {
  const doomed = await RemoteClient.connect(stub.port, CODE);
  await doomed.type("agents");
  await doomed.sendTampered();
  const { code } = await doomed.closed; // daemon → close envelope → stub closes us
  assert.equal(code, CLOSE_BAD_CODE);
});

test("a wrong code with the RIGHT pair id fails the handshake and is dropped", async () => {
  const realId = (await derivePair(CODE)).id;
  // Knowing the id (the one thing the relay sees) must not admit anyone: the
  // handshake under the wrong code's keys can't authenticate.
  await assert.rejects(() => RemoteClient.connect(stub.port, "wrong-code-entirely", realId));
});

test("an unknown pair id is refused by the relay itself", async () => {
  const ws = new WebSocket(
    `${stub.url}${VIEWPORT_PATH}?${PAIR_PARAM}=totally-unknown-id`,
  );
  assert.equal(await closeCode(ws), CLOSE_BAD_CODE);
});

test("a second daemon dialing the same pair id is refused", async () => {
  const pair = await derivePair(CODE);
  const ws = new WebSocket(`${stub.url}${DAEMON_PATH}?${PAIR_PARAM}=${pair.id}`);
  assert.equal(await closeCode(ws), CLOSE_CODE_TAKEN);
});

test("a weak pinned MIRAFOLD_RELAY_CODE is refused: the daemon mints and the weak code admits no one", async () => {
  const stub2 = await startRelayStub();
  const d2 = await startDaemon({
    MIRAFOLD_RELAY_URL: stub2.url,
    MIRAFOLD_RELAY_CODE: "kyle123", // guessable — must never become the credential
  });
  try {
    await d2.waitForLog(/MIRAFOLD_RELAY_CODE .* REFUSED/, "weak code refused", 10_000);
    await d2.waitForLog(/\[relay\] paired/, "paired", 10_000);
    const minted = d2.logs().match(/pairing code: (\S+)/)?.[1];
    assert.ok(minted && minted !== "kyle123" && minted.length >= 16);

    // The weak code's pairId matches no daemon at the relay…
    await assert.rejects(() => RemoteClient.connect(stub2.port, "kyle123"));
    // …and the minted code works.
    const ok = await RemoteClient.connect(stub2.port, minted);
    await ok.type("agents");
    ok.close();
  } finally {
    await d2.stop();
    await stub2.stop();
  }
});

test("R.5: a gated relay refuses a token-less daemon (actionable line) and admits one with MIRAFOLD_ENTITLEMENT_TOKEN", async () => {
  // The stub's exact-match gate models the real relay's refusal shape (the
  // real signature check is pinned in mirafold-relay's own suite + the sibling
  // service itest). This is the CI-runnable proof of the daemon's SEND path.
  const TOKEN = "itest-beta-token";
  const GATED_CODE = "itest-gated-code-8c2e1b";
  const stub2 = await startRelayStub({ entitlementToken: TOKEN });
  // No token configured: the dial is refused with the actionable line — and
  // the daemon keeps serving locally (startDaemon itself proves boot health).
  const dNo = await startDaemon({ MIRAFOLD_RELAY_URL: stub2.url, MIRAFOLD_RELAY_CODE: GATED_CODE });
  try {
    await dNo.waitForLog(/entitlement: none configured/, "no entitlement", 10_000);
    await dNo.waitForLog(/refused: remote access needs a valid subscription/, "refusal line", 10_000);
    assert.ok(!dNo.logs().includes("[relay] paired"));
  } finally {
    await dNo.stop();
  }
  // Hand-issued token (the comped-beta path): pairs, and a viewport works.
  const dYes = await startDaemon({
    MIRAFOLD_RELAY_URL: stub2.url,
    MIRAFOLD_RELAY_CODE: GATED_CODE,
    MIRAFOLD_ENTITLEMENT_TOKEN: TOKEN,
  });
  try {
    await dYes.waitForLog(/entitlement: hand-issued token/, "token mode", 10_000);
    await dYes.waitForLog(/\[relay\] paired/, "paired", 10_000);
    const ok = await RemoteClient.connect(stub2.port, GATED_CODE);
    await ok.type("agents");
    ok.close();
  } finally {
    await dYes.stop();
    await stub2.stop();
  }
});

test("the daemon refuses viewports past MAX_REMOTE_VIEWPORTS and frees slots on close", async () => {
  // Own stub + daemon: the cap is env-tuned to 2 so the test stays cheap. A
  // hostile relay announcing endless viewports must not grow daemon state.
  const stub2 = await startRelayStub();
  const d2 = await startDaemon({
    MIRAFOLD_RELAY_URL: stub2.url,
    MIRAFOLD_RELAY_CODE: CODE,
    MAX_REMOTE_VIEWPORTS: "2",
  });
  try {
    await d2.waitForLog(/\[relay\] paired/, "paired", 10_000);
    const c1 = await RemoteClient.connect(stub2.port, CODE);
    const c2 = await RemoteClient.connect(stub2.port, CODE);
    await c1.type("agents");
    await c2.type("agents");

    // Third announcement: the daemon answers with a close envelope before any
    // handshake state exists, and the stub closes the viewport socket.
    await assert.rejects(() => RemoteClient.connect(stub2.port, CODE));

    // The refusal must not have disturbed the admitted viewports…
    c1.send({ type: "ping" });
    await c1.type("pong");

    // …and a closed viewport frees its slot (drop → close envelope → delete).
    c2.close();
    let c4: RemoteClient | undefined;
    for (let i = 0; i < 20 && !c4; i++) {
      await new Promise((r) => setTimeout(r, 200));
      c4 = await RemoteClient.connect(stub2.port, CODE).catch(() => undefined);
    }
    assert.ok(c4, "a slot never freed up after closing a viewport");
    await c4.type("agents");
    c1.close();
    c4.close();
  } finally {
    await d2.stop();
    await stub2.stop();
  }
});

test("a handshaken viewport that goes silent is idle-reaped; an active one survives", async () => {
  // A replayed handshake hello can never send an authentic frame — this reaper
  // is what keeps such a zombie from parking a Connection forever. The real
  // client heartbeats every 25s, far inside the 90s default; here the window
  // is tuned down so the test proves both sides of the line quickly.
  const stub3 = await startRelayStub();
  const d3 = await startDaemon({
    MIRAFOLD_RELAY_URL: stub3.url,
    MIRAFOLD_RELAY_CODE: CODE,
    RELAY_VIEWPORT_IDLE_MS: "1000",
  });
  try {
    await d3.waitForLog(/\[relay\] paired/, "paired", 10_000);
    const idle = await RemoteClient.connect(stub3.port, CODE);
    const active = await RemoteClient.connect(stub3.port, CODE);
    await idle.type("agents");
    await active.type("agents");

    // Keep one side chatty (well inside the 1s window) while the other stays mute.
    const beat = setInterval(() => active.send({ type: "ping" }), 300);
    const { code } = await idle.closed; // reaped → close envelope → stub closes us
    clearInterval(beat);
    assert.equal(code, CLOSE_BAD_CODE);

    // The chatty viewport out-lived the reap window and still round-trips.
    active.send({ type: "ping" });
    await active.type("pong");
    active.close();
  } finally {
    await d3.stop();
    await stub3.stop();
  }
});

test("R.4i: a subscription-backed session is refused over the relay but served locally", async () => {
  // Give this daemon a Claude SUBSCRIPTION login (a .credentials.json, no API
  // key) → credentialKind "subscription". createSession still routes to the
  // mock (we never drive a real subscription), but the session's KIND is what
  // gates the relay: a remote viewport must be refused with the reason, while a
  // LOCAL viewport on the same daemon is served — the paid path is closed to a
  // subscription, the free local path is not.
  const claudeDir = mkdtempSync(path.join(os.tmpdir(), "genui-sub-"));
  writeFileSync(path.join(claudeDir, ".credentials.json"), "{}");
  const stub2 = await startRelayStub();
  const d2 = await startDaemon({
    MIRAFOLD_RELAY_URL: stub2.url,
    MIRAFOLD_RELAY_CODE: CODE,
    CLAUDE_CONFIG_DIR: claudeDir,
  });
  try {
    await d2.waitForLog(/\[relay\] paired/, "paired", 10_000);

    // The picker hello marks claude-code blocked, not live.
    const r = await RemoteClient.connect(stub2.port, CODE);
    const hello = (await r.type("agents")) as Any;
    const claude = hello.agents.find((a: Any) => a.agent === "claude-code");
    assert.equal(claude.live, false);
    assert.equal(claude.blocked, true);

    // Remote (relay) viewport creates a claude-code session → refused, no attach.
    r.send({ type: "create", agent: "claude-code" } as never);
    const refused = (await r.type("refused")) as Any;
    assert.equal(refused.reason, "subscription-relay");
    assert.match(refused.message, /subscription/i);
    assert.ok(
      !r.received.some((m) => m.type === "session_created"),
      "a refused remote viewport must not be handed a session",
    );

    // A LOCAL viewport on the SAME daemon is served the (mock-backed) session —
    // the gate is remote-only.
    const local = new TestClient(d2.port);
    await local.opened();
    await local.type("agents");
    local.send({ type: "create", agent: "claude-code" } as never);
    const created = (await local.type("session_created")) as Any;
    assert.equal(created.demo, true); // runs the mock, never the subscription
    assert.ok(!local.received.some((m) => m.type === "refused"));
    local.close();
    r.close();
  } finally {
    await d2.stop();
    await stub2.stop();
    rmSync(claudeDir, { recursive: true, force: true });
  }
});

test("the daemon re-dials after a relay restart and the session is reachable again", async () => {
  const port = stub.port;
  await stub.stop(); // kills the daemon's dial-out and the remote viewport
  await remote.closed;
  stub = await startRelayStub({ port, tap });
  await d.waitForLog(/\[relay\] paired[\s\S]*\[relay\] paired/, "re-paired", 15_000);

  remote = await RemoteClient.connect(stub.port, CODE);
  await remote.type("agents");
  remote.send({ type: "attach", sessionId } as never);
  const created = (await remote.type("session_created")) as Any;
  assert.equal(created.sessionId, sessionId); // the same warm session, post-blip
});
