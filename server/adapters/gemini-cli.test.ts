import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import type { WireMsg } from "../protocol";
import { GeminiCliSession } from "./gemini-cli";
import type { GeminiModelCatalog } from "./gemini-model-list";

// L.2b2: the Gemini JSONL→WireMsg mapping and the turn grammar. The real
// adapter spawns a real child — a scripted stub substituted via
// MIRAFOLD_GEMINI_BIN that replays a JSONL fixture ($FAKE_EVENTS), optionally
// hangs ($FAKE_HANG) or exits nonzero ($FAKE_EXIT). No model, no network,
// but the full spawn → line-split → handleEvent → exit path runs as shipped.

type Any = WireMsg & Record<string, any>;

let tmp: string;
let stub: string;

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "genui-gemini-test-"));
  stub = path.join(tmp, "gemini");
  writeFileSync(
    stub,
    // `exec` so SIGTERM hits the sleeping process itself — a forked sleep
    // would hold the stdout pipe open and the adapter's `close` never fires.
    // FAKE_ARGS_LOG records the latest spawn's argv (one arg per ---ARG---
    // separator) for the -m / guidance-injection assertions.
    '#!/usr/bin/env bash\n[ -n "$FAKE_ARGS_LOG" ] && printf \'%s\\n---ARG---\\n\' "$@" > "$FAKE_ARGS_LOG"\n[ -n "$FAKE_EVENTS" ] && cat "$FAKE_EVENTS"\n[ -n "$FAKE_STDERR" ] && echo "$FAKE_STDERR" >&2\n[ -n "$FAKE_HANG" ] && exec sleep 30\nexit "${FAKE_EXIT:-0}"\n',
  );
  chmodSync(stub, 0o755);
  process.env.MIRAFOLD_GEMINI_BIN = stub;
});
after(() => {
  delete process.env.MIRAFOLD_GEMINI_BIN;
  delete process.env.FAKE_EVENTS;
  delete process.env.FAKE_HANG;
  delete process.env.FAKE_EXIT;
  delete process.env.FAKE_STDERR;
  delete process.env.FAKE_ARGS_LOG;
  rmSync(tmp, { recursive: true, force: true });
});

function makeSession(opts: Partial<ConstructorParameters<typeof GeminiCliSession>[0]> = {}) {
  const s = new GeminiCliSession({ workspaceDir: mkdtempSync(path.join(tmp, "ws-")), ...opts });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  const turnEnds = () => msgs.filter((m) => m.type === "turn_end").length;
  const awaitTurnEnd = (count = 1, timeoutMs = 10_000) =>
    new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        if (turnEnds() >= count) {
          clearInterval(poll);
          resolve();
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(poll);
          reject(new Error(`no turn_end #${count}; seen: ${msgs.map((m) => m.type).join(",")}`));
        }
      }, 10);
    });
  return { s, msgs, turnEnds, awaitTurnEnd };
}

test("an unparseable .gemini/settings.json is backed up beside the rewrite, a valid one is merged", async () => {
  // Unparseable: rewritten, but the user's original bytes land in the backup.
  const ws = mkdtempSync(path.join(tmp, "ws-"));
  const dir = path.join(ws, ".gemini");
  const file = path.join(dir, "settings.json");
  const garbage = '{ "theirs": true, // not JSON\n';
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, garbage);
  const a = new GeminiCliSession({ workspaceDir: ws });
  const rewritten = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(rewritten.security.auth.selectedType, "gemini-api-key");
  assert.equal(readFileSync(`${file}.mirafold-backup`, "utf8"), garbage);
  a.close();

  // Valid: merged in place, their keys preserved, no backup written.
  const ws2 = mkdtempSync(path.join(tmp, "ws-"));
  const file2 = path.join(ws2, ".gemini", "settings.json");
  mkdirSync(path.dirname(file2), { recursive: true });
  writeFileSync(file2, JSON.stringify({ theirs: 1, mcpServers: { own: { command: "x" } } }));
  const b = new GeminiCliSession({ workspaceDir: ws2 });
  const merged = JSON.parse(readFileSync(file2, "utf8"));
  assert.equal(merged.theirs, 1);
  assert.equal(merged.mcpServers.own.command, "x");
  assert.equal(merged.security.auth.selectedType, "gemini-api-key");
  assert.throws(() => readFileSync(`${file2}.mirafold-backup`));
  b.close();
});

