import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { SessionMeta, WireMsg } from "../protocol";
import { startDaemon, createSession, TestClient, type Daemon } from "../testing/itest-harness";

// Phase M.1, Tier-2: the cockpit metadata a fleet watcher's `sessions`
// snapshots carry — activity, the pending-permission queue, folded usage,
// createdAt — observed over the real socket against the real daemon
// (mock-forced), end to end through the registry's notify/coalesce path.
// The deterministic per-transition pins live in registry.test.ts (Tier 1).

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
  w.send({ type: "watch_sessions" });
  await w.type("sessions");
  return w;
}

const row = (m: WireMsg, id: string): SessionMeta | undefined =>
  m.type === "sessions"
    ? ((m as Any).sessions as SessionMeta[]).find((s) => s.sessionId === id)
    : undefined;

test("activity appears while a turn works and clears at idle; createdAt is stable", async () => {
  const { client, sessionId } = await createSession(d.port);
  const w = await watcher();
  const first = row(w.received.at(-1) as WireMsg, sessionId);
  assert.ok(first, "the watcher's first snapshot lists the session");
  const created = first.createdAt;
  assert.ok(typeof created === "number" && created > 0, "createdAt on the first snapshot");

  client.send({ type: "prompt", text: "hello cockpit" });
  const working = await w.waitFor(
    (m) => !!row(m, sessionId)?.activity,
    "a snapshot carrying activity",
  );
  const act = row(working, sessionId)!.activity!;
  assert.ok(act.label.length > 0, "activity has a label");
  assert.ok(act.since > 0, "activity has a start time");

  const idle = await w.waitFor(
    (m) => row(m, sessionId)?.status === "idle",
    "the turn-end snapshot",
    20_000,
  );
  const r = row(idle, sessionId)!;
  assert.equal(r.activity, undefined, "activity cleared at idle");
  assert.equal(r.createdAt, created, "createdAt stable across snapshots");
  w.close();
  client.close();
});

test("a dangerous prompt surfaces the pending permission; the in-session answer clears it", async () => {
  const { client, sessionId } = await createSession(d.port);
  const w = await watcher();

  client.send({ type: "prompt", text: "do something dangerous" });
  const held = await w.waitFor(
    (m) => (row(m, sessionId)?.permissions?.length ?? 0) > 0,
    "a snapshot with the pending permission",
  );
  const r = row(held, sessionId)!;
  assert.equal(r.status, "permission");
  assert.equal(r.permissions![0].tool, "Bash");
  assert.ok(r.permissions![0].detail.includes("rm -rf"), "the row names WHAT it wants");

  // Answer over the existing in-session path; the queue must clear with the hold.
  const req = (await client.type("permission_request")) as Any;
  assert.equal(req.id, r.permissions![0].id, "the row carries the real request id");
  client.send({ type: "permission_response", id: req.id, allow: true });

  const moved = await w.waitFor(
    (m) => {
      const s = row(m, sessionId);
      return !!s && s.status !== "permission" && !s.permissions;
    },
    "the post-answer snapshot with the queue cleared",
    20_000,
  );
  assert.ok(moved);
  w.close();
  client.close();
});

test("usage folds across turns: tokens sum, and no cost is invented", async () => {
  const { client, sessionId } = await createSession(d.port);
  const w = await watcher();

  client.send({ type: "prompt", text: "first turn" });
  const u1 = (await client.type("usage")) as Any;
  await client.type("turn_end");
  const s1 = await w.waitFor(
    (m) => row(m, sessionId)?.status === "idle" && !!row(m, sessionId)?.usage,
    "first idle snapshot with usage",
    20_000,
  );
  const t1 = row(s1, sessionId)!.usage!;
  assert.equal(t1.inputTokens, u1.inputTokens);
  assert.equal(t1.outputTokens, u1.outputTokens);
  assert.equal(t1.costUsd, undefined, "the mock reports no cost; none is invented");

  client.send({ type: "prompt", text: "second turn" });
  const u2 = (await client.type("usage")) as Any;
  await client.type("turn_end");
  const s2 = await w.waitFor(
    (m) =>
      row(m, sessionId)?.status === "idle" &&
      (row(m, sessionId)?.usage?.inputTokens ?? 0) > t1.inputTokens,
    "second idle snapshot with the folded total",
    20_000,
  );
  const t2 = row(s2, sessionId)!.usage!;
  assert.equal(t2.inputTokens, u1.inputTokens + u2.inputTokens, "tokens SUM across turns");
  assert.equal(t2.outputTokens, u1.outputTokens + u2.outputTokens);
  w.close();
  client.close();
});

