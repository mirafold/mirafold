import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import type { WireMsg } from "../protocol";
import { GeminiCliSession } from "./gemini-cli";

// L.2b2: the Gemini JSONL→WireMsg mapping and the turn grammar. The real
// adapter spawns a real child — a scripted stub substituted via
// GENUI_GEMINI_BIN that replays a JSONL fixture ($FAKE_EVENTS), optionally
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
    '#!/usr/bin/env bash\n[ -n "$FAKE_EVENTS" ] && cat "$FAKE_EVENTS"\n[ -n "$FAKE_HANG" ] && exec sleep 30\nexit "${FAKE_EXIT:-0}"\n',
  );
  chmodSync(stub, 0o755);
  process.env.GENUI_GEMINI_BIN = stub;
});
after(() => {
  delete process.env.GENUI_GEMINI_BIN;
  delete process.env.FAKE_EVENTS;
  delete process.env.FAKE_HANG;
  delete process.env.FAKE_EXIT;
  rmSync(tmp, { recursive: true, force: true });
});

function makeSession() {
  const s = new GeminiCliSession({ workspaceDir: mkdtempSync(path.join(tmp, "ws-")) });
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
    { type: "tool_use", tool_name: "mcp_genui_render_card", tool_id: "r1", parameters: { title: "T", id: "keep-me" } },
    { type: "tool_result", tool_id: "r1", status: "success", output: "Rendered card (id: ignored-1234)" },
    // genui artifact without an id — takes the stub-assigned one from output.
    { type: "tool_use", tool_name: "mcp_genui_emit_artifact", tool_id: "r2", parameters: { html: "<b>x</b>", title: "demo" } },
    { type: "tool_result", tool_id: "r2", status: "success", output: "Rendered artifact (id: abcd1234-5678)" },
    // failed genui call → suppressed entirely.
    { type: "tool_use", tool_name: "mcp_genui_render_table", tool_id: "r3", parameters: { columns: ["a"] } },
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
  process.env.GENUI_GEMINI_BIN = path.join(tmp, "does-not-exist");
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession();
  s.pushPrompt("go");
  await awaitTurnEnd();
  process.env.GENUI_GEMINI_BIN = stub;
  const types = msgs.map((m) => m.type);
  assert.match(msgs.find((m) => m.type === "error")!.message, /gemini spawn failed/);
  assert.ok(types.indexOf("error") < types.indexOf("turn_end"));
  assert.equal(turnEnds(), 1);
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
