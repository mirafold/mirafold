import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { CLIENT_VERSION } from "./version";
import {
  SocketClient,
  relayTargetFromFragment,
  newSessionHref,
  viewportRefusalReason,
  PING_INTERVAL_MS,
  PONG_DEADLINE_MS,
  BACKOFF_MIN_MS,
  BACKOFF_MAX_MS,
} from "./ws";

/** In-memory Storage stub for newSessionHref (which takes storage injected). */
function fakeStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

// L.2b3: the reconnect state machine, driven through a stubbed WebSocket —
// no browser, no jsdom. The stub exposes what the client touches (readyState,
// handler props, send/close) plus test-side controls to open a socket,
// deliver a frame, and complete a close. Every instance is tracked so the
// core invariant — at most one live socket, ever — is directly observable.

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWS[] = [];
  readyState = FakeWS.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    // Browser semantics: close() only starts the handshake; onclose comes
    // later (finishClose) — the CLOSING window the duplicate-socket race
    // lived in.
    if (this.readyState === FakeWS.CONNECTING || this.readyState === FakeWS.OPEN) {
      this.readyState = FakeWS.CLOSING;
    }
  }
  open() {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  finishClose(code?: number) {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.(code === undefined ? undefined : { code });
  }
  parsedSent(): { type: string }[] {
    return this.sent.map((s) => JSON.parse(s) as { type: string });
  }
  pings(): number {
    return this.parsedSent().filter((m) => m.type === "ping").length;
  }
}

type Handler = () => void;

/** window/document stand-ins: real listener registries so tests can fire
 * online/visibilitychange and assert removal on close(). */
function shimDom() {
  const win = new Map<string, Set<Handler>>();
  const doc = new Map<string, Set<Handler>>();
  const listeners = (m: Map<string, Set<Handler>>) => ({
    addEventListener: (type: string, fn: Handler) => {
      if (!m.has(type)) m.set(type, new Set());
      m.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Handler) => {
      m.get(type)?.delete(fn);
    },
  });
  const g = globalThis as Record<string, unknown>;
  g.window = listeners(win);
  g.document = { ...listeners(doc), visibilityState: "visible" };
  return {
    online: () => {
      for (const fn of win.get("online") ?? []) fn();
    },
    visible: () => {
      for (const fn of doc.get("visibilitychange") ?? []) fn();
    },
    listenerCount: () =>
      (win.get("online")?.size ?? 0) + (doc.get("visibilitychange")?.size ?? 0),
  };
}

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  FakeWS.instances = [];
  (globalThis as Record<string, unknown>).WebSocket = FakeWS;
  const dom = shimDom();
  const client = new SocketClient("ws://test/ws");
  return { dom, client, sock: () => FakeWS.instances.at(-1)! };
}

test("hello goes first on every open; sends while connecting queue in order", (t) => {
  const { client, sock } = setup(t);
  client.setHello(() => ({ type: "attach", sessionId: "s1" }));
  client.send({ type: "prompt", text: "a" });
  client.send({ type: "prompt", text: "b" });
  assert.equal(sock().sent.length, 0); // nothing leaves a CONNECTING socket

  sock().open();
  assert.deepEqual(
    sock().parsedSent().map((m) => m.type),
    ["attach", "prompt", "prompt"],
  );
  assert.deepEqual(
    sock().sent.slice(1).map((s) => (JSON.parse(s) as { text: string }).text),
    ["a", "b"],
  );

  // Reconnect: hello leads again, then the newly queued message — none lost.
  sock().close();
  sock().finishClose();
  t.mock.timers.tick(BACKOFF_MIN_MS);
  client.send({ type: "prompt", text: "c" });
  sock().open();
  assert.deepEqual(
    sock().parsedSent().map((m) => m.type),
    ["attach", "prompt"],
  );
});

test("a null hello sends nothing but still flushes the queue (P.4 onboarding)", (t) => {
  const { client, sock } = setup(t);
  client.setHello(() => null);
  client.send({ type: "prompt", text: "queued" });
  sock().open();
  assert.deepEqual(
    sock().parsedSent().map((m) => m.type),
    ["prompt"],
  );
});

