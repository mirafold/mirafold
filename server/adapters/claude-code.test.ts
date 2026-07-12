import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import type { query, Options } from "@anthropic-ai/claude-agent-sdk";
import type { WireMsg } from "../protocol";
import { ClaudeCodeSession } from "./claude-code";

// L.2e: the Claude Code SDK-message→WireMsg mapping and the turn grammar, on
// synthetic SDKMessages — no CLI, no network. The session is real; only the
// engine is swapped via the constructor's `engine` seam for a stub that
// consumes the real promptStream and replays scripted turns, so the whole
// pushPrompt → queue → pump → emit path runs as shipped. `canUseTool` is
// captured off the real options, so the permission plumbing is the shipped
// makeCanUseTool → ask → resolvePermission chain too.

type Any = WireMsg & Record<string, any>;
type SDKMsg = Record<string, unknown>;
type Turn = SDKMsg[] | (() => AsyncGenerator<SDKMsg>);

const tmp = mkdtempSync(path.join(os.tmpdir(), "genui-claude-test-"));

function makeSession(...turns: Turn[]) {
  const captured: { options?: Options; interrupts: number } = { interrupts: 0 };
  const engine = ((args: { prompt: AsyncIterable<unknown>; options: Options }) => {
    captured.options = args.options;
    const gen = (async function* () {
      for await (const _prompt of args.prompt) {
        const turn = turns.shift() ?? [];
        if (typeof turn === "function") yield* turn();
        else for (const m of turn) yield m;
      }
    })();
    return Object.assign(gen, {
      interrupt: async () => {
        captured.interrupts++;
      },
    });
  }) as unknown as typeof query;

  const s = new ClaudeCodeSession({ workspaceDir: tmp, model: "test-model", engine });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
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
  const awaitMsg = (pred: (m: Any) => boolean, label: string, timeoutMs = 5_000) =>
    new Promise<Any>((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        const hit = msgs.find(pred);
        if (hit) {
          clearInterval(poll);
          resolve(hit);
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(poll);
          reject(new Error(`no ${label}; seen: ${msgs.map((m) => m.type).join(",")}`));
        }
      }, 5);
    });
  return { s, msgs, captured, turnEnds, awaitTurnEnd, awaitMsg };
}

const streamDelta = (delta: Record<string, unknown>, parent: string | null = null): SDKMsg => ({
  type: "stream_event",
  parent_tool_use_id: parent,
  event: { type: "content_block_delta", delta },
});
const blockStart = (content_block: Record<string, unknown>): SDKMsg => ({
  type: "stream_event",
  parent_tool_use_id: null,
  event: { type: "content_block_start", content_block },
});
const assistant = (content: unknown[], parent: string | null = null): SDKMsg => ({
  type: "assistant",
  parent_tool_use_id: parent,
  message: { role: "assistant", content },
});
const user = (content: unknown[], parent: string | null = null): SDKMsg => ({
  type: "user",
  parent_tool_use_id: parent,
  message: { role: "user", content },
});
const RESULT: SDKMsg = {
  type: "result",
  is_error: false,
  usage: {
    input_tokens: 10,
    cache_read_input_tokens: 80,
    cache_creation_input_tokens: 10,
    output_tokens: 25,
  },
  total_cost_usd: 0.0123,
};

test("happy stream: full SDKMessage→WireMsg mapping, exactly one turn_end", async () => {
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession([
    blockStart({ type: "thinking" }),
    streamDelta({ type: "thinking_delta", thinking: "pondering" }),
    streamDelta({ type: "text_delta", text: "the reply" }),
    blockStart({ type: "tool_use", name: "Bash" }),
    assistant([
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: "big.txt" } },
      // Render tools paint their own component block — never a tool row.
      { type: "tool_use", id: "u1", name: "mcp__ui__render_card", input: { title: "T" } },
      { type: "text", text: "assistant text arrives via stream_event, not here" },
    ]),
    user([
      { type: "tool_result", tool_use_id: "t1", content: "file.txt", is_error: false },
      { type: "tool_result", tool_use_id: "t2", content: "x".repeat(70_000) },
      { type: "tool_result", tool_use_id: "u1", content: "Rendered card (id: x)" },
      { type: "tool_result", tool_use_id: "orphan", content: "never announced" },
    ]),
    RESULT,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();

  assert.ok(msgs.every((m) => m.seq === undefined)); // seq is the registry's, never the adapter's
  assert.ok(msgs.some((m) => m.type === "status" && m.state === "thinking"));
  assert.ok(msgs.some((m) => m.type === "thinking_delta" && m.text === "pondering"));
  assert.ok(msgs.some((m) => m.type === "text_delta" && m.text === "the reply"));
  assert.ok(msgs.some((m) => m.type === "status" && m.state === "tool" && m.label === "Bash"));

  // mcp__ui__* skipped; everything announced carries detail + input.
  const uses = msgs.filter((m) => m.type === "tool_use");
  assert.deepEqual(
    uses.map((u) => [u.name, u.id, u.detail]),
    [
      ["Bash", "t1", "ls"],
      ["Read", "t2", "big.txt"],
    ],
  );
  assert.deepEqual(uses[0].input, { command: "ls" });

  // Only announced ids get result rows: u1 and the orphan are dropped.
  const results = msgs.filter((m) => m.type === "tool_result");
  assert.deepEqual(results.map((r) => r.id), ["t1", "t2"]);
  assert.equal(results[0].output, "file.txt");
  assert.equal(results[0].isError, false);
  assert.ok((results[1].truncatedBytes ?? 0) > 0); // capOutput at the emit seam
  assert.ok(results[1].output.length < 70_000);

  // Cache tokens are real context weight — folded into inputTokens.
  const usage = msgs.find((m) => m.type === "usage")!;
  assert.equal(usage.model, "test-model");
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 25);
  assert.equal(usage.costUsd, 0.0123);

  assert.equal(turnEnds(), 1);
  assert.equal(msgs[msgs.length - 1].type, "turn_end");
  s.close();
});

