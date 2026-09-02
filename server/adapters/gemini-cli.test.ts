import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { chmodSync, existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import type { WireMsg } from "../protocol";
import { GeminiCliSession, geminiRenderMcpConfig } from "./gemini-cli";
import type { GeminiModelCatalog } from "./gemini-model-list";
import { isWorkspaceTrusted } from "../sessions/workspace-trust";
import { MIRAFOLD_MCP, renderMcpCommand } from "./render-mcp-cmd";
import { MIRAFOLD_CONTEXT } from "../render-tools";

const RENDER_MCP_COMMAND = renderMcpCommand().command;

// L.2b2: the Gemini JSONL→WireMsg mapping and the turn grammar. The real
// adapter spawns a real child — a scripted stub substituted via
// MIRAFOLD_GEMINI_BIN that replays a JSONL fixture ($FAKE_EVENTS), optionally
// hangs ($FAKE_HANG) or exits nonzero ($FAKE_EXIT). No model, no network,
// but the full spawn → line-split → handleEvent → exit path runs as shipped.

type Any = WireMsg & Record<string, any>;

let tmp: string;
let stub: string;
let trustRecord: string;

before(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "genui-gemini-test-"));
  stub = path.join(tmp, "gemini");
  writeFileSync(
    stub,
    // `exec` so SIGTERM hits the sleeping process itself — a forked sleep
    // would hold the stdout pipe open and the adapter's `close` never fires.
    // FAKE_ARGS_LOG records the latest spawn's argv (one arg per ---ARG---
    // separator) for the -m / guidance-injection assertions.
    '#!/usr/bin/env bash\n[ -n "$FAKE_ARGS_LOG" ] && { printf \'%s\\n---ARG---\\n\' "$@" > "$FAKE_ARGS_LOG"; printf \'ENV_TRUST=%s\\nENV_RUN_AS_NODE=%s\\n\' "$GEMINI_CLI_TRUST_WORKSPACE" "${ELECTRON_RUN_AS_NODE-unset}" >> "$FAKE_ARGS_LOG"; }\n[ -n "$FAKE_EVENTS" ] && cat "$FAKE_EVENTS"\n[ -n "$FAKE_STDERR" ] && echo "$FAKE_STDERR" >&2\n[ -n "$FAKE_HANG" ] && exec sleep 30\nexit "${FAKE_EXIT:-0}"\n',
  );
  chmodSync(stub, 0o755);
  process.env.MIRAFOLD_GEMINI_BIN = stub;
  // P.6b: a turn now waits on the folder-trust ask in an untrusted workspace.
  // Every session below lives under `tmp`, so trusting that root once keeps
  // these tests about the JSONL mapping — the gate itself has its own tests.
  trustRecord = path.join(tmp, "trusted-workspaces.json");
  writeFileSync(trustRecord, JSON.stringify([tmp]));
  process.env.MIRAFOLD_WORKSPACE_TRUST_FILE = trustRecord;
});
after(() => {
  delete process.env.MIRAFOLD_GEMINI_BIN;
  delete process.env.MIRAFOLD_WORKSPACE_TRUST_FILE;
  delete process.env.FAKE_EVENTS;
  delete process.env.FAKE_HANG;
  delete process.env.FAKE_EXIT;
  delete process.env.FAKE_STDERR;
  delete process.env.FAKE_ARGS_LOG;
  rmSync(tmp, { recursive: true, force: true });
});

/** Wire message capture + turn_end waiting for an already-constructed session. */
function attach(s: GeminiCliSession) {
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
  return { msgs, turnEnds, awaitTurnEnd };
}

function makeSession(opts: Partial<ConstructorParameters<typeof GeminiCliSession>[0]> = {}) {
  const s = new GeminiCliSession({ workspaceDir: mkdtempSync(path.join(tmp, "ws-")), ...opts });
  return { s, ...attach(s) };
}

