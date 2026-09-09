import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ZoneMsg } from "./session-bus";
import { createSessionBus } from "./session-bus";
import { FakeWS, fakeStorage, shimDom } from "../testing/fake-ws";
import { IDLE_TURN, reduceTurn, type TurnState } from "../transcript/turn-state";
import { BACKOFF_MIN_MS } from "./ws";

// The session bus is the shell's one connection to the daemon: it owns the
// attach hello, the zone_reset-on-full-replay rule, the URL-as-session-identity
// contract, and every per-viewport correlation id. Driven here over the
// stubbed socket exactly as ws.test.ts drives SocketClient.

function setup(t: TestContext, pathname = "/s/abc12345") {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  FakeWS.instances = [];
  const g = globalThis as Record<string, unknown>;
  g.WebSocket = FakeWS;
  shimDom();
  const replaced: string[] = [];
  const assigned: string[] = [];
  g.location = { protocol: "http:", host: "shell.test", hash: "", pathname, search: "", assign: (u: string) => assigned.push(u) };
  g.history = { replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) };
  g.localStorage = fakeStorage();
  g.sessionStorage = fakeStorage();
  const bus = createSessionBus();
  const zone: ZoneMsg[] = [];
  bus.subscribe((m) => zone.push(m));
  const sock = () => FakeWS.instances.at(-1)!;
  sock().open();
  return { bus, zone, sock, replaced, assigned };
}

test("a session URL attaches on open, naming the last seq seen", (t) => {
  const { sock } = setup(t);
  const hello = sock().parsedSent()[0] as { type: string; sessionId?: string; afterSeq?: number };
  assert.equal(hello.type, "attach");
  assert.equal(hello.sessionId, "abc12345");
  assert.equal(hello.afterSeq, undefined, "a fresh page has no cursor to resume from");
});

test("no session in the URL sends nothing — the agent picker decides", (t) => {
  const { sock } = setup(t, "/");
  assert.equal(sock().sent.length, 0);
});

test("a full attach resets the zone before replay and adopts the URL; a resumed attach keeps everything", (t) => {
  const { zone, sock, replaced } = setup(t, "/");
  sock().receive({ type: "session_created", sessionId: "fresh1", cwd: "/w" });
  assert.deepEqual(zone.map((m) => m.type), ["zone_reset", "session_created"]);
  assert.deepEqual(replaced, ["/s/fresh1"]);
  zone.length = 0;
  sock().receive({ type: "session_created", sessionId: "fresh1", cwd: "/w", resumed: true });
  assert.deepEqual(zone.map((m) => m.type), ["session_created"], "a tail resume must not blank the transcript");
});

test("session_ended leaves for mission control instead of reaching the zone", (t) => {
  const { zone, sock, assigned } = setup(t);
  sock().receive({ type: "session_ended", sessionId: "abc12345" });
  assert.deepEqual(assigned, ["/"]);
  assert.equal(zone.some((m) => m.type === "session_ended"), false);
});

for (const ending of ["turn_end", "error"] as const) {
  test(`a quiet turn survives disconnect and empty tail resume, then settles on ${ending}`, (t) => {
    const { bus, zone, sock } = setup(t);
    let state: TurnState = IDLE_TURN;
    let connected = true;
    bus.subscribe((msg) => { state = reduceTurn(state, { kind: "message", msg }).state; });
    bus.onConnection((up) => {
      connected = up;
      if (!up) state = reduceTurn(state, { kind: "disconnected" }).state;
    });
    sock().receive({ type: "user_prompt", text: "run a quiet tool", seq: 1 });
    sock().receive({ type: "tool_use", name: "Bash", id: "tool", seq: 2 });
    sock().receive({ type: "permission_request", tool: "Bash", detail: "run", id: "ask", seq: 3 });
    const active = state;
    sock().finishClose();
    assert.equal(connected, false);
    assert.equal(state, active, "transport loss preserves work, activity, and permission state");
    t.mock.timers.tick(BACKOFF_MIN_MS);
    sock().open();
    assert.equal(connected, true);
    assert.equal((sock().parsedSent()[0] as { afterSeq?: number }).afterSeq, 3);
    zone.length = 0;
    sock().receive({ type: "session_created", sessionId: "abc12345", cwd: "/w", resumed: true, replayPending: true });
    sock().receive({ type: "replay_complete" });
    assert.equal(state.busy, true);
    assert.equal(state.openTurns, 1);
    assert.deepEqual(zone.map((m) => m.type), ["session_created", "replay_complete"]);
    sock().receive({ type: "permission_resolved", id: "ask", allow: true, seq: 4 });
    assert.deepEqual(state.asks, []);
    if (ending === "error") sock().receive({ type: "error", message: "tool failed", seq: 5 });
    else sock().receive({ type: "turn_end", seq: 5 });
    assert.equal(state.busy, false);
    assert.equal(state.openTurns, 0);
    assert.equal(state.activity, null);
    if (ending === "error") {
      sock().receive({ type: "turn_end", seq: 6 });
      assert.equal(state.openTurns, 0);
      assert.equal(state.errorAwaitingTurnEnd, false);
    }
  });
}