test("viewportRefusalReason maps relay refusal codes; ordinary drops are undefined", () => {
  assert.match(viewportRefusalReason(4003)!, /Desktop not reachable/); // CLOSE_BAD_CODE
  assert.match(viewportRefusalReason(4004)!, /capacity/); // CLOSE_OVERLOADED
  assert.match(viewportRefusalReason(4006)!, /allowed to connect/); // CLOSE_FORBIDDEN_ORIGIN
  assert.equal(viewportRefusalReason(1000), undefined); // normal close
  assert.equal(viewportRefusalReason(1006), undefined); // transport drop
  assert.equal(viewportRefusalReason(undefined), undefined); // no-code close (browsers omit it, the mock does too)
});

test("a relay-refusal close code reaches onClose as a reason; a plain drop passes undefined", (t) => {
  const { client, sock } = setup(t);
  const refusals: (string | undefined)[] = [];
  client.onClose((r) => refusals.push(r));

  sock().open();
  sock().finishClose(4003); // relay: no daemon paired under this id
  assert.deepEqual(refusals, ["Desktop not reachable — is Mirafold running there?"]);

  // The reconnect that a refusal schedules, then an ordinary drop → undefined.
  t.mock.timers.tick(BACKOFF_MAX_MS);
  sock().open();
  sock().finishClose(); // no code — an ordinary transport drop
  assert.equal(refusals.at(-1), undefined);
});

test("overlapping reconnect triggers supersede a CLOSING socket — at most one live socket", (t) => {
  const { dom, client, sock } = setup(t);
  client.setHello(() => ({ type: "attach", sessionId: "s1" }));
  const one = sock();
  one.open();
  const seen: string[] = [];
  let closes = 0;
  client.onMessage((m) => seen.push(m.type));
  client.onClose(() => closes++);

  // The production race: heartbeat ping goes unanswered on a dead pipe,
  // client calls close() → CLOSING; then the network comes back.
  t.mock.timers.tick(PING_INTERVAL_MS);
  t.mock.timers.tick(PONG_DEADLINE_MS);
  assert.equal(one.readyState, FakeWS.CLOSING);

  dom.online(); // supersedes: socket #2
  assert.equal(FakeWS.instances.length, 2);
  dom.visible(); // while #2 is CONNECTING — must not stack #3
  dom.online();
  assert.equal(FakeWS.instances.length, 2);

  const two = sock();
  two.open();
  assert.equal(two.parsedSent()[0]!.type, "attach");

  // The superseded socket's late onclose must be inert: no spurious close
  // listeners, no extra scheduled connect, heartbeat of #2 untouched.
  one.finishClose();
  assert.equal(closes, 0);
  t.mock.timers.tick(BACKOFF_MAX_MS);
  assert.equal(FakeWS.instances.length, 2);
  one.receive({ type: "turn_end" }); // stale frame on the dead socket
  assert.deepEqual(seen, []);
  t.mock.timers.tick(PING_INTERVAL_MS);
  assert.equal(two.pings(), 1); // exactly one interval running
  assert.equal(one.pings(), 1); // only the ping from before the blip
  assert.equal(FakeWS.instances.filter((s) => s.readyState === FakeWS.OPEN).length, 1);
});

test("an unanswered ping closes the socket into the reconnect path", (t) => {
  const { client, sock } = setup(t);
  void client;
  const one = sock();
  one.open();
  t.mock.timers.tick(PING_INTERVAL_MS);
  assert.equal(one.pings(), 1);
  t.mock.timers.tick(PONG_DEADLINE_MS - 1);
  assert.equal(one.readyState, FakeWS.OPEN); // deadline not hit yet
  t.mock.timers.tick(1);
  assert.equal(one.readyState, FakeWS.CLOSING);
  one.finishClose();
  t.mock.timers.tick(BACKOFF_MIN_MS);
  assert.equal(FakeWS.instances.length, 2); // reconnect scheduled and fired
});

