import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg } from "../protocol";
import { startDaemon, createSession, TestClient, type Daemon } from "../testing/itest-harness";

// #11, Tier-2: explicit "end session" over the real socket. Ending tears the
// session down (kills PTY, closes the engine), signals attached viewports with
// session_ended, and drops it from the fleet — whether the request comes from a
// session viewport or a fleet watcher. Idle timeout kept long so nothing dies on
// its own during the test.

type Any = WireMsg & Record<string, any>;

let d: Daemon;
before(async () => {
  d = await startDaemon({ SESSION_IDLE_TIMEOUT_MS: "30000" });
});
after(async () => {
  await d.stop();
});

async function watcher(): Promise<TestClient> {
  const w = new TestClient(d.port);
  await w.opened();
  await w.type("agents");
  w.send({ type: "watch_sessions" } as never);
  await w.type("sessions");
  return w;
}

const lists = (m: WireMsg, id: string) =>
  m.type === "sessions" && (m as Any).sessions.some((s: Any) => s.sessionId === id);

test("a viewport ends its own session: it gets session_ended and the fleet drops it", async () => {
  const { client: victim, sessionId } = await createSession(d.port);
  const w = await watcher();
  assert.ok(lists((w.received.at(-1) as WireMsg)!, sessionId), "fleet lists the new session");

  victim.send({ type: "end_session", sessionId } as never);

  const ended = (await victim.type("session_ended")) as Any;
  assert.equal(ended.sessionId, sessionId, "the attached viewport is told it's over");

  await w.waitFor((m) => m.type === "sessions" && !lists(m, sessionId), "fleet drops it", 8_000);
  w.close();
  victim.close();
});

test("a fleet watcher can end a session it isn't viewing", async () => {
  const { client: victim, sessionId } = await createSession(d.port);
  const w = await watcher();

  w.send({ type: "end_session", sessionId } as never);

  await victim.type("session_ended"); // the viewer is still kicked out
  await w.waitFor((m) => m.type === "sessions" && !lists(m, sessionId), "fleet drops it", 8_000);
  w.close();
  victim.close();
});

test("ending an unknown session id is a harmless no-op (daemon stays up)", async () => {
  const w = await watcher();
  w.send({ type: "end_session", sessionId: "does-not-exist" } as never);
  // A ping round-trip proves the daemon didn't crash on the bogus request.
  w.send({ type: "ping" } as never);
  await w.type("pong");
  w.close();
});
