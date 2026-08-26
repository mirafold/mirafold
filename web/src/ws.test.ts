import { test, type TestContext } from "node:test";
import { FakeWS, fakeStorage, shimDom } from "./testing/fake-ws";
import assert from "node:assert/strict";
import { CLIENT_VERSION } from "./version";
import {
  SocketClient,
  viewportRefusalReason,
  PING_INTERVAL_MS,
  PONG_DEADLINE_MS,
  BACKOFF_MIN_MS,
  BACKOFF_MAX_MS,
} from "./ws";
import {
  adoptStoredPairing,
  relayTargetFromFragment,
  sessionHintFromFragment,
  newSessionHref,
  storedPairing,
} from "./relay-pairing";

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

test("a null hello sends nothing but still flushes the queue (P.4 agent picker)", (t) => {
  const { client, sock } = setup(t);
  client.setHello(() => null);
  client.send({ type: "prompt", text: "queued" });
  sock().open();
  assert.deepEqual(
    sock().parsedSent().map((m) => m.type),
    ["prompt"],
  );
});

test("sendIfOpen never replays a user-gesture side effect after reconnect", (t) => {
  const { client, sock } = setup(t);
  assert.equal(client.sendIfOpen({ type: "pick_folder", id: "fp-before-open" }), false);

  sock().open();
  assert.deepEqual(sock().parsedSent(), [], "the rejected click was not queued");
  assert.equal(client.sendIfOpen({ type: "pick_folder", id: "fp-open" }), true);
  assert.deepEqual(sock().parsedSent(), [{ type: "pick_folder", id: "fp-open" }]);

  sock().close();
  sock().finishClose();
  assert.equal(client.sendIfOpen({ type: "pick_folder", id: "fp-disconnected" }), false);
  t.mock.timers.tick(BACKOFF_MIN_MS);
  sock().open();
  assert.deepEqual(sock().parsedSent(), [], "the disconnected click was not replayed");
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
  assert.equal(dom.listenerCount(), 3);

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

// The lingering-fleet-count fix (2026-07-24): navigating away must deliver a
// clean close so the daemon detaches the viewport immediately, instead of the
// count staying stale until the server heartbeat reaps the half-open socket.
test("pagehide closes the socket immediately but is NOT a deliberate close — a restored page reconnects", (t) => {
  const { dom, client, sock } = setup(t);
  const one = sock();
  one.open();

  dom.pagehide();
  assert.equal(one.readyState, FakeWS.CLOSING); // close handshake started at once

  // A bfcache restore: the close completes, and because closedByUs was never
  // set, the ordinary reconnect path revives the connection.
  one.finishClose();
  t.mock.timers.tick(BACKOFF_MIN_MS);
  assert.equal(FakeWS.instances.length, 2);

  // close() also removes the pagehide listener — nothing left to fire.
  client.close();
  assert.equal(dom.listenerCount(), 0);
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

// Pairing lands IN the session the QR was made from: the fragment may carry a
// session hint beside the code — main.tsx rewrites the path from it before the
// router reads location.pathname. Pure parser, tested directly.
test("fragment parsing: the session hint — absent, present in any position, hostile", () => {
  // No hint (mission control's QR, and every pre-hint link): null → the fleet.
  assert.equal(sessionHintFromFragment(""), null);
  assert.equal(sessionHintFromFragment("#code=abc"), null);

  // Present, in any position among the other params.
  assert.equal(sessionHintFromFragment("#code=abc&s=sess-42_x"), "sess-42_x");
  assert.equal(
    sessionHintFromFragment(`#code=abc&relay=${encodeURIComponent("wss://r.example")}&s=s1`),
    "s1",
  );
  assert.equal(sessionHintFromFragment("#s=s1&code=abc"), "s1");
  // Duplicate params: the first hint wins, same as the code/relay matchers.
  assert.equal(sessionHintFromFragment("#code=abc&s=s1&s=s2"), "s1");

  // A crafted link must not steer the path anywhere but a well-formed session
  // id: anything beyond a full [\w-]+ token is dropped whole, never truncated
  // into a "valid" prefix.
  for (const hostile of ["../admin", "s1/../../x", "s1%2F..", ".", "%ZZ"]) {
    assert.equal(sessionHintFromFragment(`#code=abc&s=${hostile}`), null, hostile);
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
      "mirafold-relay-paired-at": String(Date.now()),
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
    fakeStorage({
      "mirafold-relay-code": "just-a-code_9",
      "mirafold-relay-paired-at": String(Date.now()),
    }),
  );
  assert.equal(href, "/?new=1#code=just-a-code_9");
  assert.deepEqual(relayTargetFromFragment(href.slice(href.indexOf("#"))), {
    code: "just-a-code_9",
    ws: null,
  });
});

test("newSessionHref: an aged-out pairing is NOT resurrected into the new tab", () => {
  // Raw reads here would re-encode the expired code, and the new tab's
  // load-time stash would grant it a fresh max-age window — defeating the
  // bearer credential's expiry (2026-07-28 review).
  const store = fakeStorage({
    "mirafold-relay-code": "expired-code_1",
    "mirafold-relay-ws": "wss://relay.mirafold.sh",
    "mirafold-relay-paired-at": "1000",
  });
  assert.equal(newSessionHref("/?new=1", store), "/?new=1");
});

// The backgrounded-phone bug (2026-07-25, Kyle's phone): the pairing code used
// to live in per-tab sessionStorage, which does not survive a browser
// discarding a backgrounded tab. The rebuilt tab found no code — and since the
// fragment is scrubbed on first load by design, the URL couldn't supply one
// either — so the shell loaded with nothing to attach to. The store is the
// device's now, with an age bound so a bearer credential can't live forever.
const DAY = 24 * 60 * 60 * 1000;

test("storedPairing: a device-stored pairing survives (that's the bug fix)", () => {
  const store = fakeStorage({
    "mirafold-relay-code": "pair-code-abc_123",
    "mirafold-relay-ws": "wss://relay.mirafold.sh",
    "mirafold-relay-paired-at": String(1_000_000),
  });
  assert.deepEqual(storedPairing(store, null, 1_000_000 + 6 * DAY), {
    code: "pair-code-abc_123",
    ws: "wss://relay.mirafold.sh",
  });
});

test("storedPairing: one older than the max age is dropped, and cleared out", () => {
  const store = fakeStorage({
    "mirafold-relay-code": "pair-code-abc_123",
    "mirafold-relay-paired-at": String(1_000_000),
  });
  assert.equal(storedPairing(store, null, 1_000_000 + 8 * DAY), null);
  assert.equal(store.getItem("mirafold-relay-code"), null, "an aged-out code must not linger");
});

test("storedPairing: a tab paired by an older build still works (sessionStorage carried)", () => {
  const legacy = fakeStorage({ "mirafold-relay-code": "older-build-code_7" });
  assert.deepEqual(storedPairing(fakeStorage(), legacy), {
    code: "older-build-code_7",
    ws: null,
  });
});

test("storedPairing: nothing stored anywhere → null (a local page never dials a relay)", () => {
  assert.equal(storedPairing(fakeStorage(), fakeStorage()), null);
});

// ---- 2026-07-29 bughunt: the relay-path state machine, driven end-to-end
// with real crypto (Node's WebCrypto). Four bugs lived here untested: the
// backoff ladder reset on OPEN (a refusal is a close CODE, which arrives
// only after a completed upgrade — so a permanently-refused viewport
// redialed at 2 Hz forever); a superseded socket's still-armed pong deadline
// closed its SUCCESSOR; a handshake the daemon never answers wedged the
// viewport forever; and a handshake completion racing a close destroyed the
// pending queue.

import { derivePair, frameCiphers, openHandshake, sealHandshake, randomBytes } from "@relay-crypto";
import { HANDSHAKE_DEADLINE_MS } from "./ws";

const PAIR_CODE = "abcdefgh12345678";

/** Drain microtasks + setImmediate rounds so chained crypto promises settle
 *  (mock timers fake setTimeout/setInterval only). */
const drain = async (rounds = 25) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

/** Spin the loop until `cond` holds — WebCrypto work lands on the threadpool,
 *  so a fixed round count is a race (the first cold derivation flaked). */
const drainUntil = async (cond: () => boolean, label: string, rounds = 20_000) => {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`drainUntil: ${label}`);
};

function setupRelay(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  FakeWS.instances = [];
  const g = globalThis as Record<string, unknown>;
  g.WebSocket = FakeWS;
  const dom = shimDom();
  g.location = {
    protocol: "http:",
    host: "phone.test",
    hash: `#code=${PAIR_CODE}`,
    pathname: "/",
    search: "",
  };
  g.localStorage = fakeStorage();
  g.sessionStorage = fakeStorage();
  g.history = { replaceState: () => {} };
  const client = new SocketClient(); // no url → relay mode from the fragment
  return { dom, client, sock: () => FakeWS.instances.at(-1)! };
}

/** Complete the daemon half of the handshake on `s`, waiting for the client's
 *  public open signal rather than a fixed number of event-loop turns; returns
 *  the daemon-side cipher for opening subsequent client ciphertext frames. */
async function answerHandshake(s: FakeWS, client: SocketClient) {
  const pair = await derivePair(PAIR_CODE);
  await drainUntil(() => s.sent.length >= 1, "client handshake frame sent");
  const clientNonce = await openHandshake(pair, "c", s.sent[0]);
  const daemonNonce = randomBytes(32);
  let opened = false;
  const stopWatchingOpen = client.onOpen(() => {
    opened = true;
  });
  try {
    s.receiveRaw(await sealHandshake(pair, "d", daemonNonce));
    await drainUntil(() => opened, "client handshake completed");
  } finally {
    stopWatchingOpen();
  }
  return frameCiphers(pair, clientNonce, daemonNonce, "d");
}

test("relay path: backoff climbs across post-open refusals — no 2 Hz hammering", async (t) => {
  const { client, sock } = setupRelay(t);
  client.setHello(() => null);
  await drainUntil(() => FakeWS.instances.length > 0, "first dial after derivePair");
  const cadences: number[] = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    const s = sock();
    s.open(); // the upgrade completes...
    await drain();
    s.finishClose(4006); // ...then the relay refuses (permanent condition)
    const before = FakeWS.instances.length;
    let waited = 0;
    while (FakeWS.instances.length === before && waited < 60_000) {
      t.mock.timers.tick(100);
      waited += 100;
    }
    cadences.push(waited);
  }
  assert.ok(
    cadences[1] > cadences[0] && cadences[2] > cadences[1],
    `the ladder climbs between refusals: ${cadences.join(",")}`,
  );
  client.close();
});

test("relay path: a completed handshake resets the ladder (health = usable channel, not upgrade)", async (t) => {
  const { client, sock } = setupRelay(t);
  client.setHello(() => null);
  await drainUntil(() => FakeWS.instances.length > 0, "first dial after derivePair");
  // Two refusal cycles push the backoff up…
  for (let i = 0; i < 2; i++) {
    sock().open();
    await drain();
    sock().finishClose(4006);
    t.mock.timers.tick(BACKOFF_MAX_MS);
  }
  // …then a healthy handshaken connect resets it.
  const healthy = sock();
  healthy.open();
  await answerHandshake(healthy, client);
  healthy.finishClose(); // ordinary drop after a healthy session
  const before = FakeWS.instances.length;
  let waited = 0;
  while (FakeWS.instances.length === before && waited < 60_000) {
    t.mock.timers.tick(100);
    waited += 100;
  }
  assert.ok(waited <= BACKOFF_MIN_MS, `post-health retry is prompt again (${waited}ms)`);
  client.close();
});

test("relay path: a failed seal closes the socket instead of silently skipping every later send", async (t) => {
  const { client, sock } = setupRelay(t);
  client.setHello(() => null);
  await drainUntil(() => FakeWS.instances.length > 0, "first dial after derivePair");
  const healthy = sock();
  healthy.open();
  await answerHandshake(healthy, client);
  const subtle = globalThis.crypto.subtle as unknown as Record<string, unknown>;
  Object.defineProperty(subtle, "encrypt", {
    configurable: true,
    value: () => Promise.reject(new Error("seal failed")),
  });
  try {
    client.send({ type: "ping" });
    await drainUntil(() => healthy.readyState === FakeWS.CLOSING, "socket closed after a failed seal");
  } finally {
    delete subtle.encrypt;
  }
  client.close();
});

test("relay path: an unanswered handshake is bounded — the deadline closes into the retry ladder", async (t) => {
  const { client, sock } = setupRelay(t);
  client.setHello(() => null);
  await drainUntil(() => FakeWS.instances.length > 0, "first dial after derivePair");
  const s = sock();
  s.open();
  await drainUntil(() => s.sent.length >= 1, "handshake frame sent; the daemon never answers");
  assert.equal(s.sent.length, 1);
  t.mock.timers.tick(HANDSHAKE_DEADLINE_MS);
  assert.equal(s.readyState, FakeWS.CLOSING, "the wedged socket is closed, not waited on forever");
  s.finishClose();
  t.mock.timers.tick(BACKOFF_MAX_MS);
  assert.ok(FakeWS.instances.at(-1)! !== s, "the ordinary reconnect path took over");
  client.close();
});

test("relay path: a handshake completion racing a close keeps the pending queue alive", async (t) => {
  const { client, sock } = setupRelay(t);
  client.setHello(() => null);
  client.send({ type: "prompt", text: "survives" });
  await drainUntil(() => FakeWS.instances.length > 0, "first dial after derivePair");
  const one = sock();
  one.open();
  const pair = await derivePair(PAIR_CODE);
  await drainUntil(() => one.sent.length >= 1, "handshake frame sent");
  // The daemon's reply arrives — and the socket drops before the chained
  // async open runs. Finishing the open anyway used to flash "connected"
  // on the dead socket and splice `pending` into sends that all failed
  // their readyState guard — every queued message destroyed.
  let opens = 0;
  client.onOpen(() => opens++);
  one.receiveRaw(await sealHandshake(pair, "d", randomBytes(32)));
  one.finishClose();
  await drain(200);
  assert.equal(opens, 0, "no spurious onOpen for a dead socket");
  // The queue survives to the next life: reconnect, handshake, and the
  // queued prompt goes out — decrypted daemon-side to prove it's the SAME
  // message, not a husk.
  t.mock.timers.tick(BACKOFF_MAX_MS);
  const two = sock();
  assert.notEqual(two, one);
  two.open();
  const daemonCipher = await answerHandshake(two, client);
  await drainUntil(() => two.sent.length >= 2, "queued prompt re-sent on the new life");
  const first = JSON.parse(await daemonCipher.open(two.sent[1])) as { type: string; text?: string };
  assert.equal(first.type, "prompt");
  assert.equal(first.text, "survives");
  client.close();
});

test("2026-07-29 a superseded socket's armed pong deadline never kills its successor", (t) => {
  const { dom, client, sock } = setup(t);
  client.setHello(() => null);
  const one = sock();
  one.open();

  // A ping goes out; its pong deadline is pending (8s).
  t.mock.timers.tick(PING_INTERVAL_MS);
  assert.equal(one.pings(), 1);

  // 1s later the user navigates away: pagehide closes the raw socket.
  t.mock.timers.tick(1_000);
  dom.pagehide();
  assert.equal(one.readyState, FakeWS.CLOSING);

  // bfcache restore: visibilitychange fires BEFORE the old socket's late
  // onclose → reconnectNow supersedes the CLOSING socket.
  dom.visible();
  const two = sock();
  assert.notEqual(two, one);
  assert.equal(two.readyState, FakeWS.CONNECTING);

  // The old socket's onclose arrives — inert by design, stopHeartbeat
  // skipped. Its deadline used to fire against this.ws and close the NEW
  // socket mid-connect; now it stands down with its own socket.
  one.finishClose();
  t.mock.timers.tick(PONG_DEADLINE_MS);
  assert.equal(two.readyState, FakeWS.CONNECTING, "the successor socket is untouched");
  two.open();
  assert.equal(two.readyState, FakeWS.OPEN);
  client.close();
});

// 2026-07-29 bughunt: newSessionHref reads the DEVICE store only, but a tab
// paired by a pre-2026-07-25 build held its code only in the per-tab legacy
// store — so its "new session" link carried no fragment and the fresh tab
// hung on "connecting" (the 2026-07-24 mobile bug, resurrected for that
// population). The boot path now migrates the carry on use.

test("a legacy-store pairing is adopted into the device store, so newSessionHref carries it", () => {
  const device = fakeStorage();
  const legacy = fakeStorage({ "mirafold-relay-code": "legacy-code-16chars" });
  const adopted = adoptStoredPairing(device, legacy); // real clock: the age
  // window opens NOW (the device is actively driving the pairing).
  assert.equal(adopted?.code, "legacy-code-16chars");
  assert.equal(device.getItem("mirafold-relay-code"), "legacy-code-16chars");
  const href = newSessionHref("/?new=1", device);
  assert.match(href, /#code=legacy-code-16chars/);
});

test("adoption never overwrites a live device-store pairing", () => {
  const device = fakeStorage({
    "mirafold-relay-code": "device-code-16chars",
    "mirafold-relay-paired-at": "500",
  });
  const legacy = fakeStorage({ "mirafold-relay-code": "legacy-code-16chars" });
  const adopted = adoptStoredPairing(device, legacy, 1_000);
  assert.equal(adopted?.code, "device-code-16chars");
  assert.equal(device.getItem("mirafold-relay-code"), "device-code-16chars");
});

// AUDIT 2026-08-26: two ingress guards. A frame is an object with a string
// type and string text; a fresh `#code=` pairing is remembered only after a
// successful handshake.
test("AUDIT: admitWireFrame drops non-object frames and non-string text fields, keeps ordinary frames", async () => {
  const { admitWireFrame } = await import("./ws");
  for (const bad of [null, 1, "s", [], { type: 1 }, { type: "text_delta", text: 5 }, { type: "error", message: null }, { type: "bang_output", data: {} }, { type: "artifact", html: [] }]) {
    assert.equal(admitWireFrame(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(admitWireFrame({ type: "text_delta", text: "hi" }), { type: "text_delta", text: "hi" });
  assert.deepEqual(admitWireFrame({ type: "turn_end" }), { type: "turn_end" });
  assert.deepEqual(admitWireFrame({ type: "unknown_future_type", seq: 9 }), { type: "unknown_future_type", seq: 9 });
});

test("AUDIT: rememberPairing is the only write; a fragment pairing is not stored until the handshake succeeds", async () => {
  const { rememberPairing, storedPairing } = await import("./relay-pairing");
  const store = fakeStorage();
  assert.equal(storedPairing(store, null, 1_000), null);
  rememberPairing({ code: "abcdefghijklmnop", ws: "wss://relay.example" }, store, 1_000);
  assert.deepEqual(storedPairing(store, null, 2_000), { code: "abcdefghijklmnop", ws: "wss://relay.example" });
  rememberPairing({ code: "qrstuvwxyzabcdef", ws: null }, store, 3_000);
  assert.deepEqual(storedPairing(store, null, 4_000), { code: "qrstuvwxyzabcdef", ws: null }, "a fresh code without a relay clears the stale origin");
});
