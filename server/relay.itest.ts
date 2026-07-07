import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { ClientMsg, WireMsg } from "./protocol";
import { startDaemon, TestClient, type Daemon } from "./itest-harness";
import { startRelayStub, type RelayStub } from "./relay-stub";
import {
  CLOSE_BAD_CODE,
  CLOSE_CODE_TAKEN,
  DAEMON_PATH,
  PAIR_PARAM,
  VIEWPORT_PATH,
} from "./relay-protocol";
import {
  derivePair,
  frameCiphers,
  openHandshake,
  randomBytes,
  sealHandshake,
  type FrameCipher,
  type PairSecret,
} from "./relay-crypto";

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

/**
 * The browser side of the encrypted channel, as ws.ts implements it: connect
 * with the derived pairId, handshake, then seal/open every frame with the
 * per-connection ciphers. Same waitFor API as TestClient.
 */
class RemoteClient {
  ws!: WebSocket;
  received: WireMsg[] = [];
  closed!: Promise<{ code: number }>;
  private cipher!: FrameCipher;
  private sendChain: Promise<void> = Promise.resolve();
  private recvChain: Promise<void> = Promise.resolve();
  private cursor = 0;
  private wake: (() => void)[] = [];

  static async connect(port: number, code: string, pairIdOverride?: string): Promise<RemoteClient> {
    const c = new RemoteClient();
    const pair = await derivePair(code);
    const pairId = pairIdOverride ?? pair.id;
    c.ws = new WebSocket(`ws://127.0.0.1:${port}${VIEWPORT_PATH}?${PAIR_PARAM}=${pairId}`);
    c.closed = new Promise((res) => {
      c.ws.on("close", (code) => res({ code }));
      c.ws.on("error", () => res({ code: -1 }));
    });
    await new Promise<void>((res, rej) => {
      c.ws.on("open", res);
      c.ws.on("error", rej);
    });
    const nonceC = randomBytes(32);
    const hsDone = new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("handshake timed out")), 10_000);
      c.ws.on("close", () => {
        clearTimeout(t);
        rej(new Error("closed during handshake")); // no-op if already settled
      });
      c.ws.once("message", async (data) => {
        try {
          const nonceD = await openHandshake(pair, "d", String(data));
          c.cipher = await frameCiphers(pair, nonceC, nonceD, "c");
          // From here on, every frame is app traffic.
          c.ws.on("message", (data2) => {
            c.recvChain = c.recvChain.then(async () => {
              c.received.push(JSON.parse(await c.cipher.open(String(data2))) as WireMsg);
              for (const w of c.wake.splice(0)) w();
            });
          });
          clearTimeout(t);
          res();
        } catch (err) {
          clearTimeout(t);
          rej(err as Error);
        }
      });
    });
    c.ws.send(await sealHandshake(pair, "c", nonceC));
    await hsDone;
    return c;
  }

  send(msg: ClientMsg) {
    this.sendChain = this.sendChain.then(async () => {
      this.ws.send(await this.cipher.seal(JSON.stringify(msg)));
    });
  }

  /** A frame the daemon must reject: sealed correctly, then corrupted. */
  async sendTampered() {
    const sealed = await this.cipher.seal(JSON.stringify({ type: "ping" }));
    const last = sealed.at(-1) === "A" ? "B" : "A";
    this.ws.send(sealed.slice(0, -1) + last);
  }

  waitFor(pred: (m: WireMsg) => boolean, label = "message", timeoutMs = 15_000): Promise<WireMsg> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(
          new Error(
            `timed out waiting for ${label}; seen: ${this.received.map((m) => m.type).join(",")}`,
          ),
        );
      }, timeoutMs);
      const scan = () => {
        while (this.cursor < this.received.length) {
          const m = this.received[this.cursor++];
          if (pred(m)) {
            clearTimeout(deadline);
            resolve(m);
            return;
          }
        }
        this.wake.push(scan);
      };
      scan();
    });
  }

  type(t: WireMsg["type"], timeoutMs?: number): Promise<WireMsg> {
    return this.waitFor((m) => m.type === t, t, timeoutMs);
  }

  mark(): number {
    return this.received.length;
  }

  close() {
    this.ws.close();
  }
}

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
const broadcasts = (c: { received: WireMsg[] }) =>
  (c.received as Any[]).filter((m) => typeof m.seq === "number");

before(async () => {
  stub = await startRelayStub({ tap });
  d = await startDaemon({ GENUI_RELAY_URL: stub.url, GENUI_RELAY_CODE: CODE });
  await waitForLog(/\[relay\] paired/);
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
  const local = new TestClient(d.port);
  await local.opened();
  await local.type("agents");
  local.send({ type: "attach", sessionId } as never);
  await local.type("session_created");

  // Replay: the local late-joiner must reconstruct exactly what streamed to
  // the remote viewport live, through the encrypted path.
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
  const watcher = new TestClient(d.port);
  await watcher.opened();
  await watcher.type("agents");
  watcher.send({ type: "attach", sessionId } as never);
  await watcher.type("session_created");

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
  const code = await new Promise<number>((res) => {
    ws.on("close", (c) => res(c));
    ws.on("error", () => res(-1));
  });
  assert.equal(code, CLOSE_BAD_CODE);
});

test("a second daemon dialing the same pair id is refused", async () => {
  const pair = await derivePair(CODE);
  const ws = new WebSocket(`${stub.url}${DAEMON_PATH}?${PAIR_PARAM}=${pair.id}`);
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
  stub = await startRelayStub({ port, tap });
  await waitForLog(/\[relay\] paired[\s\S]*\[relay\] paired/, 15_000);

  remote = await RemoteClient.connect(stub.port, CODE);
  await remote.type("agents");
  remote.send({ type: "attach", sessionId } as never);
  const created = (await remote.type("session_created")) as Any;
  assert.equal(created.sessionId, sessionId); // the same warm session, post-blip
});
