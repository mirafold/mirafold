import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import type { query, Options } from "@anthropic-ai/claude-agent-sdk";
import type { WireMsg } from "../protocol";
import { ClaudeCodeSession } from "./claude-code";
import { MIRAFOLD_CONTEXT, RENDER_GUIDANCE, makeRenderServer } from "../render-tools";

// The Claude Code SDK-message→WireMsg mapping and the turn grammar, on
// synthetic SDKMessages — no CLI, no network. The session is real; only the
// engine is swapped via the constructor's `engine` seam for a stub that
// consumes the real promptStream and replays scripted turns, so the whole
// pushPrompt → queue → pump → emit path runs as shipped. `canUseTool` is
// captured off the real options, so the permission plumbing is the shipped
// makeCanUseTool → ask → resolvePermission chain too (L.2e).

type Any = WireMsg & Record<string, any>;
type SDKMsg = Record<string, unknown>;
type Turn = SDKMsg[] | (() => AsyncGenerator<SDKMsg>);

const tmp = mkdtempSync(path.join(os.tmpdir(), "genui-claude-test-"));
// The folder-trust gate (audit 2026-08-26): every session below lives under
// `tmp`, so vouching for that root once keeps these tests about the SDK
// stream; the gate itself is tested at the end with its own untrusted dirs.
const trustRecord = path.join(tmp, "trusted-workspaces.json");
writeFileSync(trustRecord, JSON.stringify({ version: 2, scopes: { "claude-code": [tmp] } }));
process.env.MIRAFOLD_WORKSPACE_TRUST_FILE = trustRecord;

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

  // A parent-tagged stream_event is dropped (the SDK never sends them —
  // SA.0 probe — the guard is fail-safe); subagent prose forwards only from
  // complete assistant messages, of which this turn scripts none.
  assert.ok(!msgs.some((m) => m.type === "text_delta"));
  assert.ok(!msgs.some((m) => m.type === "render")); // subagent TodoWrite swallowed
  assert.ok(!msgs.some((m) => m.type === "tool_use" && m.id === "st1"));
  s.close();
});

