import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg } from "../protocol";
import {
  attachSession,
  broadcasts,
  startDaemon,
  createSession,
  TestClient,
  type Daemon,
} from "../testing/itest-harness";

// The session registry over the real socket — fan-out, ring-buffer
// replay, 4.4 tail resume vs full replay, stale-id fallback, the fleet
// watcher (4.6), and the idle timeout (short override) (L.2b).

type Any = WireMsg & Record<string, any>;

let d: Daemon;
let a: TestClient;
let sessionId: string;

before(async () => {
  d = await startDaemon({ SESSION_IDLE_TIMEOUT_MS: "1200" });
  ({ client: a, sessionId } = await createSession(d.port));
});
after(async () => {
  a.close();
  await d.stop();
});

const attach = (opts: { sessionId: string; afterSeq?: number }) =>
  attachSession(d.port, opts.sessionId, opts.afterSeq);

test("broadcast fans out to two viewports with identical seq stamps", async () => {
  const { client: b, created } = await attach({ sessionId });
  assert.equal(created.sessionId, sessionId);

  a.send({ type: "prompt", text: "fan this out" });
  await a.type("turn_end", 20_000);
  await b.type("turn_end", 20_000);

  const seen = (c: TestClient) => broadcasts(c).map((m) => `${m.seq}:${m.type}`);
  assert.ok(seen(a).length > 0);
  assert.deepEqual(seen(b), seen(a));
  b.close();
});

test("a late viewport gets the full ring-buffer replay, in order", async () => {
  const { client: late } = await attach({ sessionId });
  // Replay is synchronous on attach — everything buffered arrives before any
  // live traffic; the stream so far must match viewport A's exactly.
  await late.waitFor((m) => (m as Any).seq === broadcasts(a).at(-1)!.seq, "replay tail");
  assert.deepEqual(
    broadcasts(late).map((m) => `${m.seq}:${m.type}`),
    broadcasts(a).map((m) => `${m.seq}:${m.type}`),
  );
  late.close();
});

test("a valid afterSeq resumes with only the unseen tail", async () => {
  const last = broadcasts(a).at(-1)!.seq as number;
  const { client: resumer, created } = await attach({ sessionId, afterSeq: last - 2 });
  assert.equal(created.resumed, true);
  await resumer.waitFor((m) => (m as Any).seq === last, "tail replay");
  assert.deepEqual(
    broadcasts(resumer).map((m) => m.seq),
    [last - 1, last],
  );
  resumer.close();
});

test("a foreign afterSeq (never issued) falls back to a full replay", async () => {
  const { client: c, created } = await attach({ sessionId, afterSeq: 999_999 });
  assert.equal(created.resumed, undefined);
  const first = await c.waitFor((m) => typeof (m as Any).seq === "number", "first replayed");
  assert.equal((first as Any).seq, 1); // the whole buffer, from the top
  c.close();
});

test("a stale session id gets a fresh session, not an error", async () => {
  const { client: c, created } = await attach({ sessionId: "zzzzzzzz" });
  assert.notEqual(created.sessionId, "zzzzzzzz");
  assert.equal(created.resumed, undefined);
  c.close();
});

test("fleet watcher: snapshot on watch, status working → idle across a turn", async () => {
  const w = new TestClient(d.port);
  await w.opened();
  await w.type("agents");
  w.send({ type: "watch_sessions" } as never);
  const snap = (await w.type("sessions")) as Any;
  const mine = snap.sessions.find((s: Any) => s.sessionId === sessionId);
  assert.ok(mine, "watched snapshot lists the session");
  assert.equal(mine.agent, "claude-code");
  assert.equal(mine.model, "mock-sonnet", "#6: fleet meta carries the model (mock here)");
  assert.equal(mine.status, "idle");

  a.send({ type: "prompt", text: "keep the fleet busy" });
  await w.waitFor(
    (m) =>
      m.type === "sessions" &&
      (m as Any).sessions.some((s: Any) => s.sessionId === sessionId && s.status === "working"),
    "working snapshot",
    20_000,
  );
  await a.type("turn_end", 20_000);
  await w.waitFor(
    (m) =>
      m.type === "sessions" &&
      (m as Any).sessions.some((s: Any) => s.sessionId === sessionId && s.status === "idle"),
    "idle snapshot",
    20_000,
  );
  w.close();
});

test("rename updates fleet metadata", async () => {
  const w = new TestClient(d.port);
  await w.opened();
  await w.type("agents");
  w.send({ type: "watch_sessions" } as never);
  await w.type("sessions");
  a.send({ type: "rename", sessionId, name: "renamed-by-itest" } as never);
  await w.waitFor(
    (m) =>
      m.type === "sessions" &&
      (m as Any).sessions.some((s: Any) => s.sessionId === sessionId && s.name === "renamed-by-itest"),
    "renamed snapshot",
  );
  w.close();
});

test("an unwatched session dies at the idle timeout; its id then creates fresh", async () => {
  const { client: g, sessionId: dying } = await createSession(d.port);
  g.close();
  await new Promise((r) => setTimeout(r, 2_500)); // past the 1200ms override
  const { client: h, created } = await attach({ sessionId: dying });
  assert.notEqual(created.sessionId, dying); // the old session is gone
  h.close();
});