test("full replay reconstructs retained work; an idle session stays idle on tail resume", (t) => {
  const { bus, sock } = setup(t);
  let state: TurnState = IDLE_TURN;
  bus.subscribe((msg) => { state = reduceTurn(state, { kind: "message", msg }).state; });
  bus.onConnection((up) => {
    if (!up) state = reduceTurn(state, { kind: "disconnected" }).state;
  });
  sock().receive({ type: "user_prompt", text: "old", seq: 1 });
  sock().finishClose();
  t.mock.timers.tick(BACKOFF_MIN_MS);
  sock().open();
  sock().receive({ type: "session_created", sessionId: "abc12345", cwd: "/w", replayPending: true });
  assert.deepEqual(state, IDLE_TURN);
  sock().receive({ type: "user_prompt", text: "old", seq: 1, replay: true });
  sock().receive({ type: "tool_use", name: "Read", id: "tool", seq: 2, replay: true });
  sock().receive({ type: "replay_complete" });
  assert.equal(state.busy, true);
  assert.equal(state.openTurns, 1, "full replay does not double-count retained prompts");
  assert.deepEqual(state.activity, { state: "tool", label: "Read" });
  sock().receive({ type: "turn_end", seq: 3 });
  const idle = state;
  sock().finishClose();
  t.mock.timers.tick(BACKOFF_MIN_MS);
  sock().open();
  sock().receive({ type: "session_created", sessionId: "abc12345", cwd: "/w", resumed: true });
  sock().receive({ type: "replay_complete" });
  assert.equal(state, idle);
  assert.equal(state.busy, false);
});

test("every request mints a correlation id its frame carries, so each surface matches its own reply", (t) => {
  const { bus, sock } = setup(t);
  const before = sock().sent.length;
  const ids = {
    bang: bus.sendBang("ls"),
    listdir: bus.requestFsListdir("src"),
    changes: bus.requestFsChanges(),
    read: bus.requestFsRead("a.ts"),
    diff: bus.requestFsDiff("a.ts"),
    sub: bus.requestSubscription("status"),
    upload: bus.uploadBegin("f.txt", 3),
  };
  const frames = sock().parsedSent().slice(before) as { type: string; id?: string; path?: string }[];
  assert.deepEqual(
    frames.map((f) => [f.type, f.id]),
    [
      ["bang", ids.bang],
      ["fs_listdir", ids.listdir],
      ["fs_changes", ids.changes],
      ["fs_read", ids.read],
      ["fs_diff", ids.diff],
      ["subscription_status", ids.sub],
      ["file_upload_begin", ids.upload],
    ],
  );
  for (const [k, id] of Object.entries(ids)) assert.match(id, /^[a-z]+-[a-z0-9]{8}$/, `${k} id shape`);
  assert.equal(new Set(Object.values(ids)).size, 7, "ids are distinct");
});

test("a silent (!!) bang sends silent: true, and a plain ! sends no flag at all", (t) => {
  const { bus, sock } = setup(t);
  const before = sock().sent.length;
  bus.sendBang("ls");
  bus.sendBang("ls", true);
  const frames = sock().parsedSent().slice(before) as { type: string; silent?: unknown }[];
  assert.deepEqual(
    frames.map((f) => [f.type, "silent" in f, f.silent]),
    [
      ["bang", false, undefined],
      ["bang", true, true],
    ],
  );
});

test("connection listeners see transitions, and a relay refusal code arrives as its reason", (t) => {
  const { bus, sock } = setup(t);
  const seen: [boolean, string | undefined][] = [];
  bus.onConnection((c, refusal) => seen.push([c, refusal]));
  sock().finishClose(4003);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], false);
  assert.equal(typeof seen[0][1], "string", "a refusal code maps to a human reason");
});