test("recovery and discovery: Gemini resumes the saved id and advertises only its implemented /model", async () => {
  const argsLog = path.join(tmp, "resume-args.txt");
  process.env.FAKE_ARGS_LOG = argsLog;
  const { s, msgs, awaitTurnEnd } = makeSession({
    resumeId: "22222222-2222-4222-8222-222222222222",
  });
  s.refreshPromptOptions();
  assert.deepEqual(
    msgs.find((msg) => msg.type === "prompt_options"),
    {
      type: "prompt_options",
      options: [
        {
          trigger: "/",
          value: "/model",
          label: "model",
          description: "choose what model to use",
          kind: "command",
        },
      ],
    },
  );

  s.pushPrompt("continue");
  await awaitTurnEnd();
  const args = spawnArgs(argsLog);
  const resumeAt = args.indexOf("--resume");
  assert.ok(resumeAt >= 0);
  assert.equal(args[resumeAt + 1], s.resumeId);
  s.close();
  delete process.env.FAKE_ARGS_LOG;
});

test("Gemini remains supported without a Mirafold retirement notice", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession();
  s.pushPrompt("hello");
  await awaitTurnEnd();
  assert.equal(
    msgs.some(
      (m) =>
        m.type === "notice" &&
        /retired|deprecated|sunset|will be removed/i.test(m.text),
    ),
    false,
  );
  s.close();
});

test("Gemini inherits the user's MCP server set instead of allowlisting only Mirafold", async () => {
  const argsLog = path.join(tmp, "mcp-inheritance-args.txt");
  process.env.FAKE_ARGS_LOG = argsLog;
  fixture("mcp-inheritance.jsonl", [
    { type: "result", status: "success", stats: { input_tokens: 1, output_tokens: 1 } },
  ]);
  const { s, awaitTurnEnd } = makeSession();
  try {
    s.pushPrompt("hello");
    await awaitTurnEnd();
    const args = spawnArgs(argsLog);
    assert.equal(
      args.includes("--allowed-mcp-server-names"),
      false,
      "the CLI flag is an allowlist that blocks every user-configured MCP server not named Mirafold",
    );
    assert.match(readFileSync(argsLog, "utf8"), /ENV_RUN_AS_NODE=unset/);
  } finally {
    delete process.env.FAKE_ARGS_LOG;
    s.close();
  }
});

test("Gemini maps Electron Node mode to its MCP `env` field", () => {
  const childEnv = { ELECTRON_RUN_AS_NODE: "1" };
  assert.deepEqual(
    geminiRenderMcpConfig({
      command: "/runtime/Mirafold",
      args: ["/app/render-mcp.js"],
      childEnv,
    }),
    {
      command: "/runtime/Mirafold",
      args: ["/app/render-mcp.js"],
      env: childEnv,
      trust: true,
    },
  );
});

