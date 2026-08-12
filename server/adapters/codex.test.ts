import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import type { Codex, CodexOptions, ThreadEvent } from "@openai/codex-sdk";
import type { WireMsg } from "../protocol";
import { CodexSession, resolveRolloutModel, rolloutDateDir } from "./codex";
import { MIRAFOLD_MCP } from "./render-mcp-cmd";

// L.2b2: the Codex event→WireMsg mapping and the turn grammar, on synthetic
// ThreadEvents — no engine, no network. The session is real; only its private
// `thread` is swapped for a stub whose runStreamed replays scripted turns, so
// the whole worker → runTurn → handleEvent → onItem path runs as shipped.

type Any = WireMsg & Record<string, any>;
type Turn = ThreadEvent[] | ((signal: AbortSignal) => AsyncGenerator<ThreadEvent>);
type SessionOpts = Omit<ConstructorParameters<typeof CodexSession>[0], "workspaceDir">;

const tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-codex-test-"));
const ev = (e: Record<string, unknown>) => e as unknown as ThreadEvent;

/** Poll the message log until the Nth turn_end lands (worker turns are async). */
const waitForTurnEnds = (msgs: Any[], count = 1, timeoutMs = 5_000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (msgs.filter((m) => m.type === "turn_end").length >= count) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`no turn_end #${count}; seen: ${msgs.map((m) => m.type).join(",")}`));
      }
    }, 5);
  });

/** A CodexSession on a stubbed thread; each pushPrompt consumes the next turn.
 *  `prompts` records the exact text each turn sent to the engine (V.2). */
