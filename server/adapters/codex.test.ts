import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { WireMsg } from "../protocol";
import { CodexSession } from "./codex";
import { MIRAFOLD_MCP } from "./render-mcp-cmd";

// L.2b2: the Codex event→WireMsg mapping and the turn grammar, on synthetic
// ThreadEvents — no engine, no network. The session is real; only its private
// `thread` is swapped for a stub whose runStreamed replays scripted turns, so
// the whole worker → runTurn → handleEvent → onItem path runs as shipped.

type Any = WireMsg & Record<string, any>;
type Turn = ThreadEvent[] | ((signal: AbortSignal) => AsyncGenerator<ThreadEvent>);

const tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-codex-test-"));
const ev = (e: Record<string, unknown>) => e as unknown as ThreadEvent;

/** A CodexSession on a stubbed thread; each pushPrompt consumes the next turn. */
function makeSession(...turns: Turn[]) {
  const s = new CodexSession({ workspaceDir: tmp });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  (s as unknown as { thread: unknown }).thread = {
    runStreamed: async (_text: string, opts: { signal: AbortSignal }) => {
      const turn = turns.shift() ?? [];
      return {
        events:
          typeof turn === "function"
            ? turn(opts.signal)
            : (async function* () {
                for (const e of turn) yield e;
              })(),
      };
    },
  };
  const turnEnds = () => msgs.filter((m) => m.type === "turn_end").length;
  const awaitTurnEnd = (count = 1, timeoutMs = 5_000) =>
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
      }, 5);
    });
  return { s, msgs, turnEnds, awaitTurnEnd };
}

const HAPPY: ThreadEvent[] = [
  ev({ type: "turn.started" }),
  ev({ type: "item.completed", item: { type: "reasoning", id: "th1", text: "pondering" } }),
  ev({ type: "item.completed", item: { type: "agent_message", id: "m1", text: "the reply" } }),
  ev({
    type: "item.started",
    item: { type: "command_execution", id: "c1", command: "ls -la", status: "in_progress" },
  }),
  ev({
    type: "item.completed",
    item: {
      type: "command_execution",
      id: "c1",
      command: "ls -la",
      aggregated_output: "file.txt",
      exit_code: 0,
      status: "completed",
    },
  }),
  ev({
    type: "item.completed",
    item: {
      type: "file_change",
      id: "f1",
      status: "completed",
      changes: [{ kind: "update", path: "src/a.ts" }],
    },
  }),
  ev({
    type: "item.started",
    item: { type: "mcp_tool_call", id: "mc1", server: "docs", tool: "search", arguments: { q: "x" } },
  }),
  ev({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      id: "mc1",
      server: "docs",
      tool: "search",
      arguments: { q: "x" },
      status: "completed",
      result: { content: [{ type: "text", text: "3 hits" }] },
    },
  }),
  ev({ type: "item.completed", item: { type: "web_search", id: "w1", query: "codex sdk" } }),
  ev({
    type: "turn.completed",
    usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10, reasoning_output_tokens: 5 },
  }),
];

test("happy stream: full event→WireMsg mapping, exactly one turn_end", async () => {
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession(HAPPY);
  s.pushPrompt("go");
  await awaitTurnEnd();

  assert.ok(msgs.every((m) => m.seq === undefined)); // seq is the registry's, never the adapter's
  assert.ok(msgs.some((m) => m.type === "thinking_delta" && m.text === "pondering"));
  assert.ok(msgs.some((m) => m.type === "text_delta" && m.text === "the reply"));

  // Each tool announced exactly once (started+completed never double-paints),
  // every tool_use paired to a result by id.
  const uses = msgs.filter((m) => m.type === "tool_use");
  assert.deepEqual(
    uses.map((u) => [u.name, u.id]),
    [
      ["Shell", "c1"],
      ["apply_patch", "f1"],
      ["docs.search", "mc1"],
      ["web_search", "w1"],
    ],
  );
  for (const u of uses) {
    assert.equal(msgs.filter((m) => m.type === "tool_result" && m.id === u.id).length, 1);
  }
  const shell = msgs.find((m) => m.type === "tool_result" && m.id === "c1")!;
  assert.equal(shell.output, "file.txt");
  assert.ok(!shell.isError);
  assert.equal(msgs.find((m) => m.type === "tool_result" && m.id === "mc1")!.output, "3 hits");

  // cached_input_tokens is a subset of input_tokens — never re-added;
  // reasoning tokens are output-side.
  const usage = msgs.find((m) => m.type === "usage")!;
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 15);

  assert.equal(turnEnds(), 1);
  assert.equal(msgs[msgs.length - 1].type, "turn_end");
  s.close();
});