test("a pre-existing settings.json — broken or valid — is untouched at construction; a turn is what earns consent to merge it", async () => {
  // Unparseable: construction touches NOTHING. Only once a turn actually runs
  // (this workspace is pre-trusted, under `tmp`) does the rewrite+backup happen.
  const ws = mkdtempSync(path.join(tmp, "ws-"));
  const dir = path.join(ws, ".gemini");
  const file = path.join(dir, "settings.json");
  const garbage = '{ "theirs": true, // not JSON\n';
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, garbage);
  const a = new GeminiCliSession({ workspaceDir: ws });
  assert.equal(readFileSync(file, "utf8"), garbage, "construction never opens a pre-existing file");
  assert.throws(() => readFileSync(`${file}.mirafold-backup`), "no backup before consent exists");
  const { awaitTurnEnd: aAwaitTurnEnd } = attach(a);
  a.pushPrompt("hello");
  await aAwaitTurnEnd();
  const afterTurn = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(afterTurn.security.auth.selectedType, "gemini-api-key");
  assert.equal(afterTurn.mcpServers[MIRAFOLD_MCP].command, RENDER_MCP_COMMAND);
  assert.equal(readFileSync(`${file}.mirafold-backup`, "utf8"), garbage, "backup lands once the rewrite is earned");
  a.close();

  // Valid: also untouched at construction; merged in place — their keys
  // preserved, no backup — only once a turn runs.
  const ws2 = mkdtempSync(path.join(tmp, "ws-"));
  const file2 = path.join(ws2, ".gemini", "settings.json");
  const original2 = JSON.stringify({ theirs: 1, mcpServers: { own: { command: "x" } } });
  mkdirSync(path.dirname(file2), { recursive: true });
  writeFileSync(file2, original2);
  const b = new GeminiCliSession({ workspaceDir: ws2 });
  assert.equal(readFileSync(file2, "utf8"), original2, "construction never opens a pre-existing file");
  const { awaitTurnEnd: bAwaitTurnEnd } = attach(b);
  b.pushPrompt("hello");
  await bAwaitTurnEnd();
  const bAfterTurn = JSON.parse(readFileSync(file2, "utf8"));
  assert.equal(bAfterTurn.theirs, 1);
  assert.equal(bAfterTurn.mcpServers.own.command, "x", "the user's own entry survives the merge");
  assert.equal(bAfterTurn.mcpServers[MIRAFOLD_MCP].command, RENDER_MCP_COMMAND);
  assert.equal(bAfterTurn.security.auth.selectedType, "gemini-api-key");
  assert.throws(() => readFileSync(`${file2}.mirafold-backup`), "valid JSON never gets a backup");
  b.close();
});

test("a settings write failure ends only that turn and the next prompt retries", async () => {
  fixture("settings-write-retry.jsonl", [
    { type: "result", stats: { input_tokens: 1, output_tokens: 1 } },
  ]);
  const { s, msgs, awaitTurnEnd } = makeSession();
  const internals = s as unknown as { writeMcpSettings: () => void };
  const realWrite = internals.writeMcpSettings.bind(s);
  let attempts = 0;
  internals.writeMcpSettings = () => {
    attempts += 1;
    if (attempts === 1) throw new Error("read-only settings file");
    realWrite();
  };

  s.pushPrompt("first");
  await awaitTurnEnd(1);
  assert.equal(attempts, 1);
  assert.match(msgs.find((m) => m.type === "error")!.message, /read-only settings file/);

  s.pushPrompt("second");
  await awaitTurnEnd(2);
  assert.equal(attempts, 2, "a failed merge is not marked complete — the next turn retries it");
  assert.equal(msgs.filter((m) => m.type === "error").length, 1);
  assert.equal(msgs.filter((m) => m.type === "usage").length, 1, "the healed turn reaches Gemini");
  s.close();
});