// ---- M.2: acting from the grid — the sessionId-addressed acts over the real
// socket. (The remote/relay gate is pinned in-process in fleet-acts.test.ts,
// where the `remote` flag is directly in hand.)

test("grid allow: a watcher's answer_permission lets the tool run", async () => {
  const { client, sessionId } = await createSession(d.port);
  const w = await watcher();
  client.send({ type: "prompt", text: "do something dangerous" });
  const held = await w.waitFor(
    (m) => (row(m, sessionId)?.permissions?.length ?? 0) > 0,
    "pending permission on the row",
  );
  const perm = row(held, sessionId)!.permissions![0];

  w.send({ type: "answer_permission", sessionId, id: perm.id, allow: true });

  const tool = (await client.waitFor(
    (m) => m.type === "tool_use" && (m as Any).name === "Bash",
    "the allowed tool runs in the session",
    20_000,
  )) as Any;
  assert.ok(tool.detail.includes("rm -rf"), "the mock's dangerous command ran");
  await client.type("turn_end", 20_000);
  await w.waitFor(
    (m) => {
      const s = row(m, sessionId);
      return !!s && !s.permissions;
    },
    "the row's queue cleared",
    20_000,
  );
  w.close();
  client.close();
});

test("grid deny: the command does not run and the turn ends honestly", async () => {
  const { client, sessionId } = await createSession(d.port);
  const w = await watcher();
  client.send({ type: "prompt", text: "do something dangerous" });
  const held = await w.waitFor(
    (m) => (row(m, sessionId)?.permissions?.length ?? 0) > 0,
    "pending permission on the row",
  );
  const perm = row(held, sessionId)!.permissions![0];

  const from = client.mark();
  w.send({ type: "answer_permission", sessionId, id: perm.id, allow: false });
  await client.type("turn_end", 20_000);
  assert.ok(
    !client.received.slice(from).some((m) => m.type === "tool_use"),
    "denied — no tool ran",
  );
  w.close();
  client.close();
});

test("grid interrupt halts the turn; the session stays warm for the next prompt", async () => {
  const { client, sessionId } = await createSession(d.port);
  const w = await watcher();
  client.send({ type: "prompt", text: "a long turn to interrupt" });
  await w.waitFor((m) => row(m, sessionId)?.status === "working", "working on the row");

  w.send({ type: "interrupt_session", sessionId });
  await client.type("turn_end", 20_000);

  client.send({ type: "prompt", text: "still alive?" });
  await client.type("turn_end", 20_000);
  w.close();
  client.close();
});

test("prompt_session dispatches a turn from the grid", async () => {
  const { client, sessionId } = await createSession(d.port);
  const w = await watcher();
  w.send({ type: "prompt_session", sessionId, text: "dispatched from the cockpit" });
  const echo = (await client.waitFor(
    (m) => m.type === "user_prompt",
    "the echoed command strip",
  )) as Any;
  assert.equal(echo.text, "dispatched from the cockpit");
  await client.type("turn_end", 20_000);
  w.close();
  client.close();
});

test("unknown-session acts error; malformed acts are ignored; the daemon survives", async () => {
  const w = await watcher();
  w.send({ type: "prompt_session", sessionId: "nope", text: "x" });
  await w.waitFor(
    (m) => m.type === "error" && (m as Any).message.includes("no such session"),
    "error for the unknown prompt target",
  );
  w.send({ type: "answer_permission", sessionId: "nope", id: "p", allow: true });
  await w.waitFor((m) => m.type === "error", "error for the unknown answer target");
  w.send({ type: "interrupt_session", sessionId: "nope" });
  await w.waitFor((m) => m.type === "error", "error for the unknown interrupt target");

  w.sendRaw(JSON.stringify({ type: "prompt_session", sessionId: 5, text: 7 }));
  w.sendRaw(JSON.stringify({ type: "answer_permission" }));
  w.send({ type: "ping" });
  await w.type("pong");
  w.close();
});
