import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg } from "../protocol";
import { startDaemon, createSession, TestClient, type Daemon } from "../testing/itest-harness";

// Q.4 — the hostile-client sweep. Every `case` in connection.ts's message
// switch has a malformed path (wrong-typed field, missing field, junk object)
// that no test exercised; the non-JSON reply and the `^[\w-]{1,64}$` bang-id
// guard were dead code to the suite. This drives all of them over a REAL
// socket, mid-session, and proves: the daemon never crashes, the socket stays
// attached and drives a full turn afterward, and no garbage frame leaks a
// broadcast to a second viewport on the same session.
//
// It also pins a real bug this sweep found: a raw frame that parses to `null`
// (or a bare number/string) has no `.type`; `null.type` throws, and on the
// local WS path (index.ts wraps handleMessage in NO try/catch) that escapes to
// the uncaughtException handler, which exits the daemon. Without the
// non-object guard in connection.ts this file times out — the daemon is gone.

type Any = WireMsg & Record<string, any>;

let d: Daemon;

before(async () => {
  d = await startDaemon();
});
after(async () => {
  await d.stop();
});

test("Q.4 garbage frames mid-session: daemon survives, 2nd viewport stays quiet, a real turn completes", async () => {
  // Two viewports on ONE session: A fires the garbage, B watches for leaks.
  const { client: a, sessionId } = await createSession(d.port);
  const b = new TestClient(d.port);
  await b.opened();
  await b.type("agents");
  b.send({ type: "attach", sessionId } as never);
  await b.type("session_created");

  const aMark = a.received.length;
  const bMark = b.received.length; // B has seen everything up to here; a fresh
  //                                  session has no activity, so bMark is quiet.

  // --- prompt: non-string / whitespace / missing text (all silently ignored) ---
  a.send({ type: "prompt", text: 123 } as never);
  a.send({ type: "prompt", text: "   " } as never);
  a.send({ type: "prompt" } as never);
  // --- bang: non-string command, an id that fails ^[\w-]{1,64}$, missing id ---
  a.send({ type: "bang", command: null, id: "x" } as never);
  a.send({ type: "bang", command: "ls", id: "bad id !!" } as never);
  a.send({ type: "bang", command: "ls" } as never);
  // --- bang_input / bang_kill: no bang is running, wrong id, non-string data ---
  a.send({ type: "bang_input", id: "nope", data: 5 } as never);
  a.send({ type: "bang_input", id: "nope" } as never);
  a.send({ type: "bang_kill", id: "nope" } as never);
  a.send({ type: "bang_kill" } as never);
  // (interrupt is covered in the next test — on an idle session it legitimately
  //  emits a turn_end, so it isn't a "quiet" frame and belongs elsewhere.)
  // --- permission_response: non-string id, non-boolean allow, missing both ---
  a.send({ type: "permission_response", id: 1, allow: "yes" } as never);
  a.send({ type: "permission_response" } as never);
  // --- action: non-object action, null action, unknown kind, wrong-typed inner ---
  a.send({ type: "action", action: "nope", sourceId: "s" } as never);
  a.send({ type: "action", action: null, sourceId: "s" } as never);
  a.send({ type: "action", action: { kind: "bogus" }, sourceId: "s" } as never);
  a.send({ type: "action", action: { kind: "prompt", text: 42 }, sourceId: "s" } as never);
  a.send({ type: "action", action: { kind: "tool" }, sourceId: "s" } as never);
  // --- rename: non-string name, missing sessionId (no rename, no crash) ---
  a.send({ type: "rename", sessionId, name: 99 } as never);
  a.send({ type: "rename", name: "x" } as never);
  // --- end_session: non-string / missing id — MUST NOT tear down the session ---
  a.send({ type: "end_session", sessionId: 12345 } as never);
  a.send({ type: "end_session" } as never);
  // --- raw frames: bad JSON, and the primitives that used to crash the daemon ---
  a.sendRaw("this is not json {{{");
  a.sendRaw("null"); // the crash vector — null.type throws
  a.sendRaw("42");
  a.sendRaw('"hi"');
  a.sendRaw("[1,2,3]"); // an object → passes the guard → ignored, no error
  // --- ping LAST as a sentinel: its pong proves every frame above was handled ---
  a.send({ type: "ping" } as never);
  await a.waitFor((m) => m.type === "pong", "pong sentinel", 20_000);

  // Exactly one pong (the sentinel) and one "malformed client message" per
  // non-object raw frame (bad JSON + null + 42 + "hi" = 4; the array is a valid
  // object and is ignored). The typed-but-wrong frames are silently dropped.
  const aTail = a.received.slice(aMark) as Any[];
  assert.equal(aTail.filter((m) => m.type === "pong").length, 1);
  const malformed = aTail.filter((m) => m.type === "error" && m.message === "malformed client message");
  assert.equal(malformed.length, 4);
  // The daemon did NOT crash: no last-gasp line in its log.
  assert.doesNotMatch(d.logs(), /crashed \(uncaughtException\)/);

  // The session survived the end_session garbage and A is still attached: a
  // real prompt drives a full turn.
  a.send({ type: "prompt", text: "still alive" });
  await a.waitFor((m) => m.type === "turn_end", "turn_end", 20_000);

  // The second viewport got the valid turn — and it is the FIRST thing B saw
  // after bMark, proving no garbage frame broadcast to it (broadcasts to a
  // session arrive at every viewport in emission order).
  await b.waitFor((m) => m.type === "user_prompt", "B user_prompt", 20_000);
  assert.equal(b.received[bMark].type, "user_prompt");
  assert.equal((b.received[bMark] as Any).text, "still alive");

  a.close();
  b.close();
});

test("Q.4 garbage create/attach frames are tolerated and still yield a working session", async () => {
  const t = new TestClient(d.port);
  await t.opened();
  await t.type("agents");

  // create with wrong-typed fields: non-string cwd coerces to the default,
  // junk agent falls back to the daemon default — a session, not a crash.
  t.send({ type: "create", cwd: 12345, agent: 999 } as never);
  const sc = (await t.type("session_created")) as Any;
  assert.equal(typeof sc.sessionId, "string");
  assert.equal(typeof sc.cwd, "string"); // a real cwd, not the junk number

  // attach with wrong-typed fields: non-string id → a fresh session (no
  // fallback flag, since nothing real was asked for); non-number afterSeq
  // is ignored rather than trusted.
  t.send({ type: "attach", sessionId: 999, afterSeq: "nan" } as never);
  const sc2 = (await t.type("session_created")) as Any;
  assert.equal(sc2.fallback, undefined);

  // interrupt on an idle session: a documented no-op that still settles with a
  // turn_end (kept as a client-side guarantee), never a crash.
  t.send({ type: "interrupt" } as never);
  await t.waitFor((m) => m.type === "turn_end", "idle interrupt turn_end", 20_000);

  // The socket is fine: a real turn completes.
  t.send({ type: "prompt", text: "hello" });
  await t.waitFor((m) => m.type === "turn_end", "turn_end", 20_000);
  assert.doesNotMatch(d.logs(), /crashed \(uncaughtException\)/);
  t.close();
});