test("a pre-existing settings.json is never touched at all when trust is denied", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "genui-gemini-untrusted-"));
  const dir = path.join(ws, ".gemini");
  const file = path.join(dir, "settings.json");
  const garbage = '{ "theirs": true, // not JSON\n';
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, garbage);
  const s = new GeminiCliSession({ workspaceDir: ws });
  assert.equal(readFileSync(file, "utf8"), garbage, "construction never opens a pre-existing file");
  const { awaitTurnEnd, msgs } = attach(s);
  s.pushPrompt("hello");
  const ask = await new Promise<Any>((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      const hit = msgs.find((m) => m.type === "permission_request");
      if (hit) {
        clearInterval(poll);
        resolve(hit);
      } else if (Date.now() - t0 > 10_000) {
        clearInterval(poll);
        reject(new Error("no permission_request"));
      }
    }, 10);
  });
  s.resolvePermission(ask.id, false);
  await awaitTurnEnd();
  assert.equal(readFileSync(file, "utf8"), garbage, "still untouched — denial never earns consent to rewrite");
  assert.throws(() => readFileSync(`${file}.mirafold-backup`), "no backup ever written on a denied trust");
  s.close();
  rmSync(ws, { recursive: true, force: true });
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
    { type: "tool_use", tool_name: "mcp_mirafold_render_card", tool_id: "r1", parameters: { title: "T", body: "b", id: "keep-me" } },
    { type: "tool_result", tool_id: "r1", status: "success", output: "Rendered card (id: ignored-1234)" },
    // genui artifact without an id — takes the stub-assigned one from output.
    { type: "tool_use", tool_name: "mcp_mirafold_emit_artifact", tool_id: "r2", parameters: { html: "<b>x</b>", title: "demo" } },
    { type: "tool_result", tool_id: "r2", status: "success", output: "Rendered artifact (id: abcd1234-5678)" },
    // Failed genui call → an honest error row (successful calls paint only).
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
  assert.deepEqual(uses.map((u) => [u.name, u.id, u.detail]), [
    ["run_shell_command", "t1", "ls"],
    ["mcp_mirafold_render_table", "r3", '{"columns":["a"]}'],
  ]);
  const results = msgs.filter((m) => m.type === "tool_result");
  assert.deepEqual(results.map((r) => [r.id, r.isError]), [
    ["t1", false],
    ["r3", true],
  ]);

  const render = msgs.find((m) => m.type === "render")!;
  assert.equal(render.component, "card");
  assert.equal(render.id, "keep-me"); // explicit param id wins
  assert.deepEqual(render.props, { title: "T", body: "b" });

  const art = msgs.find((m) => m.type === "artifact")!;
  assert.equal(art.html, "<b>x</b>");
  assert.equal(art.id, "abcd1234-5678"); // parsed from the stub's output text

  assert.equal(msgs.filter((m) => m.type === "render" || m.type === "artifact").length, 2);
  assert.equal(msgs.find((m) => m.type === "error")!.message, "minor complaint");
  assert.equal(msgs.find((m) => m.type === "error")!.terminal, false);

  const usage = msgs.find((m) => m.type === "usage")!;
  assert.equal(usage.model, "gemini-2.5-pro"); // init set the label
  assert.equal(usage.inputTokens, 123);
  assert.equal(usage.outputTokens, 45);

  assert.equal(turnEnds(), 1);
  assert.equal(msgs[msgs.length - 1].type, "turn_end");
  s.close();
});

test("Gemini 0.57 warnings stay nonfatal and attributed while the turn continues", async () => {
  fixture("warning.jsonl", [
    { type: "init", model: "gemini-2.5-pro" },
    { type: "error", severity: "warning", message: "Loop detected, stopping execution" },
    { type: "message", role: "assistant", content: "the reply still arrived" },
    { type: "result", status: "success", stats: { input_tokens: 2, output_tokens: 3 } },
  ]);
  const { s, msgs, awaitTurnEnd } = makeSession();
  s.pushPrompt("go");
  await awaitTurnEnd();
  assert.equal(msgs.some((m) => m.type === "error"), false);
  const notice = msgs.find((m) => m.type === "notice");
  assert.deepEqual(
    notice && { text: notice.text, kind: notice.kind, source: notice.source },
    {
      text: "Loop detected, stopping execution",
      kind: "warning",
      source: "gemini-cli",
    },
  );
  assert.equal(msgs.filter((m) => m.type === "text_delta").map((m) => m.text).join(""), "the reply still arrived");
  s.close();
});

