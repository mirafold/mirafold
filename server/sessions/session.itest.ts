import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg } from "../protocol";
import { startDaemon, createSession, TestClient, type Daemon } from "../testing/itest-harness";

// The mock-turn contract — every scripted MockSession hook drives the
// full wire path (adapter → registry broadcast → real socket), plus the DoS
// caps. One session is reused across the turn tests; caps get their own
// daemon so limits don't interfere (L.2b).

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

/** The first SEQUENCED frame of a turn — the echo. The unsequenced
 *  prompt_options catalog is emitted by the engine at activation, which is
 *  asynchronous to the first prompt: it lands ahead of the echo when the
 *  prompt follows creation at once, and under load otherwise. */
const firstSequenced = (turn: Any[]): Any => turn.find((m) => typeof m.seq === "number")!;

test("supportability: hello carries the version; errors and skew reach the log (R.4g)", async () => {
  const t = new TestClient(d.port);
  await t.opened();
  const hello = (await t.type("agents")) as Any;
  assert.match(hello.version, /^\d+\.\d+\.\d+/);
  // No relay configured (the harness scrubs every relay/entitlement var): the
  // hello says WHY, so the pair button can open the honest state instead of
  // vanishing. Local viewports only — see relay-service.itest for the remote side.
  assert.equal(hello.relay, undefined);
  assert.equal(hello.relayOff, "unentitled");

  // A viewport-scoped error (bad cwd) reaches the terminal, timestamped —
  // the daemon log is what a stranger pastes into a bug report.
  t.send({ type: "create", cwd: "/nonexistent/genui-r4g" } as never);
  const err = (await t.type("error")) as Any;
  assert.match(err.message, /no such directory/);
  // waitForLog, not an immediate logs(): the log rides stdout's pipe while
  // the error frame rides the socket — under load the frame wins the race.
  await d.waitForLog(
    /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[ws\] error: no such directory: \/nonexistent\/genui-r4g/,
    "bad-cwd error logged",
  );

  // A client announcing a different build is logged as version skew.
  t.send({ type: "attach", sessionId: "stale-id", clientVersion: "0.0.0-skew" } as never);
  await t.type("session_created"); // stale id → fallback create still works
  await d.waitForLog(/version skew: client v0\.0\.0-skew, daemon v\d+\.\d+\.\d+/, "version skew logged");

  // A forwarded front-end crash (client_error) lands in the same log, and a
  // malformed report is dropped without a wobble. ping/pong sequences them:
  // the pong proves both were processed before the log is read.
  t.send({ type: "client_error", message: "TypeError: boom in bundle.js:1:2", clientVersion: "0.0.0-skew" } as never);
  t.send({ type: "client_error", message: 12345 } as never);
  t.send({ type: "ping" } as never);
  await t.type("pong"); // proves both client_errors (incl. the malformed one) were processed, in order
  await d.waitForLog(
    /\[ws\] error: client error \(client v0\.0\.0-skew\): TypeError: boom in bundle\.js:1:2/,
    "client_error logged",
  );
  t.close();
});

test("attach to a gone session says so; create and live re-attach don't (R.4c)", async () => {
  // The server knows when it takes the fallback branch — the flag is what
  // lets the shell explain the swap instead of silently blanking.
  const t = new TestClient(d.port);
  await t.opened();
  await t.type("agents");
  t.send({ type: "attach", sessionId: "gone-after-restart" } as never);
  const sc = (await t.type("session_created")) as Any;
  assert.equal(sc.fallback, true);
  assert.notEqual(sc.sessionId, "gone-after-restart");

  // A deliberate create is not a fallback…
  const t2 = new TestClient(d.port);
  await t2.opened();
  await t2.type("agents");
  t2.send({ type: "create", agent: "claude-code" } as never);
  const sc2 = (await t2.type("session_created")) as Any;
  assert.equal(sc2.fallback, undefined);

  // …and neither is re-attaching to a session that exists.
  t.send({ type: "attach", sessionId: sc2.sessionId } as never);
  const sc3 = (await t.type("session_created")) as Any;
  assert.equal(sc3.sessionId, sc2.sessionId);
  assert.equal(sc3.fallback, undefined);

  t.close();
  t2.close();
});

test("an unknown ClientMsg type is ignored and the socket lives (R.4h)", async () => {
  // Ignore-unknown is the versioning story on the daemon side too: a newer
  // client bundle may send types this daemon predates. No error, no close —
  // and the very same socket then drives a full turn.
  c.send({ type: "warp_drive", factor: 9 } as never);
  c.sendRaw(JSON.stringify({ type: "even_less_known" }));
  const turn = await runTurn(c, "still here after unknown frames");
  assert.equal(firstSequenced(turn).type, "user_prompt");
  assert.equal(turn[turn.length - 1].type, "turn_end");
  assert.ok(!turn.some((m) => m.type === "error"));
});