function fixture(name: string, lines: (Record<string, unknown> | string)[]) {
  const file = path.join(tmp, name);
  writeFileSync(
    file,
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n",
  );
  process.env.FAKE_EVENTS = file;
}

test("happy stream: full JSONL→WireMsg mapping, exactly one turn_end", async () => {
  fixture("happy.jsonl", [
    { type: "init", model: "gemini-2.5-pro" },
    "ripgrep warning: not json", // non-JSON noise must be skipped
    { type: "message", role: "user", content: "echo of our own prompt" }, // ignored
    { type: "message", role: "assistant", content: "the reply" },
    { type: "tool_use", tool_name: "run_shell_command", tool_id: "t1", parameters: { command: "ls" } },
    { type: "tool_result", tool_id: "t1", status: "success", output: "file.txt" },
    // genui render with an explicit id in params (update-in-place) — must
    // paint a render, never a tool row.
    { type: "tool_use", tool_name: "mcp_mirafold_render_card", tool_id: "r1", parameters: { title: "T", id: "keep-me" } },
    { type: "tool_result", tool_id: "r1", status: "success", output: "Rendered card (id: ignored-1234)" },
    // genui artifact without an id — takes the stub-assigned one from output.
    { type: "tool_use", tool_name: "mcp_mirafold_emit_artifact", tool_id: "r2", parameters: { html: "<b>x</b>", title: "demo" } },
    { type: "tool_result", tool_id: "r2", status: "success", output: "Rendered artifact (id: abcd1234-5678)" },
    // failed genui call → suppressed entirely.
    { type: "tool_use", tool_name: "mcp_mirafold_render_table", tool_id: "r3", parameters: { columns: ["a"] } },
    { type: "tool_result", tool_id: "r3", status: "error", output: "nope" },
    // a result for an id never announced → dropped, no orphan row.
    { type: "tool_result", tool_id: "orphan", status: "success", output: "never announced" },
    { type: "error", message: "minor complaint" },
    { type: "result", stats: { input_tokens: 123, output_tokens: 45 } },
  ]);
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession();
  s.pushPrompt("go");
  await awaitTurnEnd();

  assert.ok(msgs.every((m) => m.seq === undefined)); // seq is the registry's
  const text = msgs.filter((m) => m.type === "text_delta").map((m) => m.text).join("");
  assert.equal(text, "the reply"); // the user echo never painted

  const uses = msgs.filter((m) => m.type === "tool_use");
  assert.deepEqual(uses.map((u) => [u.name, u.id, u.detail]), [["run_shell_command", "t1", "ls"]]);
  const results = msgs.filter((m) => m.type === "tool_result");
  assert.deepEqual(results.map((r) => r.id), ["t1"]); // genui + orphan results never row

  const render = msgs.find((m) => m.type === "render")!;
  assert.equal(render.component, "card");
  assert.equal(render.id, "keep-me"); // explicit param id wins
  assert.deepEqual(render.props, { title: "T" });

  const art = msgs.find((m) => m.type === "artifact")!;
  assert.equal(art.html, "<b>x</b>");
  assert.equal(art.id, "abcd1234-5678"); // parsed from the stub's output text

  assert.equal(msgs.filter((m) => m.type === "render" || m.type === "artifact").length, 2);
  assert.equal(msgs.find((m) => m.type === "error")!.message, "minor complaint");

  const usage = msgs.find((m) => m.type === "usage")!;
  assert.equal(usage.model, "gemini-2.5-pro"); // init set the label
  assert.equal(usage.inputTokens, 123);
  assert.equal(usage.outputTokens, 45);

  assert.equal(turnEnds(), 1);
  assert.equal(msgs[msgs.length - 1].type, "turn_end");
  s.close();
});

