import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WireMsg } from "../protocol";
import {
  attachSession,
  startDaemon,
  createSession,
  TestClient,
  type Daemon,
} from "../testing/itest-harness";

// The `!` passthrough (4.9) over a real PTY — and its core security
// promise: bang_input is EPHEMERAL. Data written to a running command's stdin
// must never appear in any viewport's stream, the session ring buffer, or the
// server logs, while the command's own output flows normally (L.2b).

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
  const { client: b } = await attachSession(d.port, sessionId);

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
  const { client: late } = await attachSession(d.port, sessionId);
  await late.waitFor((m) => m.type === "bang_end", "replayed bang_end");
  assert.ok(!JSON.stringify(late.received).includes(SECRET));
  // while the command's own output DID replay (buffered, unlike the input).
  assert.ok(JSON.stringify(late.received).includes("pw-len:17"));
  // …and not in the server logs.
  assert.ok(!d.logs().includes(SECRET));

  b.close();
  late.close();
});

test("runaway ! output is capped on the wire, in replay, and can't evict the ring (R.4d)", async () => {
  // Its own daemon with a small cap so the test doesn't shovel 10 MB around.
  const CAP = 8192;
  const bd = await startDaemon({ BANG_OUTPUT_CAP_BYTES: String(CAP) });
  const { client, sessionId: sid } = await createSession(bd.port);

  // Real transcript content first — the thing a runaway command used to evict.
  client.send({ type: "prompt", text: "plan it step by step" } as never);
  await client.waitFor(
    (m) => m.type === "text_delta" && /Plan complete/.test((m as Any).text),
    "mock turn text",
    30_000,
  );
  await client.type("turn_end", 30_000);

  // ~200 KB of output against an 8 KB cap.
  client.send({
    type: "bang",
    id: "big1",
    command: "head -c 200000 /dev/zero | tr '\\0' x",
  } as never);
  await client.type("bang_start");
  await client.type("bang_end", 20_000);

  const wire = (client.received as Any[])
    .filter((m) => m.type === "bang_output")
    .map((m) => m.data)
    .join("");
  // Head + the two honest markers, nothing near 200 KB.
  assert.ok(wire.length < CAP + 300, `wire carried ${wire.length} bytes`);
  assert.match(wire, /output cap reached/);
  assert.match(wire, /\(… \d+ bytes elided …\)/);

  // A fresh viewport's replay is bounded the same way, and the earlier
  // turn's transcript is still in the ring.
  const { client: late } = await attachSession(bd.port, sid);
  await late.waitFor((m) => m.type === "bang_end", "replayed bang_end");
  const replay = (late.received as Any[])
    .filter((m) => m.type === "bang_output")
    .map((m) => m.data)
    .join("");
  assert.ok(replay.length < CAP + 300, `replay carried ${replay.length} bytes`);
  assert.match(replay, /output cap reached/);
  assert.ok(JSON.stringify(late.received).includes("Plan complete"), "ring evicted the transcript");

  client.close();
  late.close();
  await bd.stop();
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
  // session-stream errors are mirrored to the daemon log, timestamped (R.4g).
  // waitForLog, not an immediate logs() assert: the log rides stdout's pipe
  // while the error frame rides the socket, and under CPU load the frame
  // wins the race into this process (the C.1 runner flake).
  await bad.waitForLog(/Z\] \[session \w+\] error: ! failed to start/, "spawn-fail logged");

  // The daemon survived the keystroke: the same session still runs a full
  // turn over the same socket.
  client.send({ type: "prompt", text: "still alive?" } as never);
  await client.type("turn_end", 30_000);

  client.close();
  await bad.stop();
});

test("bang `cd` persists inside the workspace, escapes reset with the terminal's notice, and every transcript triggers an agent turn", async () => {
  const bd = await startDaemon();
  // realpath'd up front: the daemon realpaths the captured cwd, so the
  // assertions must compare like with like (macOS /tmp is a symlink).
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mirafold-bang-cwd-")));
  mkdirSync(path.join(root, "child"));
  const client = new TestClient(bd.port);
  await client.opened();
  await client.type("agents");
  client.send({ type: "create", agent: "claude-code", cwd: root } as never);
  await client.type("session_created");

  const bang = async (id: string, command: string) => {
    client.send({ type: "bang", id, command } as never);
    await client.waitFor((m) => m.type === "bang_end" && (m as Any).id === id, `bang_end ${id}`, 20_000);
  };
  const outputOf = (id: string) =>
    (client.received as Any[])
      .filter((m) => m.type === "bang_output" && m.id === id)
      .map((m) => m.data)
      .join("");

  // `cd child` sticks: the NEXT command runs there. And though no prompt is
  // ever typed in this test, a turn follows each bang — the transcript
  // reached the agent immediately (the mock answers every pushPrompt).
  await bang("cwd1", "cd child");
  await client.type("turn_end", 30_000);
  await bang("cwd2", "pwd");
  assert.ok(outputOf("cwd2").includes(path.join(root, "child")), "cd did not persist");
  await client.type("turn_end", 30_000);

  // Escaping above the workspace is undone and announced, like the terminal.
  await bang("cwd3", "cd ../..");
  const notice = (await client.type("notice", 20_000)) as Any;
  assert.equal(notice.text, `Shell cwd was reset to ${root}`);
  await client.type("turn_end", 30_000);
  await bang("cwd4", "pwd");
  const back = outputOf("cwd4");
  assert.ok(back.includes(root), "cwd lost entirely after the reset");
  assert.ok(!back.includes(path.join(root, "child")), "reset did not land on the root");

  client.close();
  await bd.stop();
});