test("SA.2: subagent narration forwards — parent-tagged text and thinking blocks become parented deltas", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession([
    assistant([{ type: "tool_use", id: "task1", name: "Agent", input: { prompt: "delegate" } }]),
    // The subagent narrates, reasons, acts — all COMPLETE messages, live.
    assistant([{ type: "text", text: "Following the cookie…" }], "task1"),
    assistant([{ type: "thinking", thinking: "the relay never sees it" }], "task1"),
    assistant([{ type: "tool_use", id: "in1", name: "Read", input: { file_path: "a.ts" } }], "task1"),
    user([{ type: "tool_result", tool_use_id: "in1", content: "inner out" }], "task1"),
    user([{ type: "tool_result", tool_use_id: "task1", content: "done" }]),
    // Parent prose after the fan-out: buffered-text rule untouched — no
    // deltas streamed this turn, so the buffered copy paints, un-parented.
    assistant([{ type: "text", text: "PARENT SUMMARY" }]),
    RESULT,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();

  const subText = msgs.find((m) => m.type === "text_delta" && m.parentId === "task1")!;
  assert.equal(subText.text, "Following the cookie…");
  const subThink = msgs.find((m) => m.type === "thinking_delta" && m.parentId === "task1")!;
  assert.equal(subThink.text, "the relay never sees it");
  const parentText = msgs.find((m) => m.type === "text_delta" && m.parentId === undefined)!;
  assert.equal(parentText.text, "PARENT SUMMARY");
  // Wire order: the subagent's narration lands between its spawn and its
  // first tool call, exactly as streamed.
  const order = msgs
    .filter((m) => (m.type === "tool_use" && (m.id === "task1" || m.id === "in1")) || m.parentId === "task1")
    .map((m) => m.type + ":" + (m.id ?? ""));
  assert.deepEqual(order, ["tool_use:task1", "text_delta:", "thinking_delta:", "tool_use:in1", "tool_result:in1"]);
  s.close();
});

test("SA.2: the per-subagent narration budget caps with one explicit marker, per subagent", async () => {
  const { SubagentProseBudget, SUBAGENT_PROSE_ELIDED } = await import("./types");
  const budget = new SubagentProseBudget(10);
  assert.equal(budget.take("a", "12345"), "12345"); // within budget
  const second = budget.take("a", "678901234"); // crosses the 10-byte cap
  assert.equal(second, "67890" + SUBAGENT_PROSE_ELIDED(10));
  assert.equal(budget.take("a", "more"), ""); // capped: silent thereafter (marker already shown)
  // Budgets are PER subagent — a sibling still has its own headroom.
  assert.equal(budget.take("b", "hello"), "hello");
  // Multi-byte safety: a chunk sliced mid-codepoint decodes to U+FFFD, never throws.
  const tight = new SubagentProseBudget(1);
  const sliced = tight.take("c", "é"); // 2 bytes UTF-8
  assert.ok(sliced.startsWith("�"));
  budget.clear();
  assert.equal(budget.take("a", "fresh"), "fresh"); // turn boundary resets
});

test("audit: the ledger caps DISTINCT subagents per turn — fabricated parent ids can't grow it unboundedly", async () => {
  const { SubagentProseBudget } = await import("./types");
  const budget = new SubagentProseBudget(1_000, 2);
  assert.equal(budget.take("p1", "one"), "one");
  assert.equal(budget.take("p2", "two"), "two");
  assert.equal(budget.take("p3", "three"), "", "a third distinct parent is dropped silently");
  assert.equal(budget.take("p1", "still fine"), "still fine", "tracked parents keep their budget");
  budget.clear();
  assert.equal(budget.take("p3", "next turn"), "next turn", "the cap is per turn");
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

test("announced tools clear at the turn boundary — a stale cross-turn result is dropped", async () => {
  // Interrupt-mid-call leaves an announced id with no result; without the
  // boundary clear it sat in the set for the session's life (2026-07-28).
  // Results never span turns, so a turn-2 result for turn 1's id is stale
  // and must be dropped, not complete the old row.
  const { s, msgs, awaitTurnEnd } = makeSession(
    [
      assistant([{ type: "tool_use", id: "t-stale", name: "Bash", input: { command: "ls" } }]),
      RESULT,
    ],
    [user([{ type: "tool_result", tool_use_id: "t-stale", content: "too late" }]), RESULT],
  );
  s.pushPrompt("go");
  await awaitTurnEnd(1);
  s.pushPrompt("again");
  await awaitTurnEnd(2);
  assert.ok(msgs.some((m) => m.type === "tool_use" && m.id === "t-stale"), "turn 1 announced it");
  assert.ok(!msgs.some((m) => m.type === "tool_result"), "the stale result is dropped");
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
  // The other side of the attribution rule (2026-07-20 audit): this sentence
  // is Mirafold's own, so it carries no engine badge.
  assert.equal(notice.source, undefined);
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
  // The resolution is announced on the stream (2026-07-28): every OTHER
  // viewport drops its bar on this instead of holding a stale ask that a tap
  // can only no-op against.
  const resolved = await awaitMsg((m) => m.type === "permission_resolved", "permission_resolved");
  assert.equal(resolved.id, ask.id);
  assert.equal(resolved.allow, true);
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
  const ask = await awaitMsg((m) => m.type === "permission_request", "permission_request");
  s.interrupt();
  await awaitTurnEnd();
  // The deny-all teardown announces the resolution too — same contract as an
  // answered ask (2026-07-28).
  const resolved = await awaitMsg((m) => m.type === "permission_resolved", "permission_resolved");
  assert.equal(resolved.id, ask.id);
  assert.equal(resolved.allow, false);
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

// ── N.5: the chosen backend reaches the ENGINE env (per-session, never a
// process.env mutation) — captured off the real options via the engine seam.

function capturedEnv(opts: {
  kind?: "api-key" | "subscription" | "local";
  endpoint?: string;
  endpointAuth?: "api-key" | "auth-token" | "none";
}): Record<string, string | undefined> | undefined {
  let env: Record<string, string | undefined> | undefined;
  let sawOptions = false;
  const engine = ((args: { prompt: AsyncIterable<unknown>; options: Options }) => {
    sawOptions = true;
    env = (args.options as { env?: Record<string, string | undefined> }).env;
    const gen = (async function* () {
      for await (const _p of args.prompt) {
        /* consume */
      }
    })();
    return Object.assign(gen, { interrupt: async () => {} });
  }) as unknown as typeof query;
  const s = new ClaudeCodeSession({ workspaceDir: tmp, model: "m", engine, ...opts });
  s.close();
  assert.ok(sawOptions, "engine stub was not invoked");
  return env;
}

function withAnthropicEnv(patch: Record<string, string | undefined>, fn: () => void) {
  const keys = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) process.env[k] = v;
    fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("UX.8: a discovered endpoint gets the dummy token and WITHHOLDS both real credentials", () => {
  withAnthropicEnv({ ANTHROPIC_API_KEY: "real-key", ANTHROPIC_AUTH_TOKEN: "real-token" }, () => {
    const env = capturedEnv({ kind: "local", endpoint: "http://127.0.0.1:11434" });
    assert.ok(env, "a local choice must pass a per-session env");
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:11434");
    assert.equal(env.ANTHROPIC_API_KEY, undefined, "the real key must not reach a local server");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "ollama", "the real token is replaced, not inherited");
  });
});

test("UX.8: a configured endpoint receives only its explicitly bound API key mode", () => {
  withAnthropicEnv(
    { ANTHROPIC_API_KEY: "bound-key", ANTHROPIC_AUTH_TOKEN: "other-token" },
    () => {
      const env = capturedEnv({
        kind: "local",
        endpoint: "https://configured.example/v1",
        endpointAuth: "api-key",
      });
      assert.equal(env?.ANTHROPIC_BASE_URL, "https://configured.example/v1");
      assert.equal(env?.ANTHROPIC_API_KEY, "bound-key");
      assert.equal(env?.ANTHROPIC_AUTH_TOKEN, undefined);
    },
  );
});

test("UX.8: a configured endpoint receives only its explicitly bound auth-token mode", () => {
  withAnthropicEnv(
    { ANTHROPIC_API_KEY: "other-key", ANTHROPIC_AUTH_TOKEN: "bound-token" },
    () => {
      const env = capturedEnv({
        kind: "local",
        endpoint: "https://configured.example/v1",
        endpointAuth: "auth-token",
      });
      assert.equal(env?.ANTHROPIC_BASE_URL, "https://configured.example/v1");
      assert.equal(env?.ANTHROPIC_API_KEY, undefined);
      assert.equal(env?.ANTHROPIC_AUTH_TOKEN, "bound-token");
    },
  );
});

test("UX.8: an unauthenticated configured endpoint cannot inherit either ambient credential", () => {
  withAnthropicEnv(
    { ANTHROPIC_API_KEY: "parent-key", ANTHROPIC_AUTH_TOKEN: "parent-token" },
    () => {
      const env = capturedEnv({
        kind: "local",
        endpoint: "https://checkout.example/v1",
        endpointAuth: "none",
      });
      assert.equal(env?.ANTHROPIC_API_KEY, undefined);
      assert.equal(env?.ANTHROPIC_AUTH_TOKEN, "ollama");
    },
  );
});

test("UX.8: an SDK failure cannot echo a sensitive configured endpoint onto the wire", async () => {
  const endpoint = "https://alice:password@example.test/private-base?sig=topsecret";
  const engine = ((args: { prompt: AsyncIterable<unknown> }) => {
    const gen = (async function* () {
      for await (const _prompt of args.prompt) {
        throw new Error(`fetch failed at ${endpoint}`);
      }
    })();
    return Object.assign(gen, { interrupt: async () => {} });
  }) as unknown as typeof query;
  const s = new ClaudeCodeSession({
    workspaceDir: tmp,
    model: "m",
    kind: "local",
    endpoint,
    endpointAuth: "none",
    engine,
  });
  const seen: WireMsg[] = [];
  s.onMessage((msg) => seen.push(msg));
  s.pushPrompt("go");
  for (let i = 0; i < 50 && !seen.some((msg) => msg.type === "turn_end"); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const error = seen.find((msg) => msg.type === "error");
  assert.equal(error?.type, "error");
  if (error?.type === "error") {
    assert.match(error.message, /\[selected endpoint\]/);
    assert.doesNotMatch(error.message, /alice|password|private-base|topsecret|example\.test/);
  }
  assert.ok(seen.some((msg) => msg.type === "turn_end"));
  s.close();
});

test("N.5: an explicit api-key choice strips a globally-set BASE_URL — the session truly runs on the key", () => {
  withAnthropicEnv(
    { ANTHROPIC_API_KEY: "real-key", ANTHROPIC_BASE_URL: "http://localhost:11434" },
    () => {
      const env = capturedEnv({ kind: "api-key" });
      assert.ok(env);
      assert.equal(env.ANTHROPIC_BASE_URL, undefined);
      assert.equal(env.ANTHROPIC_API_KEY, "real-key");
    },
  );
});

test("N.5: no explicit choice inherits; an identifier-free local choice is credential-safe", () => {
  withAnthropicEnv({ ANTHROPIC_BASE_URL: "http://localhost:11434" }, () => {
    // No explicit choice inherits the ambient endpoint (a filtered copy of
    // the daemon's env — audit 2026-08-26 — never the raw process env).
    assert.equal(capturedEnv({})?.ANTHROPIC_BASE_URL, "http://localhost:11434");
    const env = capturedEnv({ kind: "local" });
    assert.equal(env?.ANTHROPIC_BASE_URL, "http://localhost:11434");
    assert.equal(env?.ANTHROPIC_API_KEY, undefined);
    assert.equal(env?.ANTHROPIC_AUTH_TOKEN, "ollama");
  });
});

// 2026-07-29 bughunt: an emptied task list never cleared the painted
// checklist — TodoWrite {todos: []} was skipped whole (normalizeTodos
// collapsed valid-empty to null) and deleting the LAST task hit
// emitChecklist's size-0 early return, so the block froze showing deleted
// items and a later TaskCreate resurrected them beside the new one.

test("checklist: an empty TodoWrite clears the painted list; nothing resurrects", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession([
    assistant([
      {
        type: "tool_use",
        id: "w1",
        name: "TodoWrite",
        input: { todos: [{ content: "a", status: "pending" }, { content: "b", status: "pending" }] },
      },
    ]),
    assistant([{ type: "tool_use", id: "w2", name: "TodoWrite", input: { todos: [] } }]),
    assistant([{ type: "tool_use", id: "c1", name: "TaskCreate", input: { subject: "c" } }]),
    RESULT,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();

  const renders = msgs.filter((m) => m.type === "render" && m.component === "todo-list");
  const todos = (r: Any) => r.props.todos.map((t: Any) => t.content);
  assert.equal(renders.length, 3);
  assert.deepEqual(todos(renders[0]), ["a", "b"]);
  assert.deepEqual(todos(renders[1]), [], "the clear updates the painted block");
  assert.deepEqual(todos(renders[2]), ["c"], "no deleted item rides back in");
  s.close();
});

test("checklist: deleting the last task updates the painted block to empty", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession([
    assistant([{ type: "tool_use", id: "c1", name: "TaskCreate", input: { subject: "only" } }]),
    assistant([{ type: "tool_use", id: "u1", name: "TaskUpdate", input: { taskId: "1", status: "deleted" } }]),
    RESULT,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();

  const renders = msgs.filter((m) => m.type === "render" && m.component === "todo-list");
  assert.equal(renders.length, 2);
  assert.deepEqual(renders[1].props.todos, [], "the deletion reaches the screen");
  assert.equal(renders[1].id, renders[0].id, "same block, updated in place");
  s.close();
});

test("checklist: an empty TodoWrite with nothing painted stays silent", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession([
    assistant([{ type: "tool_use", id: "w1", name: "TodoWrite", input: { todos: [] } }]),
    RESULT,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  assert.ok(!msgs.some((m) => m.type === "render"), "no empty checklist is ever PAINTED");
  s.close();
});

test("recovery: Claude receives the saved SDK resume id and exposes its live command catalog", async () => {
  let options: Options | undefined;
  const engine = ((args: { prompt: AsyncIterable<unknown>; options: Options }) => {
    options = args.options;
    const stream = (async function* () {
      for await (const _prompt of args.prompt) {
        // This proof does not run a turn.
      }
    })();
    return Object.assign(stream, {
      interrupt: async () => {},
      supportedCommands: async () => [
        {
          name: "review",
          description: "review current changes",
          argumentHint: "[instructions]",
        },
      ],
    });
  }) as unknown as typeof query;
  const s = new ClaudeCodeSession({
    workspaceDir: tmp,
    resumeId: "11111111-1111-4111-8111-111111111111",
    engine,
  });
  const seen: WireMsg[] = [];
  s.onMessage((msg) => seen.push(msg));
  s.refreshPromptOptions();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(options?.resume, s.resumeId);
  assert.equal(options?.sessionId, undefined);
  // The environment fact rides the same system-prompt append as the render
  // guidance — the one injection point Claude has.
  assert.deepEqual(options?.systemPrompt, {
    type: "preset",
    preset: "claude_code",
    append: RENDER_GUIDANCE,
  });
  assert.ok(RENDER_GUIDANCE.includes(MIRAFOLD_CONTEXT));
  assert.deepEqual(
    seen.find((msg) => msg.type === "prompt_options"),
    {
      type: "prompt_options",
      options: [
        {
          trigger: "/",
          value: "/review",
          label: "review",
          description: "review current changes",
          argumentHint: "[instructions]",
          kind: "command",
          source: "claude-code",
        },
      ],
    },
  );
  s.close();
});

// ── The folder-trust gate (audit 2026-08-26): the SDK session applies the
// folder's own .claude/settings.json hooks and .mcp.json servers the moment
// it starts (probed: both ran with no prompt). So no engine exists before
// the folder is vouched for — the terminal's own first-run question.
test("an untrusted folder asks before the engine is created; a no runs nothing, a yes starts it and delivers the prompt", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "genui-claude-untrusted-"));
  let engineStarts = 0;
  const engine = ((args: { prompt: AsyncIterable<unknown>; options: Options }) => {
    engineStarts++;
    const gen = (async function* () {
      for await (const _prompt of args.prompt) {
        yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
        yield { type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } };
      }
    })();
    return Object.assign(gen, { interrupt: async () => {}, supportedCommands: async () => [] });
  }) as unknown as typeof query;
  const s = new ClaudeCodeSession({ workspaceDir: ws, engine });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  const waitFor = (pred: (m: Any) => boolean, label: string) =>
    new Promise<Any>((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        const hit = msgs.find(pred);
        if (hit) {
          clearInterval(poll);
          resolve(hit);
        } else if (Date.now() - t0 > 5_000) {
          clearInterval(poll);
          reject(new Error(`no ${label}; seen: ${msgs.map((m) => m.type).join(",")}`));
        }
      }, 5);
    });
  try {
    assert.equal(engineStarts, 0, "construction spawns nothing in an untrusted folder");
    s.refreshPromptOptions();
    s.pushPrompt("hello");
    const ask = await waitFor((m) => m.type === "permission_request", "the trust ask");
    assert.equal(ask.tool, "Claude Code");
    assert.match(ask.detail, /trust this folder/);
    assert.ok(ask.detail.includes(ws), "the ask names the exact folder");
    assert.match(ask.detail, /hooks/, "the ask says what a yes applies");
    assert.equal(engineStarts, 0, "nothing spawned while the ask is open");

    s.resolvePermission(ask.id, false);
    await waitFor((m) => m.type === "turn_end", "turn_end after the no");
    assert.ok(msgs.some((m) => m.type === "notice" && /haven't trusted/.test(m.text)));
    assert.equal(engineStarts, 0, "a no spawns nothing");
    assert.equal(existsSync(path.join(ws, ".claude")), false);

    msgs.length = 0;
    s.pushPrompt("hello again");
    const again = await waitFor((m) => m.type === "permission_request", "asked again");
    s.resolvePermission(again.id, true);
    await waitFor((m) => m.type === "text_delta" || m.type === "turn_end", "the prompt reached the engine");
    assert.equal(engineStarts, 1, "a yes starts the engine once");
    assert.ok(msgs.some((m) => m.type === "permission_resolved" && m.allow === true));
    s.pushPrompt("third");
    await waitFor((m) => m.type === "turn_end" && msgs.filter((x) => x.type === "turn_end").length >= 2, "the next prompt needs no ask");
    assert.equal(engineStarts, 1);
    assert.equal(msgs.filter((m) => m.type === "permission_request").length, 1, "asked once, ever");
  } finally {
    s.close();
  }
});

// Cold review (2026-08-26): the lazily started engine runs outside the
// constructor's guarded path, so a synchronous SDK failure (a missing native
// CLI binary) must be this turn's error — never an unhandled rejection that
// exits the daemon.
test("a synchronous engine failure on the first trusted prompt errors the turn, not the daemon", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "genui-claude-boom-"));
  const engine = (() => {
    throw new Error("Native CLI binary for linux-x64 not found");
  }) as unknown as typeof query;
  const s = new ClaudeCodeSession({ workspaceDir: ws, engine });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  const rejections: unknown[] = [];
  const onRejection = (r: unknown) => rejections.push(r);
  process.on("unhandledRejection", onRejection);
  try {
    s.pushPrompt("hello");
    const ask = await new Promise<Any>((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        const hit = msgs.find((m) => m.type === "permission_request");
        if (hit) { clearInterval(poll); resolve(hit); } else if (Date.now() - t0 > 5_000) { clearInterval(poll); reject(new Error("no ask")); }
      }, 5);
    });
    s.resolvePermission(ask.id, true);
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const poll = setInterval(() => {
        if (msgs.some((m) => m.type === "turn_end")) { clearInterval(poll); resolve(); } else if (Date.now() - t0 > 5_000) { clearInterval(poll); reject(new Error("no turn_end")); }
      }, 5);
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(msgs.some((m) => m.type === "error" && /could not start/.test(m.message)));
    assert.deepEqual(rejections, [], "no unhandled rejection");
  } finally {
    process.off("unhandledRejection", onRejection);
    s.close();
  }
});

test("the ui render server exempts every tool from Claude Code's tool-search deferral (alwaysLoad)", () => {
  // Claude Code defers MCP tool definitions behind ToolSearch by default, and
  // a model that has to search before it can paint mostly answers in prose.
  // The SDK expresses the exemption as `_meta["anthropic/alwaysLoad"]` on
  // each registered tool; the McpServer instance keeps them under
  // `_registeredTools` (an internal map, the only place the flag surfaces
  // without running a session).
  const server = makeRenderServer(() => {}, tmp);
  const registered = (server.instance as unknown as { _registeredTools: Record<string, { _meta?: Record<string, unknown> }> })
    ._registeredTools;
  const names = Object.keys(registered);
  assert.ok(names.includes("render_table") && names.includes("emit_artifact"), `tools: ${names.join(", ")}`);
  for (const name of names) {
    assert.equal(registered[name]._meta?.["anthropic/alwaysLoad"], true, `${name} must be always-loaded`);
  }
});