test("subagent traffic: tool calls nest under the Task id; text and task tools stay internal", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession([
    assistant([{ type: "tool_use", id: "task1", name: "Agent", input: { prompt: "delegate" } }]),
    streamDelta({ type: "text_delta", text: "subagent prose must not paint" }, "task1"),
    assistant(
      [
        { type: "tool_use", id: "in1", name: "Read", input: { file_path: "a.ts" } },
        // A subagent's own checklist is internal — no render, no row.
        { type: "tool_use", id: "st1", name: "TodoWrite", input: { todos: [{ content: "sub", status: "pending" }] } },
      ],
      "task1",
    ),
    user([{ type: "tool_result", tool_use_id: "in1", content: "inner out" }], "task1"),
    user([{ type: "tool_result", tool_use_id: "task1", content: "done" }]),
    RESULT,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();

  const task = msgs.find((m) => m.type === "tool_use" && m.id === "task1")!;
  assert.equal(task.parentId, undefined);
  const inner = msgs.find((m) => m.type === "tool_use" && m.id === "in1")!;
  assert.equal(inner.parentId, "task1");
  assert.equal(msgs.find((m) => m.type === "tool_result" && m.id === "in1")!.parentId, "task1");
  assert.ok(msgs.some((m) => m.type === "tool_result" && m.id === "task1"));

  assert.ok(!msgs.some((m) => m.type === "text_delta")); // subagent prose filtered
  assert.ok(!msgs.some((m) => m.type === "render")); // subagent TodoWrite swallowed
  assert.ok(!msgs.some((m) => m.type === "tool_use" && m.id === "st1"));
  s.close();
});

test("checklist: task tools fold into one render id per turn, list persists, id re-anchors next turn", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession(
    [
      assistant([
        {
          type: "tool_use",
          id: "w1",
          name: "TodoWrite",
          input: { todos: [{ content: "step one", status: "pending" }, { content: "step two", status: "pending" }] },
        },
      ]),
      assistant([{ type: "tool_use", id: "c1", name: "TaskCreate", input: { subject: "step three" } }]),
      assistant([{ type: "tool_use", id: "u1", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }]),
      // Results for task tools were never announced — they must not row.
      user([{ type: "tool_result", tool_use_id: "w1", content: "ok" }]),
      RESULT,
    ],
    [
      assistant([{ type: "tool_use", id: "u2", name: "TaskUpdate", input: { taskId: "3", status: "deleted" } }]),
      RESULT,
    ],
  );
  s.pushPrompt("one");
  await awaitTurnEnd(1);
  s.pushPrompt("two");
  await awaitTurnEnd(2);

  assert.ok(!msgs.some((m) => m.type === "tool_use" || m.type === "tool_result")); // all folded
  const renders = msgs.filter((m) => m.type === "render" && m.component === "todo-list");
  assert.equal(renders.length, 4); // TodoWrite, TaskCreate, TaskUpdate, then turn 2's TaskUpdate

  const todos = (r: Any) => r.props.todos.map((t: Any) => `${t.content}:${t.status}`);
  assert.deepEqual(todos(renders[0]), ["step one:pending", "step two:pending"]);
  assert.deepEqual(todos(renders[1]), ["step one:pending", "step two:pending", "step three:pending"]);
  assert.deepEqual(todos(renders[2]), ["step one:completed", "step two:pending", "step three:pending"]);
  // Turn 2: the list persisted (minus the deleted item) but paints a fresh block.
  assert.deepEqual(todos(renders[3]), ["step one:completed", "step two:pending"]);
  assert.equal(new Set(renders.slice(0, 3).map((r) => r.id)).size, 1); // update-in-place
  assert.notEqual(renders[3].id, renders[0].id); // re-anchors next turn
  s.close();
});