test("F.3 honest model: init 'auto' is replaced by the real models from result.stats", async () => {
  // Router mode reports model:"auto" at init; the concrete model(s) it used
  // appear only in result.stats.models — the status bar must show those.
  fixture("auto.jsonl", [
    { type: "init", model: "auto" },
    { type: "message", role: "assistant", content: "reply" },
    {
      type: "result",
      stats: {
        input_tokens: 5,
        output_tokens: 3,
        models: { "gemini-2.5-flash": { calls: 1 }, "gemini-2.5-pro": { calls: 1 } },
      },
    },
  ]);
  const { s, msgs, awaitTurnEnd } = makeSession();
  s.pushPrompt("go");
  await awaitTurnEnd();
  const model = msgs.find((m) => m.type === "usage")!.model;
  assert.notEqual(model, "auto");
  assert.match(model!, /gemini-2\.5-flash/);
  assert.match(model!, /gemini-2\.5-pro/);
  // The fleet/status-bar label follows the refinement too (2026-07-28 fix:
  // modelName stayed "auto" while only the usage line named what ran).
  assert.equal(s.modelName, model);
  s.close();
});

test("F.3 honest model: a concrete init model is kept even if stats.models is present", async () => {
  fixture("concrete.jsonl", [
    { type: "init", model: "gemini-2.5-pro" },
    { type: "result", stats: { input_tokens: 1, output_tokens: 1, models: { "gemini-2.5-flash": {} } } },
  ]);
  const { s, msgs, awaitTurnEnd } = makeSession();
  s.pushPrompt("go");
  await awaitTurnEnd();
  assert.equal(msgs.find((m) => m.type === "usage")!.model, "gemini-2.5-pro"); // init wins
  s.close();
});

test("capOutput applies at the adapter seam", async () => {
  fixture("huge.jsonl", [
    { type: "tool_use", tool_name: "run_shell_command", tool_id: "h1", parameters: { command: "cat log" } },
    { type: "tool_result", tool_id: "h1", status: "success", output: "x".repeat(70_000) },
    { type: "result", stats: { input_tokens: 1, output_tokens: 1 } },
  ]);
  const { s, msgs, awaitTurnEnd } = makeSession();
  s.pushPrompt("go");
  await awaitTurnEnd();
  const r = msgs.find((m) => m.type === "tool_result")!;
  assert.ok((r.truncatedBytes ?? 0) > 0);
  assert.ok(r.output.length < 70_000);
  s.close();
});

test("F.4 stderr-only non-zero exit surfaces as an error, not a silent turn", async () => {
  // The trust-folder trap: Gemini writes the error to stderr, exits nonzero,
  // and emits NOTHING on stdout. Before F.4 the turn ended silently.
  delete process.env.FAKE_EVENTS; // no stdout at all
  process.env.FAKE_STDERR = "Error: the current folder is not a trusted folder";
  process.env.FAKE_EXIT = "55";
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession();
  s.pushPrompt("go");
  await awaitTurnEnd();
  delete process.env.FAKE_STDERR;
  delete process.env.FAKE_EXIT;

  const err = msgs.find((m) => m.type === "error");
  assert.ok(err, `expected an error WireMsg; saw ${msgs.map((m) => m.type).join(",")}`);
  assert.match(err.message, /trusted folder/);
  assert.match(err.message, /55/);
  const types = msgs.map((m) => m.type);
  assert.ok(types.indexOf("error") < types.lastIndexOf("turn_end")); // error before turn_end
  assert.equal(turnEnds(), 1);
  s.close();
});

test("F.4 does not fire when stdout carried events (a normal error event stays single)", async () => {
  // A turn that DID emit stdout events must not also get the stderr-tail error,
  // even on a nonzero exit — sawEvent gates it.
  fixture("with-stdout.jsonl", [{ type: "message", role: "assistant", content: "partial" }]);
  process.env.FAKE_STDERR = "some incidental stderr noise";
  process.env.FAKE_EXIT = "1";
  const { s, msgs, awaitTurnEnd } = makeSession();
  s.pushPrompt("go");
  await awaitTurnEnd();
  delete process.env.FAKE_STDERR;
  delete process.env.FAKE_EXIT;
  assert.ok(!msgs.some((m) => m.type === "error")); // stdout events → no F.4 error
  s.close();
});

test("crash (exit with no result event): still exactly one turn_end, no usage", async () => {
  fixture("crash.jsonl", [{ type: "message", role: "assistant", content: "partial…" }]);
  process.env.FAKE_EXIT = "1";
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession();
  s.pushPrompt("go");
  await awaitTurnEnd();
  delete process.env.FAKE_EXIT;
  assert.equal(turnEnds(), 1);
  assert.ok(!msgs.some((m) => m.type === "usage"));
  s.close();
});