test("Gemini 0.57 fatal result errors surface even after stdout init", async () => {
  fixture("fatal-result.jsonl", [
    { type: "init", model: "gemini-2.5-pro" },
    {
      type: "result",
      status: "error",
      error: { type: "FatalAuthenticationError", message: "Authentication required." },
      stats: { input_tokens: 0, output_tokens: 0 },
    },
  ]);
  const { s, msgs, awaitTurnEnd } = makeSession();
  s.pushPrompt("go");
  await awaitTurnEnd();
  const errors = msgs.filter((m) => m.type === "error");
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "Authentication required.");
  assert.equal(errors[0].terminal, undefined);
  assert.equal(msgs.filter((m) => m.type === "usage").length, 1);
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
  // 2026-08-11 test-audit: the join is insertion-ordered and exact, so pin it —
  // two loose `.match` calls survived a wrong separator or reversed order.
  assert.equal(model, "gemini-2.5-flash, gemini-2.5-pro");
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
    assert.ok(prompt.includes(MIRAFOLD_CONTEXT), "the environment fact rides the first prose turn");
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

test("2026-07-29 a first turn that dies unread gives the guidance back — the healed turn carries it", async () => {
  // guidanceInjected used to be consumed before spawn, so the documented
  // brick sequence (exit 42/41 before any stdout event) left every later
  // turn bare — the model never saw the render tools for the session's life.
  const argsLog = path.join(tmp, "args-guidance.log");
  delete process.env.FAKE_EVENTS;
  process.env.FAKE_STDERR = "auth is broken";
  process.env.FAKE_EXIT = "41";
  const { s, awaitTurnEnd } = makeSession();
  try {
    s.pushPrompt("one");
    await awaitTurnEnd(1);

    delete process.env.FAKE_STDERR;
    delete process.env.FAKE_EXIT;
    process.env.FAKE_ARGS_LOG = argsLog;
    fixture("guidance-retry.jsonl", [{ type: "result", stats: { input_tokens: 1, output_tokens: 1 } }]);
    s.pushPrompt("two");
    await awaitTurnEnd(2);
    const args = spawnArgs(argsLog);
    const prompt = args[args.indexOf("-p") + 1];
    assert.ok(prompt.includes("## Generative UI"), `turn 2 re-carries guidance; -p was: ${prompt.slice(0, 80)}`);
    assert.ok(prompt.endsWith("two"));
  } finally {
    delete process.env.FAKE_ARGS_LOG;
    delete process.env.FAKE_STDERR;
    delete process.env.FAKE_EXIT;
  }
  s.close();
});

// --- P.6b: the folder-trust gate ------------------------------------------
// Gemini CLI 0.53.0 refuses to run headless in a folder it hasn't been told to
// trust. Mirafold asks once through the SHELL's permission strip (the agent
// cannot paint or fake it) and remembers the yes, rather than blanket-passing
// --skip-trust — which would silently undo the protection for any repo the
// user opens. These tests use a workspace OUTSIDE the pre-trusted root above.

const untrustedSession = () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "genui-gemini-untrusted-"));
  const s = new GeminiCliSession({ workspaceDir: ws });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  const waitFor = (type: string, timeoutMs = 10_000) =>
    new Promise<Any>((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        const hit = msgs.find((m) => m.type === type);
        if (hit) {
          clearInterval(poll);
          resolve(hit);
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(poll);
          reject(new Error(`no ${type}; seen: ${msgs.map((m) => m.type).join(",")}`));
        }
      }, 10);
    });
  return { s, ws, msgs, waitFor };
};

