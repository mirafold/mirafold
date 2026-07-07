import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { WireMsg } from "./protocol";
import { startDaemon, TestClient, type Daemon } from "./itest-harness";
import { startRelayStub, type RelayStub } from "./relay-stub";
import { CLOSE_BAD_CODE, CLOSE_CODE_TAKEN, DAEMON_PATH } from "./relay-protocol";

// R.1: the relay seam over real processes — the daemon (child) dials OUT to
// the stub (in this test process); remote viewports connect to the stub and
// must be indistinguishable from local ones: same hello, same grammar, same
// replay, byte-for-byte the same broadcast stream. The daemon opens no new
// listening port anywhere in this file — every remote frame rides its dial-out.

const CODE = "itest-pairing-code-3f9a7c";

type Any = WireMsg & Record<string, any>;

let stub: RelayStub;
let d: Daemon;
let remote: TestClient; // the long-lived remote viewport (created in test 1)
let sessionId: string;

const waitForLog = (re: RegExp, timeoutMs = 10_000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (re.test(d.logs())) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`daemon log never matched ${re};\n${d.logs()}`));
      }
    }, 50);
  });

/** Everything seq-stamped (i.e. the session's broadcast stream). */
const broadcasts = (c: TestClient) =>
  (c.received as Any[]).filter((m) => typeof m.seq === "number");

before(async () => {
  stub = await startRelayStub();
  d = await startDaemon({ GENUI_RELAY_URL: stub.url, GENUI_RELAY_CODE: CODE });
  await waitForLog(/\[relay\] paired/);
});
after(async () => {
  remote?.close();
  await d.stop();
  await stub.stop();
});

test("a remote viewport creates a session and runs a full mock turn through the stub", async () => {
  remote = new TestClient(stub.port, { query: `?code=${encodeURIComponent(CODE)}` });
  await remote.opened();
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
  const local = new TestClient(d.port);
  await local.opened();
  await local.type("agents");
  local.send({ type: "attach", sessionId } as never);
  await local.type("session_created");

  // Replay: the local late-joiner must reconstruct exactly what streamed to
  // the remote viewport live.
  const remoteTail = broadcasts(remote).at(-1)!.seq;
  await local.waitFor((m) => (m as Any).seq === remoteTail, "replay tail");
  assert.deepEqual(broadcasts(local), broadcasts(remote));

  // Live: a turn driven from the LOCAL side fans out to both identically.
  local.send({ type: "prompt", text: "drive it from the local tab" });
  await local.type("turn_end", 20_000);
  await remote.type("turn_end", 20_000);
  assert.deepEqual(broadcasts(remote), broadcasts(local));
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

test("a viewport with an unknown pairing code is refused", async () => {
  const c = new TestClient(stub.port, { query: "?code=not-the-real-code" });
  const { code } = await c.closed;
  assert.equal(code, CLOSE_BAD_CODE);
});

test("a second daemon dialing the same pairing code is refused", async () => {
  const ws = new WebSocket(`${stub.url}${DAEMON_PATH}?code=${encodeURIComponent(CODE)}`);
  const code = await new Promise<number>((res) => {
    ws.on("close", (c) => res(c));
    ws.on("error", () => res(-1));
  });
  assert.equal(code, CLOSE_CODE_TAKEN);
});

test("the daemon re-dials after a relay restart and the session is reachable again", async () => {
  const port = stub.port;
  await stub.stop(); // kills the daemon's dial-out and the remote viewport
  await remote.closed;
  stub = await startRelayStub({ port });
  await waitForLog(/\[relay\] paired[\s\S]*\[relay\] paired/, 15_000);

  remote = new TestClient(stub.port, { query: `?code=${encodeURIComponent(CODE)}` });
  await remote.opened();
  await remote.type("agents");
  remote.send({ type: "attach", sessionId } as never);
  const created = (await remote.type("session_created")) as Any;
  assert.equal(created.sessionId, sessionId); // the same warm session, post-blip
});