test("spawn failure: error WireMsg, then exactly one turn_end", async () => {
  process.env.MIRAFOLD_GEMINI_BIN = path.join(tmp, "does-not-exist");
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession();
  s.pushPrompt("go");
  await awaitTurnEnd();
  process.env.MIRAFOLD_GEMINI_BIN = stub;
  const types = msgs.map((m) => m.type);
  assert.match(msgs.find((m) => m.type === "error")!.message, /gemini spawn failed/);
  assert.ok(types.indexOf("error") < types.indexOf("turn_end"));
  assert.equal(turnEnds(), 1);
  s.close();
});

test("id-mode self-heal: a fatal --resume flips the next turn back to --session-id", async () => {
  // The brick sequence (2026-07-23): turn 1 fails before Gemini persists the
  // session (here: an auth-style exit 41, no stdout), turn 2 then runs
  // `--resume` against an id that was never saved and Gemini exits 42
  // (FATAL_INPUT_ERROR) doing nothing. Before the fix every later turn
  // repeated that doomed --resume forever; now the exit-42-no-events close
  // flips the mode, so turn 3 creates the session fresh.
  const argsLog = path.join(tmp, "args-heal.log");
  delete process.env.FAKE_EVENTS;
  process.env.FAKE_STDERR = "auth is broken";
  process.env.FAKE_EXIT = "41";
  const { s, msgs, awaitTurnEnd } = makeSession();
  try {
    s.pushPrompt("one");
    await awaitTurnEnd(1);

    process.env.FAKE_ARGS_LOG = argsLog;
    process.env.FAKE_STDERR = "Error resuming session: No previous sessions found for this project.";
    process.env.FAKE_EXIT = "42";
    s.pushPrompt("two");
    await awaitTurnEnd(2);
    let args = spawnArgs(argsLog);
    assert.ok(args.includes("--resume"), `turn 2 resumed; argv: ${args.join(" ")}`);

    delete process.env.FAKE_STDERR;
    delete process.env.FAKE_EXIT;
    fixture("heal.jsonl", [{ type: "result", stats: { input_tokens: 1, output_tokens: 1 } }]);
    s.pushPrompt("three");
    await awaitTurnEnd(3);
    args = spawnArgs(argsLog);
    assert.ok(args.includes("--session-id"), `turn 3 healed to create; argv: ${args.join(" ")}`);
    assert.ok(!args.includes("--resume"));
    assert.ok(msgs.some((m) => m.type === "usage")); // turn 3 actually ran
  } finally {
    delete process.env.FAKE_ARGS_LOG;
    delete process.env.FAKE_STDERR;
    delete process.env.FAKE_EXIT;
  }
  s.close();
});

test("id-mode self-heal, mirror image: a fatal --session-id flips the next turn to --resume", async () => {
  // Gemini's other id fatal: --session-id naming a session that ALREADY
  // exists (same exit 42, no events). The flip direction reverses.
  const argsLog = path.join(tmp, "args-heal2.log");
  delete process.env.FAKE_EVENTS;
  process.env.FAKE_ARGS_LOG = argsLog;
  process.env.FAKE_STDERR = 'Error starting session: Session ID "x" already exists.';
  process.env.FAKE_EXIT = "42";
  const { s, awaitTurnEnd } = makeSession();
  try {
    s.pushPrompt("one");
    await awaitTurnEnd(1);
    let args = spawnArgs(argsLog);
    assert.ok(args.includes("--session-id"), `turn 1 created; argv: ${args.join(" ")}`);

    delete process.env.FAKE_STDERR;
    delete process.env.FAKE_EXIT;
    fixture("heal2.jsonl", [{ type: "result", stats: { input_tokens: 1, output_tokens: 1 } }]);
    s.pushPrompt("two");
    await awaitTurnEnd(2);
    args = spawnArgs(argsLog);
    assert.ok(args.includes("--resume"), `turn 2 healed to resume; argv: ${args.join(" ")}`);
  } finally {
    delete process.env.FAKE_ARGS_LOG;
    delete process.env.FAKE_STDERR;
    delete process.env.FAKE_EXIT;
  }
  s.close();
});