test("an untrusted workspace asks the user before anything runs, then proceeds on allow", async () => {
  const argsLog = path.join(tmp, "trust-allow-args");
  process.env.FAKE_ARGS_LOG = argsLog;
  const { s, ws, msgs, waitFor } = untrustedSession();
  try {
    s.pushPrompt("hello");
    const ask = await waitFor("permission_request");
    assert.equal(ask.tool, "Gemini");
    assert.match(ask.detail, /trust this folder/);
    assert.ok(ask.detail.includes(ws), "the ask names the exact folder");
    // Nothing ran while the ask was open — the whole point of the gate.
    assert.equal(existsSync(argsLog), false, "no child spawned before the answer");
    assert.equal(msgs.some((m) => m.type === "turn_end"), false, "turn still open");
    const settingsFile = path.join(ws, ".gemini", "settings.json");
    assert.equal(
      existsSync(settingsFile),
      false,
      "no project settings file is created before the trust answer",
    );

    s.resolvePermission(ask.id, true);
    await waitFor("turn_end");
    assert.ok(
      msgs.some((m) => m.type === "permission_resolved" && m.id === ask.id && m.allow === true),
      "the resolution is announced so every viewport drops its bar",
    );
    const afterAllow = JSON.parse(readFileSync(settingsFile, "utf8"));
    assert.equal(afterAllow.security.auth.selectedType, "gemini-api-key");
    assert.equal(
      afterAllow.mcpServers[MIRAFOLD_MCP].command,
      RENDER_MCP_COMMAND,
      "the MCP entry lands only once the yes is in",
    );
    const argv = readFileSync(argsLog, "utf8");
    // The env var, NOT `--skip-trust`: measured against 0.53.0, the flag lets
    // the run proceed but still won't load the project settings that select
    // API-key auth, so the turn dies on IneligibleTierError instead.
    assert.match(argv, /ENV_TRUST=true/, "the yes is carried into the child as workspace trust");
    assert.equal(
      isWorkspaceTrusted(ws, "gemini-cli"),
      true,
      "asked once — Gemini's answer is remembered",
    );
    assert.equal(
      isWorkspaceTrusted(ws, "codex"),
      false,
      "Gemini's answer does not authorize Codex's different config write",
    );
  } finally {
    s.close();
    delete process.env.FAKE_ARGS_LOG;
    rmSync(ws, { recursive: true, force: true });
  }
});

test("denying runs nothing, says why, and does not remember a yes", async () => {
  const argsLog = path.join(tmp, "trust-deny-args");
  process.env.FAKE_ARGS_LOG = argsLog;
  const { s, ws, msgs, waitFor } = untrustedSession();
  try {
    s.pushPrompt("hello");
    const ask = await waitFor("permission_request");
    s.resolvePermission(ask.id, false);
    await waitFor("turn_end");
    assert.equal(existsSync(argsLog), false, "no child ever spawned");
    const notice = msgs.find((m) => m.type === "notice");
    assert.ok(notice, "the user is told why nothing happened");
    assert.match(notice.text, /won't run in a folder you haven't trusted/);
    assert.equal(isWorkspaceTrusted(ws, "gemini-cli"), false, "a no is not recorded as a yes");
    const settingsFile = path.join(ws, ".gemini", "settings.json");
    assert.equal(existsSync(settingsFile), false, "a denied trust creates no project settings");
  } finally {
    s.close();
    delete process.env.FAKE_ARGS_LOG;
    rmSync(ws, { recursive: true, force: true });
  }
});

