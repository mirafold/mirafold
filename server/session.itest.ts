import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg } from "./protocol";
import { startDaemon, createSession, TestClient, type Daemon } from "./itest-harness";

// L.2b: the mock-turn contract — every scripted MockSession hook drives the
// full wire path (adapter → registry broadcast → real socket), plus the DoS
// caps. One session is reused across the turn tests; caps get their own
// daemon so limits don't interfere.

type Any = WireMsg & Record<string, any>;

let d: Daemon;
let c: TestClient;

before(async () => {
  d = await startDaemon();
  ({ client: c } = await createSession(d.port));
});
after(async () => {
  c.close();
  await d.stop();
});

/** Send a prompt and return every frame of the turn, user_prompt→turn_end. */
async function runTurn(client: TestClient, text: string): Promise<Any[]> {
  const from = client.mark();
  client.send({ type: "prompt", text });
  await client.type("turn_end", 20_000);
  return client.received.slice(from) as Any[];
}

test("a template turn follows the full wire grammar", async () => {
  const turn = await runTurn(c, "hello from the integration suite");

  assert.equal(turn[0].type, "user_prompt");
  assert.equal(turn[0].text, "hello from the integration suite");

  // seq strictly increases across the whole broadcast stream.
  const seqs = turn.map((m) => m.seq as number);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1]);

  const types = turn.map((m) => m.type);
  assert.ok(types.includes("thinking_delta"));
  assert.ok(types.includes("text_delta"));
  assert.equal(types.filter((t) => t === "render").length, 1);
  assert.equal(types.filter((t) => t === "usage").length, 1);
  assert.equal(types.filter((t) => t === "turn_end").length, 1);
  assert.ok(types.indexOf("usage") < types.indexOf("turn_end"));
  assert.equal(types[types.length - 1], "turn_end");

  // Every tool_use has a matching tool_result, matched by id.
  const uses = turn.filter((m) => m.type === "tool_use");
  assert.ok(uses.length >= 1);
  for (const u of uses) {
    assert.ok(turn.some((m) => m.type === "tool_result" && m.id === u.id));
  }

  const usage = turn.find((m) => m.type === "usage")!;
  assert.equal(usage.model, "mock-sonnet");
  assert.ok(usage.inputTokens > 0 && usage.outputTokens > 0);
});

test("checklist hook: one render id, statuses progressing in place", async () => {
  const turn = await runTurn(c, "plan it step by step");
  const frames = turn.filter((m) => m.type === "render" && m.component === "todo-list");
  assert.equal(frames.length, 5);
  assert.equal(new Set(frames.map((f) => f.id)).size, 1); // update-in-place
  const statuses = (f: Any) => f.props.todos.map((t: Any) => t.status);
  assert.deepEqual(statuses(frames[0]), ["in_progress", "pending", "pending", "pending"]);
  assert.deepEqual(statuses(frames[4]), ["completed", "completed", "completed", "completed"]);
});

test("subagent hook: inner calls nest under the Task id", async () => {
  const turn = await runTurn(c, "delegate this to a subagent");
  const task = turn.find((m) => m.type === "tool_use" && m.name === "Task")!;
  assert.equal(task.parentId, undefined);
  const inner = turn.filter((m) => m.type === "tool_use" && m.id !== task.id);
  assert.ok(inner.length >= 3);
  for (const t of inner) assert.equal(t.parentId, task.id);
  // The Task itself resolves last, un-nested.
  const results = turn.filter((m) => m.type === "tool_result");
  assert.equal(results[results.length - 1].id, task.id);
});

test("huge-output hook: the cap reports truncatedBytes, never a silent cut", async () => {
  const turn = await runTurn(c, "show me a huge output");
  const result = turn.find((m) => m.type === "tool_result")!;
  assert.ok((result.truncatedBytes ?? 0) > 0);
  assert.ok(result.output.length < 110_000); // well under the raw ~110KB
});

test("artifact hook: sandboxed html rides the artifact message", async () => {
  const turn = await runTurn(c, "show me an artifact");
  const art = turn.find((m) => m.type === "artifact")!;
  assert.ok(art.html.length > 0);
  assert.ok(typeof art.id === "string" && art.id.length > 0);
});

test("permission allow: the held tool runs after permission_response", async () => {
  const from = c.mark();
  c.send({ type: "prompt", text: "run something dangerous" });
  const ask = (await c.type("permission_request")) as Any;
  c.send({ type: "permission_response", id: ask.id, allow: true } as never);
  await c.type("turn_end", 20_000);
  const turn = c.received.slice(from) as Any[];
  const use = turn.find((m) => m.type === "tool_use")!;
  assert.equal(use.name, "Bash");
  assert.match(use.detail ?? "", /rm -rf/);
  assert.ok(turn.some((m) => m.type === "tool_result" && m.id === use.id));
});