test("no self-heal when exit 42 arrives after stdout events (a different failure)", async () => {
  // resolveSessionId's fatals exit before any event, so 42 WITH events is
  // some other input error — the id mode was fine; don't flip it.
  const argsLog = path.join(tmp, "args-noheal.log");
  fixture("noheal.jsonl", [{ type: "message", role: "assistant", content: "partial" }]);
  process.env.FAKE_EXIT = "0";
  const { s, awaitTurnEnd } = makeSession();
  try {
    s.pushPrompt("one"); // clean first turn → session established
    await awaitTurnEnd(1);

    process.env.FAKE_EXIT = "42";
    s.pushPrompt("two"); // 42 but stdout carried events
    await awaitTurnEnd(2);

    process.env.FAKE_ARGS_LOG = argsLog;
    delete process.env.FAKE_EXIT;
    s.pushPrompt("three");
    await awaitTurnEnd(3);
    const args = spawnArgs(argsLog);
    assert.ok(args.includes("--resume"), `still resuming; argv: ${args.join(" ")}`);
  } finally {
    delete process.env.FAKE_ARGS_LOG;
    delete process.env.FAKE_EXIT;
  }
  s.close();
});

test("interrupt kills the child: exactly one turn_end, session takes the next turn", async () => {
  delete process.env.FAKE_EVENTS;
  process.env.FAKE_HANG = "1";
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession();
  s.pushPrompt("hang");
  await new Promise((r) => setTimeout(r, 400)); // let the child start
  s.interrupt();
  await awaitTurnEnd(1);
  assert.equal(turnEnds(), 1);

  // The worker loop survives an interrupted turn — a fresh prompt runs.
  delete process.env.FAKE_HANG;
  fixture("next.jsonl", [{ type: "result", stats: { input_tokens: 1, output_tokens: 1 } }]);
  s.pushPrompt("again");
  await awaitTurnEnd(2);
  assert.equal(turnEnds(), 2);
  assert.ok(msgs.some((m) => m.type === "usage"));
  s.close();
});

// ---- V.2 /model parity (Gemini half) ----------------------------------------

const catalog = (n: number): GeminiModelCatalog => ({
  models: [
    { id: "auto", displayName: "Auto", description: "Let Gemini CLI decide" },
    ...Array.from({ length: n - 1 }, (_, i) => ({
      id: `gemini-m${i}`,
      displayName: `gemini-m${i}`,
      description: "",
    })),
  ],
  currentModelId: "auto",
});

/** The latest spawn's argv, as recorded by the stub via FAKE_ARGS_LOG. */
function spawnArgs(log: string): string[] {
  const parts = readFileSync(log, "utf8").split("\n---ARG---\n");
  parts.pop(); // trailing separator
  return parts;
}

test("bare /model paints the picker from the catalog — no engine spawn", async () => {
  // A missing binary would surface "gemini spawn failed" — its absence proves
  // the picker consumed no engine turn.
  process.env.MIRAFOLD_GEMINI_BIN = path.join(tmp, "does-not-exist");
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession({ listModels: async () => catalog(4) });
  s.pushPrompt("/model");
  await awaitTurnEnd();
  process.env.MIRAFOLD_GEMINI_BIN = stub;

  assert.ok(!msgs.some((m) => m.type === "error"));
  const p = msgs.find((m) => m.type === "picker")!;
  assert.ok(p, "picker rendered");
  const rows = p.rows as { label: string; text: string; detail?: string; current?: boolean }[];
  assert.equal(rows.length, 4);
  assert.equal(rows[0].label, "Auto");
  assert.equal(rows[0].current, true); // engine's currentModelId marks
  assert.equal(rows[0].text, "/model set auto"); // pick = Gemini's own syntax
  assert.equal(rows[0].detail, "Let Gemini CLI decide");
  assert.equal(rows[1].label, "gemini-m0");
  assert.ok(p.hint?.includes("/model set <model-id>"));
  assert.equal(turnEnds(), 1);
  s.close();
});

test("a large catalog rides the same picker — no row cap, no degraded form", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession({ listModels: async () => catalog(6) });
  s.pushPrompt("/model manage"); // terminal's dialog verb routes here too
  await awaitTurnEnd();
  const p = msgs.find((m) => m.type === "picker")!;
  assert.equal((p.rows as unknown[]).length, 6);
  assert.equal((p.rows as { current?: boolean }[])[0].current, true);
  s.close();
});