test("any inbound traffic clears the pong deadline, not just pong", (t) => {
  const { client, sock } = setup(t);
  void client;
  const one = sock();
  one.open();
  t.mock.timers.tick(PING_INTERVAL_MS);
  one.receive({ type: "turn_end" }); // proof of life, no pong needed
  t.mock.timers.tick(PONG_DEADLINE_MS);
  assert.equal(one.readyState, FakeWS.OPEN);
});

test("heartbeat timers never stack across reconnects", (t) => {
  const { client, sock } = setup(t);
  void client;
  sock().open();
  sock().close();
  sock().finishClose();
  t.mock.timers.tick(BACKOFF_MIN_MS);
  const two = sock();
  two.open();
  t.mock.timers.tick(PING_INTERVAL_MS);
  assert.equal(two.pings(), 1); // a leftover interval would make this 2
});

test("lastSeq tracks only seq-stamped frames; pong is swallowed; garbage ignored", (t) => {
  const { client, sock } = setup(t);
  const one = sock();
  one.open();
  const seen: string[] = [];
  client.onMessage((m) => seen.push(m.type));

  one.receive({ type: "text_delta", text: "x", seq: 3 });
  assert.equal(client.lastSeq, 3);
  one.receive({ type: "turn_end" }); // unstamped — cursor must not move
  assert.equal(client.lastSeq, 3);
  one.receive({ type: "pong" });
  one.onmessage!({ data: "not json{" });
  assert.deepEqual(seen, ["text_delta", "turn_end"]); // no pong, no crash
});

test("an unknown message type is inert but still moves the resume cursor (R.4h)", (t) => {
  // Ignore-unknown is the wire protocol's versioning story: a newer daemon
  // may stamp types this bundle has never heard of. They must not crash the
  // client, AND they must advance lastSeq — otherwise the next reconnect
  // would ask the server to replay frames this client already saw.
  const { client, sock } = setup(t);
  const one = sock();
  one.open();
  const seen: string[] = [];
  client.onMessage((m) => seen.push(m.type));

  one.receive({ type: "hologram_delta", data: "from the future", seq: 7 });
  assert.equal(client.lastSeq, 7);
  one.receive({ type: "text_delta", text: "x", seq: 8 });
  assert.equal(client.lastSeq, 8);
  // Delivered to subscribers (whose switches ignore it), in order, no crash.
  assert.deepEqual(seen, ["hologram_delta", "text_delta"]);
});

test("backoff doubles to the cap and resets on a successful open", (t) => {
  const { client, sock } = setup(t);
  void client;
  // Expected delays for consecutive failed attempts: 500, 1000, 2000, 4000,
  // then pinned at 5000.
  const delays = [
    BACKOFF_MIN_MS,
    1000,
    2000,
    4000,
    BACKOFF_MAX_MS,
    BACKOFF_MAX_MS,
  ];
  for (const delay of delays) {
    const n = FakeWS.instances.length;
    sock().finishClose(); // connection attempt failed
    t.mock.timers.tick(delay - 1);
    assert.equal(FakeWS.instances.length, n); // not yet
    t.mock.timers.tick(1);
    assert.equal(FakeWS.instances.length, n + 1);
  }
  // A successful open resets the ladder to the minimum.
  sock().open();
  sock().close();
  sock().finishClose();
  const n = FakeWS.instances.length;
  t.mock.timers.tick(BACKOFF_MIN_MS);
  assert.equal(FakeWS.instances.length, n + 1);
});

test("deliberate close(): no reconnect, heartbeat stopped, dom listeners removed", (t) => {
  const { dom, client, sock } = setup(t);
  const one = sock();
  one.open();
  assert.equal(dom.listenerCount(), 2);

  client.close();
  one.finishClose();
  t.mock.timers.tick(BACKOFF_MAX_MS + PING_INTERVAL_MS);
  assert.equal(FakeWS.instances.length, 1); // no reconnect ever scheduled
  assert.equal(one.pings(), 0); // heartbeat cleared before the first ping
  assert.equal(dom.listenerCount(), 0);
  dom.online(); // nothing left listening
  dom.visible();
  assert.equal(FakeWS.instances.length, 1);
});