test("permission deny: no tool runs, the turn still ends", async () => {
  const from = c.mark();
  c.send({ type: "prompt", text: "run something dangerous" });
  const ask = (await c.type("permission_request")) as Any;
  c.send({ type: "permission_response", id: ask.id, allow: false } as never);
  await c.type("turn_end", 20_000);
  const cont = c.received.slice(from) as Any[];
  assert.ok(!cont.some((m) => m.type === "tool_use"));
  const text = cont.filter((m) => m.type === "text_delta").map((m) => m.text).join("");
  assert.match(text, /won't run/);
});

test("interrupt mid-turn: the stream stops dead and the turn still ends", async () => {
  c.send({ type: "prompt", text: "tell me a long story" });
  await c.waitFor(
    (m) => m.type === "thinking_delta" || m.type === "text_delta",
    "first delta",
    20_000,
  );
  c.send({ type: "interrupt" });
  await c.type("turn_end", 20_000);
  const count = c.received.length;
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(c.received.length, count); // the aborted turn never speaks again
  // The session takes the next turn cleanly.
  const next = await runTurn(c, "still alive?");
  assert.equal(next[next.length - 1].type, "turn_end");
});

test("component tool action: mediated server-side, broadcast as a tool row pair", async () => {
  c.send({
    type: "action",
    action: { kind: "tool", name: "workspace_ls", args: { path: "." } },
    sourceId: "r-test",
  });
  const use = (await c.type("tool_use")) as Any;
  assert.equal(use.name, "workspace_ls");
  assert.match(use.detail ?? "", /component action \(r-test\)/);
  const result = (await c.waitFor(
    (m) => m.type === "tool_result" && (m as Any).id === use.id,
    "action result",
  )) as Any;
  assert.equal(result.isError, false);
  assert.match(result.output, /package\.json/); // the session cwd (repo root) listed
});

test("off-allowlist component action: rejected server-side, reported as an error row", async () => {
  c.send({
    type: "action",
    action: { kind: "tool", name: "secret_exfil" },
    sourceId: "r-evil",
  });
  const use = (await c.type("tool_use")) as Any;
  const result = (await c.waitFor(
    (m) => m.type === "tool_result" && (m as Any).id === use.id,
    "rejected result",
  )) as Any;
  assert.equal(result.isError, true);
  assert.match(result.output, /not allowlisted/);
});

test("prompt-kind component action: echoes as a user turn and runs it", async () => {
  c.send({
    type: "action",
    action: { kind: "prompt", text: "clicked follow-up" },
    sourceId: "r-test",
  });
  const echo = (await c.type("user_prompt")) as Any;
  assert.equal(echo.text, "clicked follow-up");
  await c.type("turn_end", 20_000); // the click became a real turn
});

test("permission timeout: nobody answers → deny by default, the turn still ends", async () => {
  const quick = await startDaemon({ PERMISSION_TIMEOUT_MS: "700" });
  try {
    const { client } = await createSession(quick.port);
    const from = client.mark();
    client.send({ type: "prompt", text: "run something dangerous" });
    await client.type("permission_request");
    await client.type("turn_end", 20_000); // no permission_response ever sent
    const turn = client.received.slice(from) as Any[];
    assert.ok(!turn.some((m) => m.type === "tool_use")); // the held tool never ran
    const text = turn.filter((m) => m.type === "text_delta").map((m) => m.text).join("");
    assert.match(text, /won't run/);
    client.close();
  } finally {
    await quick.stop();
  }
});

test("session cap: create past the limit errors without crashing the socket", async () => {
  const capped = await startDaemon({ MAX_SESSIONS: "1" });
  try {
    const { sessionId } = await createSession(capped.port);
    const c2 = new TestClient(capped.port);
    await c2.opened();
    await c2.type("agents");
    c2.send({ type: "create" } as never);
    const err = (await c2.type("error")) as Any;
    assert.match(err.message, /session limit reached \(1\)/);
    // The socket survived the rejected create and can still attach.
    c2.send({ type: "attach", sessionId } as never);
    const joined = (await c2.type("session_created")) as Any;
    assert.equal(joined.sessionId, sessionId);
    c2.close();
  } finally {
    await capped.stop();
  }
});

test("oversized frame: closed with 1009, not an unbounded allocation", async () => {
  const small = await startDaemon({ MAX_WS_PAYLOAD: "10000" });
  try {
    const c3 = new TestClient(small.port);
    await c3.opened();
    c3.sendRaw("x".repeat(20_000));
    assert.equal((await c3.closed).code, 1009);
  } finally {
    await small.stop();
  }
});