test("a configured model wins the (current) marker over the engine default", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession({
    model: "gemini-m1",
    listModels: async () => catalog(4),
  });
  s.pushPrompt("/model");
  await awaitTurnEnd();
  const rows = msgs.find((m) => m.type === "picker")!.rows as {
    label: string;
    current?: boolean;
  }[];
  assert.deepEqual(
    rows.map((r) => r.label + (r.current ? " (current)" : "")),
    ["Auto", "gemini-m0", "gemini-m1 (current)", "gemini-m2"],
  );
  s.close();
});

test("/model set switches: label immediately, -m on the next spawn", async () => {
  const argsLog = path.join(tmp, "args-switch.log");
  process.env.FAKE_ARGS_LOG = argsLog;
  fixture("switch.jsonl", [{ type: "result", stats: { input_tokens: 1, output_tokens: 1 } }]);
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession();
  s.pushPrompt("/model set gemini-9");
  await awaitTurnEnd();
  delete process.env.FAKE_ARGS_LOG;

  assert.equal(turnEnds(), 1); // the switch is its own turn, engine-free
  assert.equal(s.modelName, "gemini-9");
  const text = msgs.filter((m) => m.type === "text_delta").map((m) => m.text).join("");
  assert.match(text, /Model set to gemini-9\./);

  process.env.FAKE_ARGS_LOG = argsLog;
  s.pushPrompt("hi");
  await awaitTurnEnd(2);
  delete process.env.FAKE_ARGS_LOG;
  const args = spawnArgs(argsLog);
  assert.equal(args[args.indexOf("-m") + 1], "gemini-9");
  s.close();
});

test("/model set without a name (or flag-shaped names) shows the usage line", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession();
  s.pushPrompt("/model set --persist");
  await awaitTurnEnd();
  assert.equal(s.modelName, undefined); // nothing switched — still unknown
  const text = msgs.filter((m) => m.type === "text_delta").map((m) => m.text).join("");
  assert.match(text, /Usage: `\/model set <model-name> \[--persist\]`/);
  s.close();
});

test("/model set --persist applies the switch with an honest scope note", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession();
  s.pushPrompt("/model set gemini-9 --persist");
  await awaitTurnEnd();
  assert.equal(s.modelName, "gemini-9");
  const text = msgs.filter((m) => m.type === "text_delta").map((m) => m.text).join("");
  assert.match(text, /lasts this session/);
  s.close();
});

test("a failed catalog read surfaces an honest error, never a made-up list", async () => {
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession({
    listModels: async () => {
      throw new Error("acp exploded");
    },
  });
  s.pushPrompt("/model");
  await awaitTurnEnd();
  assert.ok(!msgs.some((m) => m.type === "render"));
  assert.match(msgs.find((m) => m.type === "error")!.message, /acp exploded/);
  assert.equal(turnEnds(), 1);
  s.close();
});

test("guidance skips slash-leading turns and rides the first prose turn instead", async () => {
  // Headless Gemini only recognizes a slash command at position 0 — a
  // guidance-prefixed "/stats" would demote it to chat (observed live
  // 2026-07-19). The prose turn that follows still gets the one-time prepend.
  const argsLog = path.join(tmp, "args-guidance.log");
  process.env.FAKE_ARGS_LOG = argsLog;
  fixture("guidance.jsonl", [{ type: "result", stats: { input_tokens: 1, output_tokens: 1 } }]);
  const { s, awaitTurnEnd } = makeSession();
  try {
    s.pushPrompt("/stats");
    await awaitTurnEnd(1);
    let args = spawnArgs(argsLog);
    assert.equal(args[args.indexOf("-p") + 1], "/stats"); // verbatim, command intact

    s.pushPrompt("hello");
    await awaitTurnEnd(2);
    args = spawnArgs(argsLog);
    const prompt = args[args.indexOf("-p") + 1];
    assert.match(prompt, /## Generative UI/);
    assert.match(prompt, /hello$/);

    s.pushPrompt("again");
    await awaitTurnEnd(3);
    args = spawnArgs(argsLog);
    assert.equal(args[args.indexOf("-p") + 1], "again"); // one-time prepend
  } finally {
    delete process.env.FAKE_ARGS_LOG;
  }
  s.close();
});