test("F.3 honest model label: system/init's resolved model reaches usage.model", async () => {
  // The configured value is "test-model", but the engine reports the real
  // model it resolved via system/init — that's what the status bar must show.
  const { s, msgs, awaitTurnEnd } = makeSession([
    { type: "system", subtype: "init", model: "claude-fable-5" },
    streamDelta({ type: "text_delta", text: "hi" }),
    assistant([{ type: "text", text: "hi" }]),
    RESULT,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  assert.equal(msgs.find((m) => m.type === "usage")!.model, "claude-fable-5");
  s.close();
});

test("F.1 slash-command output: buffered assistant text with no deltas renders once", async () => {
  // /context, /usage, and unsupported commands arrive as a buffered assistant
  // text message with ZERO stream_event deltas — the adapter must paint it, or
  // the command runs and nothing shows.
  const { s, msgs, awaitTurnEnd } = makeSession([
    assistant([{ type: "text", text: "Context: 42k/200k tokens used." }]),
    RESULT,
  ]);
  s.pushPrompt("/context");
  await awaitTurnEnd();
  const texts = msgs.filter((m) => m.type === "text_delta");
  assert.equal(texts.length, 1);
  assert.equal(texts[0].text, "Context: 42k/200k tokens used.");
  s.close();
});

test("F.1 no double-render: a streamed turn ignores its buffered assistant text", async () => {
  // The normal path streams text via stream_event AND the SDK re-sends it in
  // the buffered assistant message — the buffered copy must not paint again.
  const { s, msgs, awaitTurnEnd } = makeSession([
    streamDelta({ type: "text_delta", text: "streamed reply" }),
    assistant([{ type: "text", text: "streamed reply" }]),
    RESULT,
  ]);
  s.pushPrompt("hi");
  await awaitTurnEnd();
  const texts = msgs.filter((m) => m.type === "text_delta");
  assert.equal(texts.length, 1); // only the streamed one, not the buffered copy
  assert.equal(texts[0].text, "streamed reply");
  s.close();
});

test("F.1 the streamed/buffered decision resets per turn", async () => {
  // Turn 1 streams; turn 2 is a buffered-only slash command. Turn 1's flag
  // must not suppress turn 2's output.
  const { s, msgs, awaitTurnEnd } = makeSession(
    [streamDelta({ type: "text_delta", text: "first" }), assistant([{ type: "text", text: "first" }]), RESULT],
    [assistant([{ type: "text", text: "/usage table here" }]), RESULT],
  );
  s.pushPrompt("hi");
  await awaitTurnEnd(1);
  s.pushPrompt("/usage");
  await awaitTurnEnd(2);
  const texts = msgs.filter((m) => m.type === "text_delta").map((m) => m.text);
  assert.deepEqual(texts, ["first", "/usage table here"]);
  s.close();
});

test("F.2 api_retry: a scripted retry surfaces as a notice, not a silent stall", async () => {
  // The terminal shows "retrying (attempt n)…" here; without the notice the UI
  // sits on "thinking…" through the backoff, looking hung. The turn still ends.
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession([
    { type: "system", subtype: "api_retry", attempt: 2, max_retries: 5, retry_delay_ms: 1000 },
    streamDelta({ type: "text_delta", text: "recovered" }),
    RESULT,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const notice = msgs.find((m) => m.type === "notice")!;
  assert.equal(notice.kind, "retry");
  assert.match(notice.text, /retrying \(attempt 2\/5\)/);
  assert.equal(turnEnds(), 1); // the retry is not an error — the turn completes
  assert.ok(!msgs.some((m) => m.type === "error"));
  s.close();
});

test("F.2 compact_boundary: auto and manual compaction each surface as a notice", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession(
    [{ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } }, RESULT],
    [{ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual" } }, RESULT],
  );
  s.pushPrompt("one");
  await awaitTurnEnd(1);
  s.pushPrompt("two");
  await awaitTurnEnd(2);
  const notices = msgs.filter((m) => m.type === "notice");
  assert.deepEqual(notices.map((n) => n.kind), ["compaction", "compaction"]);
  assert.match(notices[0].text, /automatically compacted/);
  assert.match(notices[1].text, /compacted/);
  s.close();
});

test("F.2 model refusal: fallback names the model; no-fallback explains the ended turn", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession(
    [
      { type: "system", subtype: "model_refusal_fallback", fallback_model: "claude-opus-4-8" },
      RESULT,
    ],
    [{ type: "system", subtype: "model_refusal_no_fallback" }, { type: "result", is_error: true, subtype: "refusal" }],
  );
  s.pushPrompt("one");
  await awaitTurnEnd(1);
  s.pushPrompt("two");
  await awaitTurnEnd(2);
  const notices = msgs.filter((m) => m.type === "notice");
  assert.equal(notices.length, 2);
  assert.equal(notices[0].kind, "refusal");
  assert.match(notices[0].text, /retried on claude-opus-4-8/);
  assert.equal(notices[1].kind, "refusal");
  assert.match(notices[1].text, /declined to complete/);
  s.close();
});

test("F.2 rate_limit_event: warning and rejected notify; plain 'allowed' stays silent", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession(
    [
      { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
      streamDelta({ type: "text_delta", text: "fine" }),
      RESULT,
    ],
    [
      { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour" } },
      RESULT,
    ],
    [
      { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "seven_day_opus" } },
      RESULT,
    ],
  );
  s.pushPrompt("one");
  await awaitTurnEnd(1);
  s.pushPrompt("two");
  await awaitTurnEnd(2);
  s.pushPrompt("three");
  await awaitTurnEnd(3);
  const notices = msgs.filter((m) => m.type === "notice");
  assert.equal(notices.length, 2); // the constant plain "allowed" produced none
  assert.equal(notices[0].kind, "rate_limit");
  assert.match(notices[0].text, /approaching the rate limit \(five hour\)/);
  assert.equal(notices[1].kind, "rate_limit");
  assert.match(notices[1].text, /rate limit reached \(seven day opus\)/);
  s.close();
});

test("error result: error before the single turn_end, no usage without a usage block", async () => {
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession([
    { type: "result", is_error: true, subtype: "error_during_execution" },
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const types = msgs.map((m) => m.type);
  assert.ok(types.indexOf("error") < types.indexOf("turn_end"));
  assert.match(msgs.find((m) => m.type === "error")!.message, /error_during_execution/);
  assert.ok(!msgs.some((m) => m.type === "usage"));
  assert.equal(turnEnds(), 1);
  s.close();
});

test("engine stream death: error + turn_end, and later prompts fail fast instead of wedging", async () => {
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession(() =>
    (async function* (): AsyncGenerator<SDKMsg> {
      yield streamDelta({ type: "text_delta", text: "partial…" });
      throw new Error("engine died");
    })(),
  );
  s.pushPrompt("go");
  await awaitTurnEnd(1);
  assert.equal(msgs.find((m) => m.type === "error")!.message, "engine died");

  // The dead path: a queued prompt must get error + turn_end, not silence.
  s.pushPrompt("again");
  await awaitTurnEnd(2);
  const errors = msgs.filter((m) => m.type === "error");
  assert.equal(errors.length, 2);
  assert.match(errors[1].message, /stream ended/);
  assert.equal(turnEnds(), 2);
  s.close();
});

test("permission ask: canUseTool pauses on permission_request; resolvePermission allows", async () => {
  const decisions: { behavior: string }[] = [];
  const canOpts = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
  const { s, captured, awaitMsg, awaitTurnEnd } = makeSession(() =>
    (async function* (): AsyncGenerator<SDKMsg> {
      decisions.push((await captured.options!.canUseTool!("Bash", { command: "make it so" }, canOpts))!);
      yield RESULT;
    })(),
  );
  s.pushPrompt("go");
  const ask = await awaitMsg((m) => m.type === "permission_request", "permission_request");
  assert.equal(ask.tool, "Bash");
  assert.equal(ask.detail, "make it so");
  s.resolvePermission(ask.id, true);
  await awaitTurnEnd();
  assert.equal(decisions[0].behavior, "allow");
  s.close();
});

test("interrupt: pending permission asks die as deny, engine interrupted, one turn_end", async () => {
  const decisions: { behavior: string }[] = [];
  const canOpts = { signal: new AbortController().signal, toolUseID: "t", requestId: "r" };
  const { s, msgs, captured, turnEnds, awaitMsg, awaitTurnEnd } = makeSession(() =>
    (async function* (): AsyncGenerator<SDKMsg> {
      decisions.push((await captured.options!.canUseTool!("Write", { file_path: "a" }, canOpts))!);
      // The real SDK stops the turn on interrupt; the stub just stops yielding.
    })(),
  );
  s.pushPrompt("go");
  await awaitMsg((m) => m.type === "permission_request", "permission_request");
  s.interrupt();
  await awaitTurnEnd();
  assert.equal(decisions[0].behavior, "deny");
  assert.equal(captured.interrupts, 1);
  assert.equal(turnEnds(), 1);
  assert.ok(!msgs.some((m) => m.type === "error"));
  s.close();
});

test("close() is quiet: no error from the ending stream, later prompts are dropped", async () => {
  const { s, msgs, captured } = makeSession();
  s.close();
  await new Promise((r) => setTimeout(r, 50)); // let pump wind down
  s.pushPrompt("into the void");
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(msgs, []);
  assert.equal(captured.interrupts, 1); // close interrupts the engine
});