// AUDIT 2026-08-26: the consented write is to THIS folder's settings file,
// but the path was a plain join — a checkout shipping `.gemini` or
// `.gemini/settings.json` as a symlink (dangling ones pass existsSync)
// redirected the merge to any user-owned path. Now: refused, nothing written.
for (const variant of ["dir", "file"] as const) {
  test(`a repository's .gemini ${variant} symlink never redirects the consented settings write`, async () => {
    const { symlinkSync, mkdirSync } = await import("node:fs");
    const outside = mkdtempSync(path.join(os.tmpdir(), "genui-gemini-outside-"));
    const { s, ws, msgs, waitFor } = untrustedSession();
    if (variant === "dir") {
      symlinkSync(outside, path.join(ws, ".gemini"));
    } else {
      mkdirSync(path.join(ws, ".gemini"));
      symlinkSync(path.join(outside, "settings.json"), path.join(ws, ".gemini", "settings.json"));
    }
    try {
      s.pushPrompt("hello");
      const ask = await waitFor("permission_request");
      s.resolvePermission(ask.id, true);
      await waitFor("turn_end");
      const err = msgs.find((m) => m.type === "error");
      assert.ok(err, "the turn fails with a message");
      assert.match(err.message, /symlink/);
      assert.equal(existsSync(path.join(outside, "settings.json")), false, "nothing was written through the link");
      assert.deepEqual(
        (await import("node:fs")).readdirSync(outside),
        [],
        "nothing at all landed outside the folder",
      );
    } finally {
      s.close();
      rmSync(ws, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
}

test("/model in an untrusted folder asks for trust first; a deny spawns nothing and ends the turn", async () => {
  const argsLog = path.join(tmp, "trust-model-args");
  rmSync(argsLog, { force: true });
  process.env.FAKE_ARGS_LOG = argsLog;
  const { s, ws, msgs, waitFor } = untrustedSession();
  try {
    s.pushPrompt("/model");
    const ask = await waitFor("permission_request");
    assert.match(ask.detail, /trust this folder/);
    assert.equal(existsSync(argsLog), false, "the catalog spawn waits for the answer");
    s.resolvePermission(ask.id, false);
    await waitFor("turn_end");
    assert.equal(existsSync(argsLog), false, "a deny never spawns Gemini in the folder");
    assert.ok(!msgs.some((m) => m.type === "picker"), "no picker was painted");
    assert.ok(msgs.some((m) => m.type === "notice" && /haven't trusted/.test(m.text)));
    assert.equal(isWorkspaceTrusted(ws, "gemini-cli"), false);
  } finally {
    delete process.env.FAKE_ARGS_LOG;
    s.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

// Cold review of the audit fix above (2026-08-26): the path guard covered
// `.gemini` and `settings.json` but not the THIRD write — the invalid-JSON
// backup — which wrote the repo's own bytes through a symlink planted under
// the backup's name. Now every write opens O_NOFOLLOW, the backup exclusively.
test("a repository cannot route the invalid-JSON backup through a planted symlink; the backup lands beside the file", async () => {
  const { symlinkSync, mkdirSync, readdirSync } = await import("node:fs");
  const outside = mkdtempSync(path.join(os.tmpdir(), "genui-gemini-outside-"));
  const victim = path.join(outside, "authorized_keys");
  writeFileSync(victim, "the user's own bytes\n");
  const { s, ws, msgs, waitFor } = untrustedSession();
  const dir = path.join(ws, ".gemini");
  mkdirSync(dir);
  const planted = "ssh-ed25519 AAAA-attacker attacker@evil\n";
  writeFileSync(path.join(dir, "settings.json"), planted); // a real file, not JSON
  symlinkSync(victim, path.join(dir, "settings.json.mirafold-backup"));
  try {
    s.pushPrompt("hello");
    const ask = await waitFor("permission_request");
    s.resolvePermission(ask.id, true);
    await waitFor("turn_end");
    assert.equal(readFileSync(victim, "utf8"), "the user's own bytes\n", "the victim never received the repo's bytes");
    assert.ok(!msgs.some((m) => m.type === "error"), "the turn proceeds — the backup found another name");
    const backups = readdirSync(dir).filter((n) => /^settings\.json\.mirafold-backup\.\d+$/.test(n));
    assert.equal(backups.length, 1, "one timestamped backup beside the file");
    assert.equal(readFileSync(path.join(dir, backups[0]!), "utf8"), planted);
    assert.equal(JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")).security.auth.selectedType, "gemini-api-key");
  } finally {
    s.close();
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("TS.7: an event kind the adapter cannot map is reported once, never dropped silently", async () => {
  fixture("unknown-kind.jsonl", [
    { type: "quantum_flux", detail: "a kind this build has never heard of" },
    { type: "quantum_flux", detail: "again" }, // once per kind
    { type: 5 }, // malformed non-string kind: skipped, never reported or thrown
    { type: "message", role: "assistant", content: "done" },
  ]);
  const { s, msgs, awaitTurnEnd } = makeSession();
  s.pushPrompt("go");
  await awaitTurnEnd();
  assert.deepEqual(
    msgs.filter((m) => m.type === "notice").map((m) => [m.text, m.source]),
    [["Mirafold doesn't display this Gemini CLI event yet: quantum_flux", undefined]],
  );
  s.close();
  delete process.env.FAKE_EVENTS;
});
