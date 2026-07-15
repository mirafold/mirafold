import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg } from "../protocol";
import { startDaemon, createSession, TestClient, type Daemon } from "../testing/itest-harness";

// #10 (viewport leak), Tier-2: the real daemon reaps a HALF-OPEN local viewport
// — a socket that stops responding but never sends `close` (tab navigated away,
// laptop slept). Without the server-side heartbeat its viewport would linger
// attached forever; with it, the silent socket is pinged, misses its pong, and
// is terminated (→ server-side `close` → registry.detach), so the session's
// viewport count returns to zero. Observed via a fleet watcher, not the dead
// socket itself. Short heartbeat; idle timeout kept long so the session itself
// survives long enough to observe the drop.

type Any = WireMsg & Record<string, any>;

let d: Daemon;

before(async () => {
  d = await startDaemon({ WS_HEARTBEAT_MS: "250", SESSION_IDLE_TIMEOUT_MS: "30000" });
});
after(async () => {
  await d.stop();
});

const viewportsOf = (m: WireMsg, sessionId: string): number | undefined =>
  m.type === "sessions"
    ? (m as Any).sessions.find((s: Any) => s.sessionId === sessionId)?.viewports
    : undefined;

test("a half-open viewport (silent socket, no close) is reaped by the heartbeat", async () => {
  const { client: victim, sessionId } = await createSession(d.port);

  // A watcher to observe the session's viewport count server-side.
  const w = new TestClient(d.port);
  await w.opened();
  await w.type("agents");
  w.send({ type: "watch_sessions" } as never);
  const snap = (await w.type("sessions")) as Any;
  assert.equal(viewportsOf(snap, sessionId), 1, "the creating viewport is attached");

  // Simulate half-open: pause the victim's socket so it reads nothing — in
  // particular it never auto-answers the server's protocol pings — and send NO
  // close. The server's `close` for this socket will never arrive on its own.
  victim.ws.pause();

  // The heartbeat must notice the missed pong, terminate the socket, and detach
  // its viewport — dropping the session's count to zero.
  await w.waitFor(
    (m) => viewportsOf(m, sessionId) === 0,
    "viewport count reaped to 0",
    8_000,
  );

  w.close();
});
