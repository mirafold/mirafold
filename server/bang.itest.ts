import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { WireMsg } from "./protocol";
import { startDaemon, createSession, TestClient, type Daemon } from "./itest-harness";

// L.2b: the `!` passthrough (4.9) over a real PTY — and its core security
// promise: bang_input is EPHEMERAL. Data written to a running command's stdin
// must never appear in any viewport's stream, the session ring buffer, or the
// server logs, while the command's own output flows normally.

type Any = WireMsg & Record<string, any>;

const SECRET = "SECRETXYZ-hunter2"; // 17 chars — the length the command echoes

let d: Daemon;
let c: TestClient;
let sessionId: string;

before(async () => {
  d = await startDaemon();
  ({ client: c, sessionId } = await createSession(d.port));
});
after(async () => {
  c.close();
  await d.stop();
});

test("bang secrets invariant: stdin data is ephemeral, output is not", async () => {
  const { client: b } = (await (async () => {
    const other = new TestClient(d.port);
    await other.opened();
    await other.type("agents");
    other.send({ type: "attach", sessionId } as never);
    await other.type("session_created");
    return { client: other };
  })()) as { client: TestClient };

  // `read -s` turns off tty echo, like a password prompt; the command then
  // reveals only the LENGTH of what it read — proof the input arrived.
  c.send({
    type: "bang",
    id: "b1",
    command: 'echo ready; read -s pw; echo "pw-len:${#pw}"',
  } as never);
  await c.type("bang_start");
  await c.waitFor((m) => m.type === "bang_output" && /ready/.test((m as Any).data), "ready");
  await new Promise((r) => setTimeout(r, 300)); // let read -s take the tty
  c.send({ type: "bang_input", id: "b1", data: `${SECRET}\n` } as never);

  const end = (await c.type("bang_end", 20_000)) as Any;
  assert.equal(end.exitCode, 0);

  const output = (c.received as Any[])
    .filter((m) => m.type === "bang_output")
    .map((m) => m.data)
    .join("");
  assert.match(output, /pw-len:17/); // the input reached the PTY…

  // …but the input itself is nowhere: not in either viewport's stream,
  for (const viewport of [c, b]) {
    assert.ok(!JSON.stringify(viewport.received).includes(SECRET));
  }
  // not in the ring buffer (a fresh attach replays it in full),
  const late = new TestClient(d.port);
  await late.opened();
  await late.type("agents");
  late.send({ type: "attach", sessionId } as never);
  await late.type("session_created");
  await late.waitFor((m) => m.type === "bang_end", "replayed bang_end");
  assert.ok(!JSON.stringify(late.received).includes(SECRET));
  // while the command's own output DID replay (buffered, unlike the input).
  assert.ok(JSON.stringify(late.received).includes("pw-len:17"));
  // …and not in the server logs.
  assert.ok(!d.logs().includes(SECRET));

  b.close();
  late.close();
});

test("a failing shell spawn errors the session, never the daemon (R.4f)", async () => {
  // Its own daemon: the bad SHELL must poison only this one.
  const bad = await startDaemon({ SHELL: "/nonexistent/genui-itest-shell" });
  const { client } = await createSession(bad.port);

  client.send({ type: "bang", id: "bf", command: "echo hi" } as never);
  await client.type("bang_start");
  const err = (await client.type("error")) as Any;
  assert.match(err.message, /shell not found: \/nonexistent\/genui-itest-shell/);
  const end = (await client.type("bang_end")) as Any;
  assert.equal(end.id, "bf");
  assert.equal(end.exitCode, null);

  // The daemon survived the keystroke: the same session still runs a full
  // turn over the same socket.
  client.send({ type: "prompt", text: "still alive?" } as never);
  await client.type("turn_end", 30_000);

  client.close();
  await bad.stop();
});

test("one bang at a time; bang_kill ends it with a null exit code", async () => {
  c.send({ type: "bang", id: "b2", command: "sleep 30" } as never);
  await c.type("bang_start");
  c.send({ type: "bang", id: "b3", command: "echo nope" } as never);
  const err = (await c.type("error")) as Any;
  assert.match(err.message, /already running/);
  c.send({ type: "bang_kill", id: "b2" } as never);
  const end = (await c.type("bang_end", 20_000)) as Any;
  assert.equal(end.id, "b2");
  assert.equal(end.exitCode, null); // signal death, not a clean exit
});