// Static-origin serving: the fragment may carry relay=<ws(s) origin> beside
// the code — where the socket dials when the page is served from a static
// origin that is not the relay. Pure parser, tested directly.
test("fragment parsing: code alone, code+relay, and hostile/malformed relay values", () => {
  // Local page: no code → no remote mode, regardless of a stray relay param.
  assert.equal(relayTargetFromFragment(""), null);
  assert.equal(relayTargetFromFragment("#relay=wss%3A%2F%2Fx.example"), null);

  // Code alone (today's QR): same-origin dial (ws null).
  assert.deepEqual(relayTargetFromFragment("#code=abc-DEF_123"), { code: "abc-DEF_123", ws: null });

  // Code + relay (the app.mirafold.com QR): the encoded ws(s) URL comes back
  // normalized to its origin — path/trailing-slash junk can't smuggle into the
  // dial URL we build from it.
  assert.deepEqual(
    relayTargetFromFragment(`#code=abc&relay=${encodeURIComponent("wss://relay.mirafold.sh")}`),
    { code: "abc", ws: "wss://relay.mirafold.sh" },
  );
  assert.deepEqual(
    relayTargetFromFragment(`#code=abc&relay=${encodeURIComponent("ws://127.0.0.1:8080/some/path/")}`),
    { code: "abc", ws: "ws://127.0.0.1:8080" },
  );
  // Params in either order.
  assert.deepEqual(
    relayTargetFromFragment(`#relay=${encodeURIComponent("wss://r.example")}&code=abc`),
    { code: "abc", ws: "wss://r.example" },
  );

  // A crafted link must not steer the socket anywhere but ws(s): non-socket
  // protocols and unparseable values are dropped → same-origin fallback.
  for (const hostile of [
    encodeURIComponent("https://evil.example"),
    encodeURIComponent("javascript:alert(1)"),
    "not%20a%20url",
    "%ZZbadencoding",
  ]) {
    assert.deepEqual(
      relayTargetFromFragment(`#code=abc&relay=${hostile}`),
      { code: "abc", ws: null },
      hostile,
    );
  }
});

test("client_error is stamped with the bundle version (one choke point)", (t) => {
  const { client, sock } = setup(t);
  client.setHello(() => ({ type: "attach", sessionId: "s1" }));
  client.send({ type: "client_error", message: "TypeError: boom" });
  sock().open();
  const report = sock()
    .sent.map((m) => JSON.parse(m) as { type: string; clientVersion?: string })
    .find((m) => m.type === "client_error");
  assert.ok(report, "queued report leaves on open");
  assert.equal(report.clientVersion, CLIENT_VERSION);
});

// The mobile new-session bug (2026-07-24): the in-session "new" button opens
// a fresh tab, which inherits neither the URL fragment nor sessionStorage — so
// on the relay path the new-tab href MUST re-encode the pairing target, or the
// new tab falls back to a daemon-less local ws and hangs on "connecting".
test("newSessionHref: local path (no stored code) → plain URL", () => {
  assert.equal(newSessionHref("/?new=1", fakeStorage()), "/?new=1");
});

test("newSessionHref: relay path w/ separate app origin → fragment carries code AND relay", () => {
  const href = newSessionHref(
    "/?new=1",
    fakeStorage({
      "mirafold-relay-code": "pair-code-abc_123",
      "mirafold-relay-ws": "wss://relay.mirafold.sh",
    }),
  );
  // The invariant that fixes the bug: the fragment parses back to the SAME
  // target the current tab holds, so the new tab re-hydrates and dials the
  // relay instead of a dead local ws.
  const hash = href.slice(href.indexOf("#"));
  assert.deepEqual(relayTargetFromFragment(hash), {
    code: "pair-code-abc_123",
    ws: "wss://relay.mirafold.sh",
  });
});

test("newSessionHref: relay path w/ same-origin (no stored ws) → fragment carries code only", () => {
  const href = newSessionHref(
    "/?new=1",
    fakeStorage({ "mirafold-relay-code": "just-a-code_9" }),
  );
  assert.equal(href, "/?new=1#code=just-a-code_9");
  assert.deepEqual(relayTargetFromFragment(href.slice(href.indexOf("#"))), {
    code: "just-a-code_9",
    ws: null,
  });
});