function makeSessionWithOptions(opts: SessionOpts, ...turns: Turn[]) {
  const s = new CodexSession({ workspaceDir: tmp, ...opts });
  const msgs: Any[] = [];
  const prompts: string[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  (s as unknown as { thread: unknown }).thread = {
    runStreamed: async (text: string, opts: { signal: AbortSignal }) => {
      prompts.push(text);
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
  const awaitTurnEnd = (count = 1) => waitForTurnEnds(msgs, count);
  return { s, msgs, prompts, turnEnds, awaitTurnEnd };
}

function makeSession(...turns: Turn[]) {
  return makeSessionWithOptions({}, ...turns);
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

test("first turn carries RENDER_GUIDANCE + the deferred-tools addendum; later turns are bare (V.2)", async () => {
  const doneTurn = [
    ev({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
  ];
  const { s, prompts, awaitTurnEnd } = makeSession(doneTurn, doneTurn);
  s.pushPrompt("first ask");
  await awaitTurnEnd(1);
  s.pushPrompt("second ask");
  await awaitTurnEnd(2);

  assert.equal(prompts.length, 2);
  // The guidance block, the deferral instruction, and the user's own text.
  assert.ok(prompts[0].includes("## Generative UI"));
  assert.ok(prompts[0].includes("DEFERRED"));
  assert.ok(prompts[0].includes("tool search"));
  assert.ok(prompts[0].endsWith("first ask"));
  // Later turns ride the warm thread — no re-injection.
  assert.equal(prompts[1], "second ask");
  s.close();
});

test("agent_message with a mermaid xychart paints a chart component; prose stays text (V.2)", async () => {
  const fence =
    "Here you go:\n\n```mermaid\nxychart-beta\n  title \"Revenue\"\n  x-axis [Jan, Feb]\n  y-axis \"USD\" 0 --> 20\n  bar [10, 15]\n```\n\nDone.";
  const { s, msgs, awaitTurnEnd } = makeSession([
    ev({ type: "item.completed", item: { type: "agent_message", id: "m1", text: fence } }),
    ev({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
  ]);
  s.pushPrompt("chart please");
  await awaitTurnEnd();

  const renders = msgs.filter((m) => m.type === "render" && m.component === "chart");
  assert.equal(renders.length, 1);
  assert.deepEqual(renders[0].props, {
    title: "Revenue",
    kind: "bar",
    x: ["Jan", "Feb"],
    series: [{ name: "USD", values: [10, 15] }],
    yLabel: "USD",
  });
  assert.ok(typeof renders[0].id === "string" && renders[0].id.length > 0);
  const texts = msgs.filter((m) => m.type === "text_delta").map((m) => m.text);
  assert.ok(texts.some((t) => t.includes("Here you go:")));
  assert.ok(texts.some((t) => t.includes("Done.")));
  assert.ok(texts.every((t) => !t.includes("xychart")));
  s.close();
});

// V.2 /model: a session with injectable model list + a makeCodex stub that
// records thread construction, so switches are observable without an engine.
/** A makeCodex stub whose threads run one empty turn and record every
 *  start/resume + prompt — the engine-free harness both the /model and the
 *  provider-binding suites observe switches through. */
function recordingCodex() {
  const calls: { kind: "start" | "resume"; id?: string; options: any }[] = [];
  const prompts: string[] = [];
  const fakeThread = () => ({
    runStreamed: async (text: string) => {
      prompts.push(text);
      return {
        events: (async function* () {
          yield ev({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
        })(),
      };
    },
  });
  const makeCodex = () =>
    ({
      startThread: (options: any) => {
        calls.push({ kind: "start", options });
        return fakeThread();
      },
      resumeThread: (id: string, options: any) => {
        calls.push({ kind: "resume", id, options });
        return fakeThread();
      },
    }) as any;
  return { calls, prompts, makeCodex };
}

function makeModelSession(listModels: () => Promise<any[]>, opts: SessionOpts = {}) {
  const { calls, prompts, makeCodex } = recordingCodex();
  const s = new CodexSession({ workspaceDir: tmp, ...opts, listModels, makeCodex });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  const awaitTurnEnd = (count = 1) => waitForTurnEnds(msgs, count);
  return { s, msgs, calls, prompts, awaitTurnEnd };
}

test("recovery and discovery: Codex resumes and advertises only implemented / commands plus live $ skills", async () => {
  const { calls, makeCodex } = recordingCodex();
  const s = new CodexSession({
    workspaceDir: tmp,
    resumeId: "codex-thread-saved",
    makeCodex,
    listSkills: async () => [{ name: "audit", description: "defensive security audit" }],
  });
  assert.deepEqual(calls.map((call) => [call.kind, call.id]), [
    ["resume", "codex-thread-saved"],
  ]);
  assert.equal(s.resumeId, "codex-thread-saved");

  const seen: WireMsg[] = [];
  s.onMessage((msg) => seen.push(msg));
  s.refreshPromptOptions();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const catalogs = seen.filter((msg) => msg.type === "prompt_options");
  const latest = catalogs.at(-1);
  assert.ok(latest?.type === "prompt_options");
  assert.deepEqual(
    latest.options.filter((option) => option.trigger === "/").map((option) => option.value),
    ["/model"],
    "TUI-only commands must never be advertised then sent to the model as prose",
  );
  assert.equal(
    latest.options.find((option) => option.value === "$audit")?.source,
    "codex",
    "workspace/provider skill text must carry fixed catalog provenance",
  );
  s.close();
});

test("Codex announces its provider resume id at thread.started", async () => {
  const { s, awaitTurnEnd } = makeSession([
    ev({ type: "thread.started", thread_id: "codex-thread-new" }),
    ev({
      type: "turn.completed",
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
        reasoning_output_tokens: 0,
      },
    }),
  ]);
  // Avoid the unrelated rollout-file model lookup in this identity test.
  (s as unknown as { modelLabel: string }).modelLabel = "gpt-test";
  const resumeIds: string[] = [];
  s.onResumeId((id) => resumeIds.push(id));
  s.pushPrompt("start the thread");
  await awaitTurnEnd();
  assert.deepEqual(resumeIds, ["codex-thread-new"]);
  assert.equal(s.resumeId, "codex-thread-new");
  s.close();
});

const CATALOG = [
  { id: "gpt-9-sol", displayName: "GPT-9-Sol", description: "frontier", isDefault: true },
  { id: "gpt-9-terra", displayName: "GPT-9-Terra", description: "balanced", isDefault: false },
  { id: "gpt-9-luna", displayName: "GPT-9-Luna", description: "fast", isDefault: false },
];

test("bare /model paints the picker from codex's own catalog; no engine turn runs (V.2)", async () => {
  const { s, msgs, prompts, awaitTurnEnd } = makeModelSession(async () => CATALOG);
  s.pushPrompt("/model");
  await awaitTurnEnd();

  const p = msgs.find((m) => m.type === "picker")!;
  assert.ok(p, "picker rendered");
  assert.equal(p.title, "Select a model");
  const rows = p.rows as any[];
  assert.deepEqual(
    rows.map((r) => r.text),
    ["/model gpt-9-sol", "/model gpt-9-terra", "/model gpt-9-luna"],
  );
  // Default is current while the label is still the stand-in.
  assert.equal(rows[0].current, true);
  assert.equal(rows[1].current, undefined);
  assert.equal(rows[0].label, "GPT-9-Sol");
  assert.equal(rows[0].detail, "frontier");
  assert.ok(p.hint?.includes("/model <model-id>"));
  assert.equal(prompts.length, 0); // never reached the engine
  s.close();
});

test("/model <id>: unstarted session restarts the thread; started session resumes it (V.2)", async () => {
  const { s, msgs, calls, awaitTurnEnd } = makeModelSession(async () => CATALOG);
  assert.equal(calls.length, 1); // the constructor's startThread
  s.pushPrompt("/model gpt-9-terra");
  await awaitTurnEnd();
  assert.deepEqual(calls[1], {
    kind: "start", // no thread.started seen yet → nothing to resume
    options: { workingDirectory: tmp, skipGitRepoCheck: true, model: "gpt-9-terra" },
  });
  assert.equal(s.modelName, "gpt-9-terra");
  assert.ok(msgs.some((m) => m.type === "text_delta" && m.text.includes("gpt-9-terra")));

  // Now with a live thread id: the switch must RESUME (history intact).
  (s as any).threadId = "t-123";
  s.pushPrompt("/model gpt-9-luna");
  await awaitTurnEnd(2);
  assert.deepEqual(calls[2], {
    kind: "resume",
    id: "t-123",
    options: { workingDirectory: tmp, skipGitRepoCheck: true, model: "gpt-9-luna" },
  });
  assert.equal(s.modelName, "gpt-9-luna");
  s.close();
});

test("/model failure paths: unreadable catalog errors honestly; extra words get usage (V.2)", async () => {
  const { s, msgs, awaitTurnEnd } = makeModelSession(async () => {
    throw new Error("spawn ENOENT");
  });
  s.pushPrompt("/model");
  await awaitTurnEnd();
  assert.ok(msgs.some((m) => m.type === "error" && m.message.includes("spawn ENOENT")));
  s.pushPrompt("/model two words");
  await awaitTurnEnd(2);
  assert.ok(msgs.some((m) => m.type === "text_delta" && m.text.includes("Usage:")));
  s.pushPrompt("/model --sneaky-flag");
  await awaitTurnEnd(3);
  assert.equal(msgs.filter((m) => m.type === "text_delta" && m.text.includes("Usage:")).length, 2);
  s.close();
});

// V-thread /effort scaffold: the reasoning-effort axis of the /model picker.
// All five efforts ride the same shell-owned picker as /model (no row cap);
// a pick resumes/restarts the warm thread carrying modelReasoningEffort,
// exactly like /model carries model.
test("bare /effort paints the effort picker; no engine turn runs", async () => {
  const { s, msgs, prompts, awaitTurnEnd } = makeModelSession(async () => CATALOG);
  s.pushPrompt("/effort");
  await awaitTurnEnd();

  const p = msgs.find((m) => m.type === "picker")!;
  assert.ok(p, "effort picker rendered");
  assert.equal(p.title, "Select reasoning effort");
  const rows = p.rows as any[];
  // All five efforts, in the engine's order; none marked current (untouched).
  assert.deepEqual(
    rows.map((r) => r.label),
    ["minimal", "low", "medium", "high", "xhigh"],
  );
  assert.deepEqual(
    rows.map((r) => r.text),
    ["/effort minimal", "/effort low", "/effort medium", "/effort high", "/effort xhigh"],
  );
  assert.ok(!rows.some((r) => r.current), "nothing current before a pick");
  assert.ok(p.hint?.includes("/effort <level>"));
  assert.equal(prompts.length, 0); // never reached the engine
  s.close();
});

test("a discovered local /effort picker adds none and passes it to Codex", async () => {
  const { s, msgs, calls, prompts, awaitTurnEnd } = makeModelSession(async () => CATALOG, {
    kind: "local",
    endpoint: "http://127.0.0.1:11434",
    localTurnTimeoutMs: 0,
  });

  s.pushPrompt("/effort");
  await awaitTurnEnd();
  const picker = msgs.find((m) => m.type === "picker")!;
  assert.deepEqual(
    (picker.rows as any[]).map((row) => row.label),
    ["none", "minimal", "low", "medium", "high", "xhigh"],
  );
  assert.equal((picker.rows as any[])[0].text, "/effort none");

  s.pushPrompt("/effort none");
  await awaitTurnEnd(2);
  assert.deepEqual(calls.at(-1), {
    kind: "start",
    options: { workingDirectory: tmp, skipGitRepoCheck: true, modelReasoningEffort: "none" },
  });
  assert.ok(msgs.some((m) => m.type === "text_delta" && m.text.includes("effort set to none")));
  assert.equal(prompts.length, 0, "the local slash command never becomes model prose");
  s.close();
});

test("/effort <level>: unstarted restarts, started resumes; threadOpts carries the effort", async () => {
  const { s, msgs, calls, awaitTurnEnd } = makeModelSession(async () => CATALOG);
  assert.equal(calls.length, 1); // constructor's startThread
  s.pushPrompt("/effort high");
  await awaitTurnEnd();
  assert.deepEqual(calls[1], {
    kind: "start", // no thread.started yet → nothing to resume
    options: { workingDirectory: tmp, skipGitRepoCheck: true, modelReasoningEffort: "high" },
  });
  assert.ok(msgs.some((m) => m.type === "text_delta" && m.text.includes("effort set to high")));

  // A pick now marks itself current in a fresh picker.
  s.pushPrompt("/effort");
  await awaitTurnEnd(2);
  const p = msgs.filter((m) => m.type === "picker").at(-1)!;
  const hi = (p.rows as any[]).find((r) => r.label === "high")!;
  assert.equal(hi.current, true, "the set effort reads back as current");

  // With a live thread id the switch RESUMES (history intact), and a prior
  // model override on threadOpts is preserved alongside the effort.
  (s as any).threadId = "t-eff";
  (s as any).threadOpts.model = "gpt-9-luna";
  s.pushPrompt("/effort low");
  await awaitTurnEnd(3);
  assert.deepEqual(calls.at(-1), {
    kind: "resume",
    id: "t-eff",
    options: { workingDirectory: tmp, skipGitRepoCheck: true, model: "gpt-9-luna", modelReasoningEffort: "low" },
  });
  s.close();
});

test("/effort <bad>: an unknown level gets a usage line, never reaches the engine", async () => {
  const { s, msgs, prompts, awaitTurnEnd } = makeModelSession(async () => CATALOG);
  s.pushPrompt("/effort turbo");
  await awaitTurnEnd();
  const usage = msgs.find((m) => m.type === "text_delta" && m.text.includes("Usage:"))!;
  assert.ok(usage, "usage line emitted");
  assert.ok(usage.text.includes("minimal, low, medium, high, xhigh"), "lists the valid levels");
  assert.ok(!usage.text.includes("none"), "non-local sessions do not advertise the extension");
  assert.equal(prompts.length, 0);
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

test("a completed command with a nonzero exit is not an error — the exit code is annotated", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession([
    ev({
      type: "item.completed",
      item: {
        type: "command_execution",
        id: "c10",
        command: "grep -r missing src/",
        aggregated_output: "",
        exit_code: 1,
        status: "completed",
      },
    }),
    ev({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }),
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const result = msgs.find((m) => m.type === "tool_result" && m.id === "c10")!;
  assert.ok(!result.isError, "a probe's nonzero exit was branded an error");
  assert.equal(result.output, "(exit 1)");
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

test("a discovered local provider failure names the server/model recovery check", async () => {
  const { s, msgs, awaitTurnEnd } = makeSessionWithOptions(
    {
      kind: "local",
      endpoint: "http://127.0.0.1:11434",
      localTurnTimeoutMs: 0,
    },
    [
      ev({ type: "turn.started" }),
      ev({ type: "turn.failed", error: { message: "connection refused" } }),
    ],
  );
  s.pushPrompt("go");
  await awaitTurnEnd();
  const error = msgs.find((m) => m.type === "error")!;
  assert.match(error.message, /^Local Codex could not complete the turn: connection refused/);
  assert.match(error.message, /server is running and still serves the selected model/);
  s.close();
});

test("a discovered local turn timeout aborts with one actionable error and one turn_end", async () => {
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSessionWithOptions(
    {
      kind: "local",
      endpoint: "http://127.0.0.1:11434",
      localTurnTimeoutMs: 25,
    },
    (signal) =>
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
  await awaitTurnEnd();

  const errors = msgs.filter((m) => m.type === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /local Codex turn did not finish/i);
  assert.match(errors[0].message, /\/effort none/);
  assert.match(errors[0].message, /MIRAFOLD_CODEX_LOCAL_TURN_TIMEOUT_MS/);
  assert.equal(turnEnds(), 1);
  s.close();
});

test("a local timeout does not recommend /effort none when reasoning is already disabled", async () => {
  const { s, msgs, awaitTurnEnd } = makeSessionWithOptions(
    {
      kind: "local",
      endpoint: "http://127.0.0.1:11434",
      localTurnTimeoutMs: 25,
    },
    (signal) =>
      (async function* (): AsyncGenerator<ThreadEvent> {
        await new Promise<never>((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      })(),
  );
  (s as unknown as { effortLabel: string }).effortLabel = "none";
  s.pushPrompt("go");
  await awaitTurnEnd();
  const error = msgs.find((m) => m.type === "error")!;
  assert.match(error.message, /Reasoning is already disabled/);
  assert.doesNotMatch(error.message, /Send `\/effort none`/);
  s.close();
});

test("UX.8: a configured provider failure cannot echo its exact base URL", async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "mcp-codex-provider-redaction-"));
  const endpoint = "https://tenant.example/private/token-path";
  writeFileSync(
    path.join(home, "config.toml"),
    [
      'model_provider = "private"',
      "[model_providers.private]",
      `base_url = "${endpoint}"`,
    ].join("\n"),
  );
  const savedHome = process.env.CODEX_HOME;
  let s: CodexSession;
  try {
    process.env.CODEX_HOME = home;
    s = new CodexSession({
      workspaceDir: tmp,
      kind: "local",
      provider: "private",
      makeCodex: () => ({ startThread: () => ({}) }) as unknown as Codex,
    });
  } finally {
    if (savedHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedHome;
  }
  const msgs: Any[] = [];
  s.onMessage((msg) => msgs.push(msg as Any));
  (s as unknown as { thread: unknown }).thread = {
    runStreamed: async () => ({
      events: (async function* () {
        yield ev({
          type: "turn.failed",
          error: { message: `request ${endpoint}/responses failed` },
        });
      })(),
    }),
  };
  s.pushPrompt("go");
  await waitForTurnEnds(msgs);
  const message = msgs.find((msg) => msg.type === "error")?.message ?? "";
  assert.equal(message, "request [selected endpoint]/responses failed");
  assert.doesNotMatch(message, /tenant|private|token-path/);
  s.close();
});

test("a non-fatal error ITEM is a warning notice, and the turn keeps going", async () => {
  // The SDK types ErrorItem "a non-fatal error surfaced as an item" — Codex's
  // own advisory (no metadata for a local model's slug, say). Rendering it as
  // an `error` was louder than the terminal we re-skin (2026-07-20).
  const { s, msgs, awaitTurnEnd } = makeSession([
    ev({ type: "turn.started" }),
    ev({
      type: "item.completed",
      item: { type: "error", id: "e1", message: "Model metadata for `qwen3:1.7b` not found." },
    }),
    ev({ type: "item.completed", item: { type: "agent_message", id: "m1", text: "the reply" } }),
    ev({
      type: "turn.completed",
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
    }),
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const notice = msgs.find((m) => m.type === "notice")!;
  assert.equal(notice.kind, "warning");
  assert.match(notice.text, /Model metadata/);
  // The text is codex's own, so it must be attributed: unbadged, the dim
  // system line is Mirafold's voice (2026-07-20 audit).
  assert.equal(notice.source, "codex");
  assert.ok(!msgs.some((m) => m.type === "error"), "a non-fatal item must not render as an error");
  // The advisory did not eat the turn: the reply still arrived, after it.
  const types = msgs.map((m) => m.type);
  assert.ok(types.indexOf("notice") < types.indexOf("text_delta"));
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

// ---- Resolved-model lookup (fleet/status-bar parity with Claude, F.3) ------
// The SDK stream never names the model; the rollout file's turn_context does.

const rolloutFixture = (threadId: string, lines: string[]) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "codex-home-test-"));
  const day = rolloutDateDir(home, new Date());
  mkdirSync(day, { recursive: true });
  writeFileSync(
    path.join(day, `rollout-2026-07-16T21-58-26-${threadId}.jsonl`),
    lines.join("\n") + "\n",
  );
  return home;
};

const META_LINE = JSON.stringify({
  type: "session_meta",
  payload: { session_id: "t-1", model_provider: "openai" },
});
const CONTEXT_LINE = JSON.stringify({
  type: "turn_context",
  payload: { model: "gpt-5.6-sol", settings: { model: "gpt-5.6-sol" } },
});

/** The minimal turn whose thread.started kicks off the model lookup. */
const lookupTurn = (threadId: string): ThreadEvent[] => [
  ev({ type: "thread.started", thread_id: threadId }),
  ev({ type: "turn.started" }),
  ev({
    type: "turn.completed",
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
  }),
];

test("resolveRolloutModel: reads the model from the thread's turn_context line", async () => {
  const home = rolloutFixture("t-1", [META_LINE, "not json {", CONTEXT_LINE]);
  assert.equal(await resolveRolloutModel("t-1", home), "gpt-5.6-sol");
  // An unknown thread, or a record with no model yet, resolves to nothing.
  assert.equal(await resolveRolloutModel("t-other", home), undefined);
  const bare = rolloutFixture("t-2", [META_LINE]);
  assert.equal(await resolveRolloutModel("t-2", bare), undefined);
});

test("thread.started triggers the lookup: modelName goes from unknown to the truth", async () => {
  const home = rolloutFixture("t-3", [META_LINE, CONTEXT_LINE]);
  const { s, awaitTurnEnd } = makeSession(lookupTurn("t-3"));
  (s as unknown as { codexHome: string }).codexHome = home;
  // Pre-turn the model is unknown — reported as absent, never a stand-in.
  assert.equal(s.modelName, undefined);
  s.pushPrompt("go");
  await awaitTurnEnd();
  // The lookup is async beside the turn — give its first attempt a beat.
  const t0 = Date.now();
  while (s.modelName === undefined && Date.now() - t0 < 3_000)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(s.modelName, "gpt-5.6-sol");
  s.close();
});

test("a configured model is the label — the rollout lookup never overrides it", async () => {
  const home = rolloutFixture("t-4", [CONTEXT_LINE]);
  const { s, awaitTurnEnd } = makeSession(lookupTurn("t-4"));
  (s as unknown as { codexHome: string }).codexHome = home;
  (s as unknown as { modelLabel: string }).modelLabel = "o3-configured";
  s.pushPrompt("go");
  await awaitTurnEnd();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.modelName, "o3-configured");
  s.close();
});

// ── N.5: the chosen backend reaches the ENGINE's construction options —
// captured via the makeCodex seam (the SDK object is never built here).

function capturedCodexOptions(opts: {
  kind?: "api-key" | "subscription" | "local";
  endpoint?: string;
  provider?: string;
  model?: string;
}): CodexOptions {
  let captured: CodexOptions | undefined;
  const s = new CodexSession({
    workspaceDir: tmp,
    ...opts,
    makeCodex: (o) => {
      captured = o;
      return { startThread: () => ({}) } as unknown as Codex;
    },
  });
  s.close();
  assert.ok(captured, "makeCodex seam was not invoked");
  return captured;
}

function withEnvVar(name: string, value: string | undefined, fn: () => void) {
  const saved = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

const withOpenAiKey = (value: string | undefined, fn: () => void) =>
  withEnvVar("OPENAI_API_KEY", value, fn);

test("F.10: the installed Codex executable drives the SDK engine", () => {
  withEnvVar("MIRAFOLD_CODEX_BIN", "/operator/chosen/codex", () => {
    const o = capturedCodexOptions({ kind: "subscription" });
    assert.equal(o.codexPathOverride, "/operator/chosen/codex");
  });
});

test("N.5: a subscription choice withholds the env API key — the explicit pick beats env precedence", () => {
  withOpenAiKey("sk-env", () => {
    const o = capturedCodexOptions({ kind: "subscription" });
    assert.equal(o.apiKey, undefined);
    assert.ok(o.env, "subscription must pass an env override");
    assert.ok(!("OPENAI_API_KEY" in o.env!), "the env key must not reach the engine");
  });
});

test("N.5: an api-key choice passes the key, no env override (auth.json stays reachable but unused)", () => {
  withOpenAiKey("sk-env", () => {
    const o = capturedCodexOptions({ kind: "api-key" });
    assert.equal(o.apiKey, "sk-env");
    assert.equal(o.env, undefined);
  });
});

test("N.5: no choice keeps the pre-N default — apiKey iff the env var is set, nothing else", () => {
  withOpenAiKey("sk-env", () => {
    const o = capturedCodexOptions({});
    assert.equal(o.apiKey, "sk-env");
    assert.equal(o.env, undefined);
  });
  withOpenAiKey(undefined, () => {
    const o = capturedCodexOptions({});
    assert.equal(o.apiKey, undefined);
    assert.equal(o.env, undefined);
  });
});

test("N.5: a discovered-endpoint choice injects the documented provider recipe, keeping the MCP config", () => {
  let o!: CodexOptions;
  withOpenAiKey("sk-env", () => {
    o = capturedCodexOptions({
      kind: "local",
      endpoint: "http://127.0.0.1:11434",
      model: "qwen3-coder",
    });
    // 2026-07-17 audit: the key is withheld from a local-endpoint engine —
    // same posture as the claude adapter's local branch.
    assert.ok(o.env);
    assert.ok(!("OPENAI_API_KEY" in o.env!));
    assert.equal(o.apiKey, undefined);
  });
  const config = o.config as {
    model_provider?: string;
    model_providers?: Record<string, { base_url?: string; wire_api?: string }>;
    mcp_servers?: Record<string, unknown>;
  };
  assert.equal(config.model_provider, "mirafold_local");
  assert.equal(config.model_providers?.mirafold_local.base_url, "http://127.0.0.1:11434/v1");
  assert.equal(config.model_providers?.mirafold_local.wire_api, "responses"); // docs Path B
  assert.ok(config.mcp_servers?.[MIRAFOLD_MCP], "the render MCP server must survive the merge");
});

test("a config.toml-provider choice (kind local, NO endpoint) injects nothing — the config default wins", () => {
  let o!: CodexOptions;
  withOpenAiKey("sk-env", () => {
    o = capturedCodexOptions({ kind: "local" });
    // Same withholding posture as the discovered-endpoint branch: the key has
    // no business in a process pointed away from OpenAI.
    assert.ok(o.env);
    assert.ok(!("OPENAI_API_KEY" in o.env!));
    assert.equal(o.apiKey, undefined);
  });
  const config = o.config as {
    model_provider?: string;
    model_providers?: Record<string, unknown>;
    mcp_servers?: Record<string, unknown>;
  };
  // No override: Codex must resolve the user's own config.toml default
  // provider (faithful skin — inherit, not invent).
  assert.equal(config.model_provider, undefined);
  assert.equal(config.model_providers, undefined);
  assert.ok(config.mcp_servers?.[MIRAFOLD_MCP], "the render MCP server still rides along");
});

// ── Provider binding (2026-07-19): every pick forces the provider its label
// promised, so a config.toml custom default can't silently redirect a session
// the user was told runs elsewhere.

type CapturedConfig = {
  model_provider?: string;
  model_providers?: Record<string, unknown>;
  mcp_servers?: Record<string, unknown>;
};

test("provider binding: a named config-provider pick forces that id, declaration inherited", () => {
  let o!: CodexOptions;
  withOpenAiKey("sk-env", () => {
    o = capturedCodexOptions({ kind: "local", provider: "openrouter" });
    assert.ok(o.env);
    assert.ok(!("OPENAI_API_KEY" in o.env!));
    assert.equal(o.apiKey, undefined);
  });
  const config = o.config as CapturedConfig;
  assert.equal(config.model_provider, "openrouter");
  // The provider's DEFINITION (base_url, env_key, wire_api) stays the user's
  // own [model_providers.openrouter] table — nothing injected over it.
  assert.equal(config.model_providers, undefined);
  assert.ok(config.mcp_servers?.[MIRAFOLD_MCP]);
});

test("provider binding: api-key and subscription picks force the first-party provider", () => {
  withOpenAiKey("sk-env", () => {
    const apiKey = capturedCodexOptions({ kind: "api-key" }).config as CapturedConfig;
    assert.equal(apiKey.model_provider, "openai");
    const sub = capturedCodexOptions({ kind: "subscription" }).config as CapturedConfig;
    assert.equal(sub.model_provider, "openai");
  });
});

test("provider binding: NO explicit pick still injects no provider — inherit stays inherit", () => {
  withOpenAiKey(undefined, () => {
    const config = capturedCodexOptions({}).config as CapturedConfig;
    assert.equal(config.model_provider, undefined);
  });
});

// ── Provider binding, model axis: a forced-openai pick must not inherit a
// config.toml `model` chosen for a CUSTOM default provider — the first engine
// turn swaps in the ENGINE's own catalog default instead.

const FOREIGN_MODEL_TOML =
  'model = "qwen/qwen3-coder"\nmodel_provider = "openrouter"\n' +
  '[model_providers.openrouter]\nbase_url = "https://openrouter.ai/api/v1"\n';

/** makeModelSession, plus a CODEX_HOME fixture (read at construction only)
 *  and the engine-catalog seam. */
function makeBindingSession(configToml: string | undefined, opts: {
  kind?: "api-key" | "subscription";
  model?: string;
  listEngineModels?: () => Promise<any[]>;
}) {
  const home = mkdtempSync(path.join(tmp, "codex-home-"));
  if (configToml !== undefined) writeFileSync(path.join(home, "config.toml"), configToml);
  const { calls, prompts, makeCodex } = recordingCodex();
  // CODEX_HOME only matters at construction (the config scan runs there).
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  let s: CodexSession;
  try {
    s = new CodexSession({ workspaceDir: tmp, ...opts, makeCodex });
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  return { s, msgs, calls, prompts, awaitTurnEnd: (count = 1) => waitForTurnEnds(msgs, count) };
}

// The model axis runs for BOTH first-party kinds. They aren't two code paths:
// providerBinding forces `openai` from a single `api-key || subscription`
// branch, and firstPartyOpenAI derives from that — so a regression would hit
// both at once. Parameterized anyway (2026-07-20) because the api-key path is
// the one that can't be exercised live without buying a key, which makes this
// the only thing pinning it.
for (const kind of ["subscription", "api-key"] as const) {
  test(`model axis (${kind}): the engine's catalog default replaces the foreign config model on the first turn`, async () => {
    const { s, calls, prompts, awaitTurnEnd } = makeBindingSession(FOREIGN_MODEL_TOML, {
      kind,
      listEngineModels: async () => CATALOG,
    });
    s.pushPrompt("hi");
    await awaitTurnEnd();
    // Constructor start (no model), then the pre-turn restart under the default.
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.model, undefined);
    assert.deepEqual([calls[1].kind, calls[1].options.model], ["start", "gpt-9-sol"]);
    assert.equal(s.modelName, "gpt-9-sol");
    assert.equal(prompts.length, 1); // the turn still ran, once, after the swap
    s.close();
  });

  test(`model axis (${kind}): a provider-foreign default is refused, never sent to a first-party account`, async () => {
    // The 2026-07-20 bug, live: the catalog answered `meituan/longcat-2.0` —
    // row 1 of OpenRouter's list, reached because the binary shares one
    // models_cache.json across providers — and a ChatGPT account 400s on it.
    // A `vendor/model` slug can never be first-party OpenAI, so it stops here.
    const { s, msgs, prompts, awaitTurnEnd } = makeBindingSession(FOREIGN_MODEL_TOML, {
      kind,
      listEngineModels: async () => [
        { id: "meituan/longcat-2.0", displayName: "LongCat", description: "", isDefault: true },
      ],
    });
    s.pushPrompt("hi");
    await awaitTurnEnd();
    const err = msgs.find((m) => m.type === "error")!.message;
    assert.match(err, /meituan\/longcat-2\.0/);
    assert.match(err, /can't run/);
    assert.equal(prompts.length, 0, "the foreign model must never reach the engine");
    s.close();
  });

  test(`model axis (${kind}): catalog failure = honest error, the foreign model never reaches the engine`, async () => {
    const { s, msgs, prompts, awaitTurnEnd } = makeBindingSession(FOREIGN_MODEL_TOML, {
      kind,
      listEngineModels: async () => {
        throw new Error("engine catalog exploded");
      },
    });
    s.pushPrompt("hi");
    await awaitTurnEnd();
    assert.match(
      msgs.find((m) => m.type === "error")!.message,
      /default model could not be resolved/,
    );
    assert.equal(prompts.length, 0);
    s.close();
  });

  test(`model axis (${kind}): a transient catalog failure is retried before the next prompt`, async () => {
    let lookups = 0;
    const { s, msgs, prompts, awaitTurnEnd } = makeBindingSession(FOREIGN_MODEL_TOML, {
      kind,
      listEngineModels: async () => {
        lookups += 1;
        if (lookups === 1) throw new Error("temporary catalog failure");
        return CATALOG;
      },
    });

    s.pushPrompt("first");
    await awaitTurnEnd(1);
    assert.equal(lookups, 1);
    assert.equal(prompts.length, 0, "the unresolved first-party model blocks the first prompt");
    assert.match(msgs.find((m) => m.type === "error")!.message, /default model could not be resolved/);

    s.pushPrompt("second");
    await awaitTurnEnd(2);
    assert.equal(lookups, 2, "the failed lookup did not disable the guard");
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].includes("## Generative UI"));
    assert.ok(prompts[0].includes("DEFERRED"));
    assert.ok(prompts[0].endsWith("second"));
    assert.equal(s.modelName, "gpt-9-sol");
    s.close();
  });

  test(`model axis (${kind}): a catalog with NO default row is a failure, never a guess`, async () => {
    // Observed live 2026-07-19: an unmarked catalog row ('thinkingmachines/
    // inkling') is exactly the kind of thing a row-0 guess would run.
    const { s, msgs, prompts, awaitTurnEnd } = makeBindingSession(FOREIGN_MODEL_TOML, {
      kind,
      listEngineModels: async () => CATALOG.map((m) => ({ ...m, isDefault: false })),
    });
    s.pushPrompt("hi");
    await awaitTurnEnd();
    assert.match(msgs.find((m) => m.type === "error")!.message, /marks no default model/);
    assert.equal(prompts.length, 0);
    s.close();
  });
}

test("model axis: an explicit model (construction or /model) wins — no resolution", async () => {
  const viaOpts = makeBindingSession(FOREIGN_MODEL_TOML, {
    kind: "subscription",
    model: "gpt-9-luna",
    listEngineModels: async () => {
      throw new Error("must not be asked");
    },
  });
  viaOpts.s.pushPrompt("hi");
  await viaOpts.awaitTurnEnd();
  assert.equal(viaOpts.prompts.length, 1);
  assert.equal(viaOpts.s.modelName, "gpt-9-luna");
  viaOpts.s.close();

  const viaSwitch = makeBindingSession(FOREIGN_MODEL_TOML, {
    kind: "subscription",
    listEngineModels: async () => {
      throw new Error("must not be asked");
    },
  });
  viaSwitch.s.pushPrompt("/model gpt-9-terra");
  viaSwitch.s.pushPrompt("hi");
  await viaSwitch.awaitTurnEnd(2);
  assert.equal(viaSwitch.prompts.length, 1);
  assert.equal(viaSwitch.s.modelName, "gpt-9-terra");
  viaSwitch.s.close();
});

test("model axis: no foreign model (or no custom default) = no swap at all", async () => {
  for (const toml of [
    // custom default, but no top-level model — the engine default applies naturally
    'model_provider = "openrouter"\n[model_providers.openrouter]\n',
    // top-level model, but the default provider IS openai — the model is native
    'model = "gpt-9-terra"\n',
    undefined, // no config at all
  ]) {
    const { s, calls, prompts, awaitTurnEnd } = makeBindingSession(toml, {
      kind: "subscription",
      listEngineModels: async () => {
        throw new Error("must not be asked");
      },
    });
    s.pushPrompt("hi");
    await awaitTurnEnd();
    assert.equal(calls.length, 1, `no restart for config: ${String(toml)}`);
    assert.equal(prompts.length, 1);
    s.close();
  }
});

test("2026-07-29 a failed first turn does not burn the render guidance — the retry still carries it", async () => {
  // firstTurn used to flip BEFORE the engine accepted the prompt, so a
  // spawn failure on turn 1 lost RENDER_GUIDANCE forever and the session
  // never made a render call again (V.2: 0/9 without the addendum).
  const s = new CodexSession({ workspaceDir: tmp });
  const msgs: Any[] = [];
  const prompts: string[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  let call = 0;
  (s as unknown as { thread: unknown }).thread = {
    runStreamed: async (text: string) => {
      if (call++ === 0) throw new Error("codex binary missing");
      prompts.push(text);
      return {
        events: (async function* () {
          yield ev({
            type: "turn.completed",
            usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 },
          });
        })(),
      };
    },
  };
  s.pushPrompt("first ask");
  await waitForTurnEnds(msgs, 1);
  assert.ok(msgs.some((m) => m.type === "error"), "the failure itself surfaced");
  s.pushPrompt("second ask");
  await waitForTurnEnds(msgs, 2);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes("## Generative UI"), "guidance survives the failed delivery");
  assert.ok(prompts[0].includes("DEFERRED"));
  assert.ok(prompts[0].endsWith("second ask"));
  s.close();
});