test("a silent `!!` bang runs, shows, replays and persists its cd — and the agent never hears of it", async () => {
  const bd = await startDaemon();
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "mirafold-bang-silent-")));
  mkdirSync(path.join(root, "child"));
  const client = new TestClient(bd.port);
  await client.opened();
  await client.type("agents");
  client.send({ type: "create", agent: "claude-code", cwd: root } as never);
  await client.type("session_created");
  const outputOf = (id: string) =>
    (client.received as Any[])
      .filter((m) => m.type === "bang_output" && m.id === id)
      .map((m) => m.data)
      .join("");
  const modelTraffic = () =>
    (client.received as Any[]).filter((m) => m.type === "turn_end" || m.type === "text_delta").length;

  // The silent form: the start frame carries the flag (so every viewport and
  // the replay ring draw `!!`), the output flows, the cd sticks…
  client.send({ type: "bang", id: "s1", command: "cd child && echo shell-only", silent: true } as never);
  const start = (await client.type("bang_start")) as Any;
  assert.equal(start.silent, true);
  await client.waitFor((m) => m.type === "bang_end" && (m as Any).id === "s1", "bang_end s1", 20_000);
  assert.match(outputOf("s1"), /shell-only/);
  // …and the mock — which answers EVERY pushPrompt with a turn — stays
  // silent, because no prompt was ever pushed.
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(modelTraffic(), 0, "a silent bang must not start a model turn");

  // The cd carried into the next command, and a plain `!` still hands its
  // transcript to the agent — the seam works both ways in one session.
  client.send({ type: "bang", id: "p1", command: "pwd" } as never);
  const plain = (await client.type("bang_start")) as Any;
  assert.equal("silent" in plain, false, "a plain bang carries no silent flag");
  await client.waitFor((m) => m.type === "bang_end" && (m as Any).id === "p1", "bang_end p1", 20_000);
  assert.ok(outputOf("p1").includes(path.join(root, "child")), "the silent cd did not persist");
  await client.type("turn_end", 30_000);

  // A late viewport replays the silent row with its flag intact.
  const { client: late } = await attachSession(bd.port, (client.received as Any[]).find((m) => m.type === "session_created")!.sessionId);
  const replayed = (await late.waitFor(
    (m) => m.type === "bang_start" && (m as Any).id === "s1",
    "replayed silent bang_start",
  )) as Any;
  assert.equal(replayed.silent, true);

  late.close();
  client.close();
  await bd.stop();
});

test("a command that swaps the cwd handoff for a FIFO can't stall the daemon (audit f.3)", async () => {
  const bd = await startDaemon();
  const { client } = await createSession(bd.port);
  // Clear our EXIT trap, replace the handoff file with a FIFO: without the
  // lstat gate the daemon's readFileSync would block its whole event loop.
  client.send({
    type: "bang",
    id: "fifo1",
    command: 'trap - EXIT; rm -f "$MIRAFOLD_BANG_CWD_FILE"; mkfifo "$MIRAFOLD_BANG_CWD_FILE"; echo swapped',
  } as never);
  await client.waitFor((m) => m.type === "bang_end" && (m as Any).id === "fifo1", "fifo1 end", 20_000);
  // bang_end broadcasts BEFORE the handoff read — a stalled loop shows up
  // here as an unanswered ping.
  client.send({ type: "ping" } as never);
  await client.type("pong", 5_000);
  client.close();
  await bd.stop();
});

test("bang burst throttle: a too-fast second bang is refused with a clean end (audit f.5)", async () => {
  const bd = await startDaemon({ BANG_MIN_INTERVAL_MS: "60000" });
  const { client } = await createSession(bd.port);
  client.send({ type: "bang", id: "r1", command: "true" } as never);
  await client.waitFor((m) => m.type === "bang_end" && (m as Any).id === "r1", "r1 end", 20_000);
  client.send({ type: "bang", id: "r2", command: "true" } as never);
  const err = (await client.type("error")) as Any;
  assert.match(err.message, /too fast/);
  // The refusal pairs a bang_end so every viewport's bang bar clears.
  const end = (await client.waitFor(
    (m) => m.type === "bang_end" && (m as Any).id === "r2",
    "r2 end",
  )) as Any;
  assert.equal(end.exitCode, null);
  client.close();
  await bd.stop();
});

test("one bang at a time; bang_kill force-stops even a HUP-ignoring command", async () => {
  // `echo up` first: bang_start alone doesn't prove the child is attached,
  // and killing a PTY before its process fully spawns can surface as a clean
  // exit instead of signal death under CPU load (the C.1 runner flake) —
  // wait for output, which only a live process can produce.
  // The PTY library's default kill is SIGHUP. A shell can ignore it, so the
  // old implementation left this command running and later called its
  // natural exit "killed" merely because Stop had once been requested.
  c.send({
    type: "bang",
    id: "b2",
    command: "trap '' HUP; echo up; sleep 30; exit 7",
  } as never);
  await c.type("bang_start");
  await c.waitFor((m) => m.type === "bang_output" && /up/.test((m as Any).data), "b2 live");
  c.send({ type: "bang", id: "b3", command: "echo nope" } as never);
  const err = (await c.type("error")) as Any;
  assert.match(err.message, /already running/);
  c.send({ type: "bang_kill", id: "b2" } as never);
  const end = (await c.type("bang_end", 20_000)) as Any;
  assert.equal(end.id, "b2");
  assert.equal(end.exitCode, null); // signal death, not a clean exit
});
