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
function makeSession(...turns: Turn[]) {
  const s = new CodexSession({ workspaceDir: tmp });
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
function makeModelSession(listModels: () => Promise<any[]>) {
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
  const s = new CodexSession({
    workspaceDir: tmp,
    listModels,
    makeCodex: () =>
      ({
        startThread: (options: any) => {
          calls.push({ kind: "start", options });
          return fakeThread();
        },
        resumeThread: (id: string, options: any) => {
          calls.push({ kind: "resume", id, options });
          return fakeThread();
        },
      }) as any,
  });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  const awaitTurnEnd = (count = 1) => waitForTurnEnds(msgs, count);
  return { s, msgs, calls, prompts, awaitTurnEnd };
}

const CATALOG = [
  { id: "gpt-9-sol", displayName: "GPT-9-Sol", description: "frontier", isDefault: true },
  { id: "gpt-9-terra", displayName: "GPT-9-Terra", description: "balanced", isDefault: false },
  { id: "gpt-9-luna", displayName: "GPT-9-Luna", description: "fast", isDefault: false },
];

test("bare /model paints the picker from codex's own catalog; no engine turn runs (V.2)", async () => {
  const { s, msgs, prompts, awaitTurnEnd } = makeModelSession(async () => CATALOG);
  s.pushPrompt("/model");
  await awaitTurnEnd();

  const q = msgs.find((m) => m.type === "render" && m.component === "question")!;
  assert.ok(q, "picker question rendered");
  const opts = (q.props as any).options;
  assert.deepEqual(
    opts.map((o: any) => o.text),
    ["/model gpt-9-sol", "/model gpt-9-terra", "/model gpt-9-luna"],
  );
  // Default is current while the label is still the stand-in.
  assert.equal(opts[0].label, "GPT-9-Sol (current)");
  assert.equal(opts[1].label, "GPT-9-Terra");
  assert.equal(opts[0].detail, "frontier");
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

test("thread.started triggers the lookup: modelName goes from the stand-in to the truth", async () => {
  const home = rolloutFixture("t-3", [META_LINE, CONTEXT_LINE]);
  const { s, awaitTurnEnd } = makeSession(lookupTurn("t-3"));
  (s as unknown as { codexHome: string }).codexHome = home;
  assert.equal(s.modelName, "codex"); // the stand-in, pre-turn
  s.pushPrompt("go");
  await awaitTurnEnd();
  // The lookup is async beside the turn — give its first attempt a beat.
  const t0 = Date.now();
  while (s.modelName === "codex" && Date.now() - t0 < 3_000)
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

function withOpenAiKey(value: string | undefined, fn: () => void) {
  const saved = process.env.OPENAI_API_KEY;
  try {
    if (value === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = value;
    fn();
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
}

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