test("a template turn follows the full wire grammar", async () => {
  const turn = await runTurn(c, "hello from the integration suite");

  const first = firstSequenced(turn);
  assert.equal(first.type, "user_prompt");
  assert.equal(first.text, "hello from the integration suite");
  // Skipping the catalog above must not hide a regression that emits it per
  // turn: across this client's life (one activation, one attach) it appears
  // at most twice, never once per prompt.
  assert.ok(
    c.received.filter((m) => m.type === "prompt_options").length <= 2,
    "prompt_options re-emitted per turn",
  );

  // seq strictly increases across the whole broadcast stream. The one frame
  // the registry deliberately never sequences is the replaceable
  // prompt_options catalog (it may land mid-turn under load — test-audit
  // 2026-08-26: comparing its `undefined` seq failed 2 of 3 loaded runs).
  const unsequenced = turn.filter((m) => typeof m.seq !== "number");
  assert.deepEqual([...new Set(unsequenced.map((m) => m.type))], unsequenced.length ? ["prompt_options"] : [], "only prompt_options may ride unsequenced");
  const seqs = turn.filter((m) => typeof m.seq === "number").map((m) => m.seq as number);
  for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i] > seqs[i - 1], `seq ${seqs[i]} after ${seqs[i - 1]}`);

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

test("subagent hook: a parallel fan-out — children nest under their own spawn, finishes out of order (SA.1)", async () => {
  const turn = await runTurn(c, "delegate this to a subagent");
  const tasks = turn.filter((m) => m.type === "tool_use" && m.name === "Task");
  assert.equal(tasks.length, 3);
  for (const t of tasks) assert.equal(t.parentId, undefined);
  const taskIds = new Set(tasks.map((t) => t.id));
  const inner = turn.filter((m) => m.type === "tool_use" && !taskIds.has(m.id));
  assert.ok(inner.length >= 9);
  for (const t of inner) assert.ok(taskIds.has(t.parentId), "child tags its own spawn");
  // Each spawn resolves with its own report…
  const settles = turn.filter((m) => m.type === "tool_result" && taskIds.has(m.id));
  assert.equal(settles.length, 3);
  // …and NOT in spawn order: the second-spawned (fastest) settles first —
  // the out-of-order truth the cards render.
  assert.notDeepEqual(settles.map((r) => r.id), tasks.map((t) => t.id));
  assert.equal(settles[0].id, tasks[1].id);
  // The narration lane over the REAL daemon broadcast (test-audit
  // 2026-08-14: this path was only e2e-covered): each spawn's prose rides
  // parented, and the registry's coalescer never merged one agent's words
  // into another's — every parented delta names a real spawn, and each
  // agent's own narration arrives intact.
  const prose = turn.filter((m) => m.type === "text_delta" && m.parentId !== undefined);
  assert.equal(prose.length, 3, "one narration per subagent rode the wire");
  for (const p of prose) assert.ok(taskIds.has(p.parentId), "prose names a real spawn");
  assert.equal(new Set(prose.map((p) => p.parentId)).size, 3, "no cross-parent merge");
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
  // The mock's artifact is fully knowable — pin it, not "non-empty"
  // (test-audit 2026-08-26).
  assert.equal(art.title, "bridge demo");
  assert.match(art.html, /id="b"/, "the bridge demo's counter button rides the html");
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

test("permission sync: the answer reaches the OTHER viewport as permission_resolved, before the tool moves", async () => {
  // Two viewports on one session — the 2026-07-28 bug: viewport A's bar sat
  // until turn_end after B answered, and a tap on the stale ask was a silent
  // no-op at the adapter (the phone-hangs report).
  const { client: a, sessionId } = await createSession(d.port);
  const b = new TestClient(d.port);
  await b.opened();
  await b.type("agents");
  b.send({ type: "attach", sessionId } as never);
  await b.type("session_created");

  a.send({ type: "prompt", text: "run something dangerous" });
  const askA = (await a.type("permission_request")) as Any;
  const askB = (await b.type("permission_request")) as Any;
  assert.equal(askB.id, askA.id);

  b.send({ type: "permission_response", id: askB.id, allow: true } as never);
  // A's very NEXT frame is the resolution — ahead of the allowed tool's own
  // frames, so the bar clears the moment the answer lands, never at turn_end.
  const next = (await a.waitFor(() => true, "frame after the ask", 20_000)) as Any;
  assert.equal(next.type, "permission_resolved", `expected the resolution first, got ${next.type}`);
  assert.equal(next.id, askA.id);
  assert.equal(next.allow, true);
  await a.type("turn_end", 20_000);
  await b.type("turn_end", 20_000);
  a.close();
  b.close();
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
  // The aborted turn never speaks again: the ONLY frame allowed after its
  // turn_end is the shell's replaceable prompt_options catalog, which may
  // land under load and is not the turn speaking (test-audit 2026-08-26: an
  // exact frame count failed 1 of 3 loaded runs; a denylist of turn types
  // let a stray `usage` through — cold review). Everything else is a
  // regression, whatever its type.
  const stragglers = (c.received.slice(count) as Any[]).filter((m) => m.type !== "prompt_options");
  assert.deepEqual(stragglers.map((m) => m.type), [], `the aborted turn spoke again: ${stragglers.map((m) => m.type).join(",")}`);
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
    const ask = (await client.type("permission_request")) as Any;
    // The auto-deny is announced like any answer (2026-07-28) — the bar on a
    // slow-to-notice phone drops instead of inviting a stale tap. type()
    // consumes forward, so this also pins resolved BEFORE turn_end.
    const resolved = (await client.type("permission_resolved", 20_000)) as Any;
    assert.equal(resolved.id, ask.id);
    assert.equal(resolved.allow, false);
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