test("failed command: isError; completion without a start still announces", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession([
    ev({
      type: "item.completed",
      item: {
        type: "command_execution",
        id: "c9",
        command: "false",
        aggregated_output: "",
        exit_code: 2,
        status: "failed",
      },
    }),
    ev({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  assert.equal(msgs.filter((m) => m.type === "tool_use" && m.id === "c9").length, 1);
  assert.equal(msgs.find((m) => m.type === "tool_result" && m.id === "c9")!.isError, true);
  s.close();
});

test("mcp MCP calls paint render/artifact, never tool rows; failures and unknowns are suppressed", async () => {
  const mcp = (tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ev({
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        id: `g-${tool}`,
        server: MIRAFOLD_MCP,
        tool,
        arguments: args,
        status: "completed",
        result: { structured_content: { renderId: "rid-1" } },
        ...extra,
      },
    });
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession([
    ev({ type: "turn.started" }),
    mcp("render_card", { title: "T", id: "keep-me" }),
    mcp("emit_artifact", { html: "<b>x</b>", title: "demo" }),
    mcp("render_table", { columns: ["a"] }, { status: "failed" }),
    mcp("render_bogus", {}),
    ev({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();

  // Suppression: our own UI tools never appear as tool_use/tool_result rows.
  assert.equal(msgs.filter((m) => m.type === "tool_use" || m.type === "tool_result").length, 0);

  const render = msgs.find((m) => m.type === "render")!;
  assert.equal(render.component, "card");
  assert.deepEqual(render.props, { title: "T" }); // id stripped from props
  assert.equal(render.id, "rid-1"); // structured_content wins

  const art = msgs.find((m) => m.type === "artifact")!;
  assert.equal(art.html, "<b>x</b>");
  assert.equal(art.title, "demo");

  // failed render_table + unknown render_bogus → exactly the two paints above.
  assert.equal(msgs.filter((m) => m.type === "render" || m.type === "artifact").length, 2);
  assert.equal(turnEnds(), 1);
  s.close();
});

test("checklist: one render id within a turn, a fresh one next turn", async () => {
  const todo = (done: boolean) =>
    ev({
      type: "item.updated",
      item: { type: "todo_list", id: "t", items: [{ text: "step", completed: done }] },
    });
  const usage = ev({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
  const { s, msgs, awaitTurnEnd } = makeSession(
    [todo(false), todo(true), usage],
    [todo(false), usage],
  );
  s.pushPrompt("one");
  await awaitTurnEnd(1);
  s.pushPrompt("two");
  await awaitTurnEnd(2);
  const renders = msgs.filter((m) => m.type === "render" && m.component === "todo-list");
  assert.equal(renders.length, 3);
  assert.equal(renders[0].id, renders[1].id); // update-in-place within the turn
  assert.notEqual(renders[1].id, renders[2].id); // re-anchors next turn
  s.close();
});

test("turn.failed: error before the single turn_end", async () => {
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession([
    ev({ type: "turn.started" }),
    ev({ type: "turn.failed", error: { message: "boom" } }),
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const types = msgs.map((m) => m.type);
  assert.ok(types.indexOf("error") < types.indexOf("turn_end"));
  assert.equal(msgs.find((m) => m.type === "error")!.message, "boom");
  assert.equal(turnEnds(), 1); // end() from turn.failed + finally must not double-fire
  s.close();
});

test("a stream that throws mid-turn: error, then exactly one turn_end", async () => {
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession(() =>
    (async function* (): AsyncGenerator<ThreadEvent> {
      yield ev({ type: "turn.started" });
      throw new Error("stream died");
    })(),
  );
  s.pushPrompt("go");
  await awaitTurnEnd();
  assert.equal(msgs.find((m) => m.type === "error")!.message, "stream died");
  assert.equal(turnEnds(), 1);
  s.close();
});

test("interrupt: aborts silently — one turn_end, no error", async () => {
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession((signal) =>
    (async function* (): AsyncGenerator<ThreadEvent> {
      yield ev({ type: "turn.started" });
      await new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        ),
      );
    })(),
  );
  s.pushPrompt("go");
  await new Promise((r) => setTimeout(r, 50)); // let the turn start
  s.interrupt();
  await awaitTurnEnd();
  assert.equal(turnEnds(), 1);
  assert.ok(!msgs.some((m) => m.type === "error"));
  s.close();
});
