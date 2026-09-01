import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import type { WireMsg } from "../protocol";
import { CODEX_DEVELOPER_INSTRUCTIONS, CodexSession, describePermissionProfile } from "./codex";
import { describePatchChange, normalizePatchChanges } from "./codex-patch";
import { waitFor as waitForCond } from "../testing/wait-for";
import type { AppServerClient, AppServerSpawn, JsonRpcId } from "./codex-app-server";
import { MIRAFOLD_MCP } from "./render-mcp-cmd";
import { MIRAFOLD_CONTEXT } from "../render-tools";
import { OUTPUT_CAP_BYTES } from "./types";
import { STREAM_CAP_MARKER } from "./codex-events";

// The Codex app-server notification→WireMsg mapping and the turn grammar, on
// a scripted in-memory app-server — no engine, no network. The session is
// real; only the transport (`makeAppServer`) is swapped for a fake that
// answers the protocol's requests and plays scripted notifications per turn,
// so the whole worker → runTurn → mapper path runs as shipped.

type Any = WireMsg & Record<string, any>;
type Notification = [method: string, params: Record<string, unknown>];
type TurnCtx = {
  threadId: string;
  turnId: string;
  notify: (method: string, params: Record<string, unknown>) => void;
  /** Ask the session something the way the engine does; resolves with its answer. */
  serverRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Resolves when the session sends turn/interrupt for this turn. */
  interrupted: Promise<void>;
  complete: (status?: string, error?: unknown) => void;
};
type Scripted = Notification[] | ((ctx: TurnCtx) => Promise<void>);
type SessionOpts = Omit<ConstructorParameters<typeof CodexSession>[0], "workspaceDir">;

const tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-codex-test-"));
// Every session below lives under `tmp`; trusting that root once means the
// folder-trust gate (CA.3) never asks in these tests — the dedicated trust
// tests use their own untrusted workspaces.
const trustRecord = path.join(tmp, "trusted-workspaces.json");
writeFileSync(
  trustRecord,
  JSON.stringify({ version: 2, scopes: { "gemini-cli": [], codex: [tmp] } }),
);
process.env.MIRAFOLD_WORKSPACE_TRUST_FILE = trustRecord;
// Never the developer's real ~/.codex: every session in this file reads its
// config from an empty, isolated CODEX_HOME (test-audit 2026-08-26). Tests
// that need their own home set it explicitly and restore this one.
process.env.CODEX_HOME = path.join(tmp, "codex-home");
mkdirSync(process.env.CODEX_HOME, { recursive: true });

/** Wait until `pred` matches a message, and return it — named, with the
 *  seen-type list on a timeout (test-audit 2026-08-26: the old local helper
 *  failed with a bare "waitFor timed out"). */
const waitFor = async (msgs: Any[], pred: (m: Any) => boolean, what = "a matching message", timeoutMs = 5_000): Promise<Any> => {
  await waitForCond(() => msgs.some(pred), what, timeoutMs, () => `seen: ${msgs.map((m) => m.type).join(",")}`);
  return msgs.find(pred)!;
};

/** Answer the Nth permission ask as it appears; returns the request row. */
async function answerAsk(s: CodexSession, msgs: Any[], n: number, allow: boolean): Promise<Any> {
  const req = await waitFor(msgs, (m) => m.type === "permission_request" && msgs.filter((x) => x.type === "permission_request").indexOf(m) === n - 1);
  s.resolvePermission(req.id, allow);
  return req;
}

const DONE: Notification = ["turn/completed", { turn: { status: "completed" } }];
const usage = (inputTokens: number, outputTokens: number, reasoningOutputTokens = 0): Notification => [
  "thread/tokenUsage/updated",
  { tokenUsage: { total: { inputTokens, outputTokens, reasoningOutputTokens, cachedInputTokens: 0, totalTokens: inputTokens + outputTokens }, last: {} } },
];

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

/** An in-memory `codex app-server`: answers initialize / thread/start /
 *  thread/resume / turn/start / turn/interrupt, records every request, and
 *  plays one scripted turn per turn/start. `exit()` simulates the process
 *  dying. */
function fakeAppServer(opts: {
  threadId?: string;
  model?: string;
  startError?: Error;
  threadStartGate?: Promise<void>;
  turnStartGate?: Promise<void>;
  omitTurnId?: boolean | "once";
  interruptCompletes?: boolean;
} = {}) {
  const requests: { method: string; params: any }[] = [];
  const specs: AppServerSpawn[] = [];
  const turns: Scripted[] = [];
  type FakeClient = AppServerClient & { exit: () => void };
  const clients: FakeClient[] = [];
  let turnSeq = 0;
  let turnIdOmitted = false;

  function makeClient(spec: AppServerSpawn): FakeClient {
    specs.push(spec);
    const notificationListeners = new Set<(method: string, params: unknown) => void>();
    const serverRequestListeners = new Set<(id: JsonRpcId, method: string, params: unknown) => void>();
    const exitListeners = new Set<(exit: { code: number | null; signal: NodeJS.Signals | null }) => void>();
    const pendingServer = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let serverReqId = 0;
    let exited = false;
    let threadId = opts.threadId ?? "codex-thread-new";
    let interruptResolve: (() => void) | undefined;
    let activeTurn: string | undefined;
    const notify = (method: string, params: Record<string, unknown>) => {
      if (exited) return;
      for (const cb of notificationListeners) cb(method, params);
    };
    const complete = (turnId: string, status = "completed", error?: unknown) => {
      if (activeTurn !== turnId) return;
      activeTurn = undefined;
      notify("turn/completed", { threadId, turn: { id: turnId, status, ...(error !== undefined ? { error } : {}) } });
    };
    const play = async (turnId: string) => {
      if (exited) return;
      const script = turns.shift() ?? [];
      const fill = (params: Record<string, unknown>) => ({ threadId, turnId, ...params });
      if (typeof script === "function") {
        await script({
          threadId,
          turnId,
          notify: (method, params) => notify(method, fill(params)),
          serverRequest: (method, params) =>
            new Promise((resolve, reject) => {
              const id = `srv-${++serverReqId}`;
              pendingServer.set(id, { resolve, reject });
              for (const cb of serverRequestListeners) cb(id, method, fill(params));
            }),
          interrupted: new Promise<void>((r) => (interruptResolve = r)),
          complete: (status, error) => complete(turnId, status, error),
        });
        return;
      }
      for (const [method, params] of script) {
        if (method === "turn/completed") {
          const turn = (params["turn"] ?? {}) as { status?: string; error?: unknown };
          complete(turnId, turn.status, turn.error);
        } else {
          notify(method, fill(params));
        }
      }
    };
    const client: FakeClient = {
      async request(method: string, params?: any) {
        requests.push({ method, params });
        if (exited) throw new Error(`codex app-server exited before answering ${method}`);
        switch (method) {
          case "initialize":
            if (opts.startError) throw opts.startError;
            return {} as any;
          case "thread/start":
            await opts.threadStartGate;
            return { thread: { id: threadId }, model: opts.model ?? "gpt-test" } as any;
          case "thread/resume":
            threadId = params.threadId;
            return { thread: { id: threadId }, model: opts.model ?? "gpt-test" } as any;
          case "turn/start": {
            const turnId = `turn-${++turnSeq}`;
            activeTurn = turnId;
            await opts.turnStartGate;
            setTimeout(() => void play(turnId), 0);
            const omitTurnId =
              opts.omitTurnId === true || (opts.omitTurnId === "once" && !turnIdOmitted);
            turnIdOmitted ||= omitTurnId;
            return { turn: omitTurnId ? {} : { id: turnId } } as any;
          }
          case "turn/interrupt": {
            interruptResolve?.();
            if (opts.interruptCompletes !== false) {
              setTimeout(() => complete(params.turnId, "interrupted"), 0);
            }
            return {} as any;
          }
          default:
            return {} as any;
        }
      },
      notify(method, params) {
        requests.push({ method, params });
      },
      respond(id, result) {
        pendingServer.get(id)?.resolve(result);
        pendingServer.delete(id);
      },
      respondError(id, code, message) {
        pendingServer.get(id)?.reject(new Error(`${code}: ${message}`));
        pendingServer.delete(id);
      },
      onNotification(cb) {
        notificationListeners.add(cb);
      },
      onServerRequest(cb) {
        serverRequestListeners.add(cb);
      },
      onExit(cb) {
        exitListeners.add(cb);
      },
      get exited() {
        return exited;
      },
      stderrTail: "",
      kill() {
        client.exit();
      },
      exit() {
        if (exited) return;
        exited = true;
        for (const cb of exitListeners) cb({ code: 1, signal: null });
      },
    };
    clients.push(client);
    return client;
  }

  return {
    requests,
    specs,
    turns,
    clients,
    makeAppServer: (spec: AppServerSpawn) => makeClient(spec),
    /** The prompt text of every turn the engine was asked to run. */
    prompts: () => requests.filter((r) => r.method === "turn/start").map((r) => r.params.input[0].text as string),
    turnStarts: () => requests.filter((r) => r.method === "turn/start").map((r) => r.params),
    threadStarts: () => requests.filter((r) => r.method === "thread/start" || r.method === "thread/resume"),
  };
}

function makeSessionWithOptions(opts: SessionOpts, ...turns: Scripted[]) {
  const server = fakeAppServer();
  server.turns.push(...turns);
  const s = new CodexSession({ workspaceDir: tmp, ...opts, makeAppServer: server.makeAppServer });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  const turnEnds = () => msgs.filter((m) => m.type === "turn_end").length;
  const awaitTurnEnd = (count = 1) => waitForTurnEnds(msgs, count);
  return { s, msgs, server, prompts: server.prompts, turnEnds, awaitTurnEnd };
}

function makeSession(...turns: Scripted[]) {
  return makeSessionWithOptions({}, ...turns);
}

const HAPPY: Notification[] = [
  ["turn/started", {}],
  ["item/started", { item: { type: "reasoning", id: "th1" } }],
  ["item/reasoning/summaryTextDelta", { itemId: "th1", delta: "pondering", summaryIndex: 0 }],
  ["item/completed", { item: { type: "reasoning", id: "th1", summary: ["pondering"] } }],
  ["item/started", { item: { type: "agentMessage", id: "m1", text: "" } }],
  ["item/agentMessage/delta", { itemId: "m1", delta: "the " }],
  ["item/agentMessage/delta", { itemId: "m1", delta: "reply" }],
  ["item/completed", { item: { type: "agentMessage", id: "m1", text: "the reply" } }],
  ["item/started", { item: { type: "commandExecution", id: "c1", command: "ls -la", status: "inProgress" } }],
  ["item/commandExecution/outputDelta", { itemId: "c1", delta: "file.txt" }],
  [
    "item/completed",
    { item: { type: "commandExecution", id: "c1", command: "ls -la", aggregatedOutput: "file.txt", exitCode: 0, status: "completed" } },
  ],
  // The REAL wire shape (captured from app-server 2026-08-30): `kind` is an
  // object, `diff` a unified diff, paths absolute.
  [
    "item/completed",
    {
      item: {
        type: "fileChange",
        id: "f1",
        status: "completed",
        changes: [{ path: `${tmp}/src/a.ts`, kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-alpha\n+beta\n" }],
      },
    },
  ],
  ["item/started", { item: { type: "mcpToolCall", id: "mc1", server: "docs", tool: "search", arguments: { q: "x" }, status: "inProgress" } }],
  [
    "item/completed",
    { item: { type: "mcpToolCall", id: "mc1", server: "docs", tool: "search", arguments: { q: "x" }, status: "completed", result: { content: [{ type: "text", text: "3 hits" }] } } },
  ],
  ["item/completed", { item: { type: "webSearch", id: "w1", query: "codex sdk" } }],
  usage(100, 10, 5),
  DONE,
];

test("happy stream: full notification→WireMsg mapping, exactly one turn_end", async () => {
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession(HAPPY);
  s.pushPrompt("go");
  await awaitTurnEnd();

  assert.ok(msgs.every((m) => m.seq === undefined)); // seq is the registry's, never the adapter's
  assert.ok(msgs.some((m) => m.type === "thinking_delta" && m.text === "pondering"));
  // Prose streams as deltas, and the completed text adds nothing twice.
  assert.deepEqual(msgs.filter((m) => m.type === "text_delta").map((m) => m.text), ["the ", "reply"]);

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
  const results = msgs.filter((m) => m.type === "tool_result");
  assert.deepEqual(results.map((r) => r.id), ["c1", "f1", "mc1", "w1"]);
  assert.equal(results[0].output, "file.txt");
  assert.equal(results[1].output, "Updated src/a.ts");
  // The row's input carries the normalized change so the browser draws the
  // patch: workspace-relative path, kind as a plain string, the diff intact.
  const patchRow = msgs.find((m) => m.type === "tool_use" && m.name === "apply_patch")!;
  assert.equal(patchRow.detail, "Updated src/a.ts");
  assert.deepEqual(patchRow.input, {
    changes: [{ path: "src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-alpha\n+beta\n" }],
  });
  assert.equal(results[2].output, "3 hits");
  assert.equal(uses[0].detail, "ls -la");
  assert.deepEqual(uses[0].input, { command: "ls -la" });

  const u = msgs.find((m) => m.type === "usage")!;
  assert.deepEqual([u.inputTokens, u.outputTokens], [100, 15]); // reasoning counts as output
  assert.equal(u.model, "gpt-test"); // the engine named its model at thread/start
  assert.equal(turnEnds(), 1);
  assert.equal(msgs.at(-1)!.type, "turn_end");
  s.close();
});

test("review 2026-08-29: a resumed thread's first turn reports only its own tokens", async () => {
  // After a daemon restart the mapper is new but `total` is the thread's
  // cumulative count (the rollout persists it) — the whole pre-restart
  // history, which the registry has already restored from its checkpoint.
  // The event's per-response `last` is the turn's own figure; it sums across
  // the turn's responses.
  const resumed = (total: [number, number, number], last: [number, number, number]): Notification => [
    "thread/tokenUsage/updated",
    {
      tokenUsage: {
        total: { inputTokens: total[0], outputTokens: total[1], reasoningOutputTokens: total[2] },
        last: { inputTokens: last[0], outputTokens: last[1], reasoningOutputTokens: last[2] },
      },
    },
  ];
  const { s, msgs, awaitTurnEnd } = makeSession(
    [resumed([900_100, 40_010, 5_005], [100, 10, 5]), resumed([900_300, 40_040, 5_015], [200, 30, 10]), DONE],
    [resumed([900_350, 40_045, 5_016], [50, 5, 1]), DONE],
  );
  s.pushPrompt("one");
  await awaitTurnEnd(1);
  s.pushPrompt("two");
  await awaitTurnEnd(2);
  assert.deepEqual(
    msgs.filter((m) => m.type === "usage").map((m) => [m.inputTokens, m.outputTokens]),
    [
      [300, 55],
      [50, 6],
    ],
  );
  s.close();
});

test("usage is per turn: the second turn reports only its own tokens", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession([usage(100, 10), DONE], [usage(160, 25, 5), DONE]);
  s.pushPrompt("one");
  await awaitTurnEnd(1);
  s.pushPrompt("two");
  await awaitTurnEnd(2);
  assert.deepEqual(
    msgs.filter((m) => m.type === "usage").map((m) => [m.inputTokens, m.outputTokens]),
    [
      [100, 10],
      [60, 20],
    ],
  );
  s.close();
});

test("the render guidance rides thread/start as developerInstructions; turns carry the bare prompt (V.2)", async () => {
  const { s, server, prompts, awaitTurnEnd } = makeSession([DONE], [DONE]);
  s.pushPrompt("first ask");
  await awaitTurnEnd(1);
  s.pushPrompt("second ask");
  await awaitTurnEnd(2);

  const starts = server.threadStarts();
  assert.equal(starts.length, 1, "one thread for the session's life");
  assert.equal(starts[0].method, "thread/start");
  const instructions = starts[0].params.developerInstructions as string;
  assert.equal(instructions, CODEX_DEVELOPER_INSTRUCTIONS);
  assert.ok(instructions.includes("## Generative UI"));
  assert.ok(instructions.includes(MIRAFOLD_CONTEXT), "the environment fact reaches Codex at thread start");
  // The where-are-the-tools note leads, and it names every path Codex can
  // hide an MCP tool behind: tool_search deferral and the exec runtime.
  assert.ok(instructions.trimStart().startsWith("## Mirafold's render tools"));
  assert.ok(instructions.indexOf("## Mirafold's render tools") < instructions.indexOf("## Generative UI"));
  assert.ok(instructions.includes("DEFERRED"));
  assert.ok(instructions.includes("tool_search"));
  assert.ok(instructions.includes("tools.mcp__mirafold__render_table("));
  assert.ok(instructions.includes("ALL_TOOLS"));
  assert.equal(starts[0].params.cwd, tmp);
  // Faithful skin: no sandbox / approval policy of our own.
  assert.equal(starts[0].params.sandbox, undefined);
  assert.equal(starts[0].params.approvalPolicy, undefined);
  assert.deepEqual(prompts(), ["first ask", "second ask"]);
  s.close();
});

test("agentMessage with a mermaid xychart paints a chart component; prose stays text (V.2)", async () => {
  const fence =
    "Here you go:\n\n```mermaid\nxychart-beta\n  title \"Revenue\"\n  x-axis [Jan, Feb]\n  y-axis \"USD\" 0 --> 20\n  bar [10, 15]\n```\n\nDone.";
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["item/completed", { item: { type: "agentMessage", id: "m1", text: fence } }],
    DONE,
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

test("streamed prose flows live until a fence opens; the held remainder is converted on completion", async () => {
  const fence = "```mermaid\nxychart-beta\n  x-axis [A]\n  y-axis \"n\" 0 --> 2\n  bar [1]\n```";
  const full = `Intro. ${fence}\nOutro.`;
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["item/agentMessage/delta", { itemId: "m1", delta: "Intro. " }],
    ["item/agentMessage/delta", { itemId: "m1", delta: "```mermaid\nxychart-beta\n" }],
    ["item/agentMessage/delta", { itemId: "m1", delta: "  x-axis [A]\n  y-axis \"n\" 0 --> 2\n  bar [1]\n```\nOutro." }],
    ["item/completed", { item: { type: "agentMessage", id: "m1", text: full } }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const texts = msgs.filter((m) => m.type === "text_delta").map((m) => m.text);
  assert.equal(texts[0], "Intro. ", "prose before the fence streamed immediately");
  assert.ok(texts.every((t) => !t.includes("xychart")), "the fence never reached the transcript as text");
  assert.ok(texts.some((t) => t.includes("Outro.")));
  assert.equal(msgs.filter((m) => m.type === "render" && m.component === "chart").length, 1);
  s.close();
});

test("a Mermaid opener split across prose deltas is held and converted", async () => {
  const fence = "```mermaid\nxychart-beta\n  x-axis [A]\n  y-axis \"n\" 0 --> 2\n  bar [1]\n```";
  const full = `Intro. ${fence}\nOutro.`;
  for (const openerSplit of [1, 2]) {
    const { s, msgs, awaitTurnEnd } = makeSession([
      [
        "item/agentMessage/delta",
        { itemId: "m1", delta: `Intro. ${"```".slice(0, openerSplit)}` },
      ],
      [
        "item/agentMessage/delta",
        { itemId: "m1", delta: `${"```".slice(openerSplit)}mermaid\nxychart-beta\n` },
      ],
      [
        "item/agentMessage/delta",
        { itemId: "m1", delta: "  x-axis [A]\n  y-axis \"n\" 0 --> 2\n  bar [1]\n```\nOutro." },
      ],
      ["item/completed", { item: { type: "agentMessage", id: "m1", text: full } }],
      DONE,
    ]);
    s.pushPrompt("go");
    await awaitTurnEnd();

    const texts = msgs.filter((m) => m.type === "text_delta").map((m) => m.text);
    assert.equal(texts[0], "Intro. ");
    assert.ok(texts.every((text) => !text.includes("xychart")));
    assert.ok(texts.some((text) => text.includes("Outro.")));
    assert.equal(msgs.filter((m) => m.type === "render" && m.component === "chart").length, 1);
    s.close();
  }
});

test("recovery and discovery: Codex resumes its thread and advertises only implemented / commands plus live $ skills", async () => {
  const server = fakeAppServer();
  server.turns.push([DONE]);
  const s = new CodexSession({
    workspaceDir: tmp,
    resumeId: "codex-thread-saved",
    makeAppServer: server.makeAppServer,
    listSkills: async () => [{ name: "audit", description: "defensive security audit" }],
  });
  assert.equal(s.resumeId, "codex-thread-saved");
  assert.equal(server.specs.length, 0, "nothing spawns until a turn needs the engine");

  const seen: WireMsg[] = [];
  s.onMessage((msg) => seen.push(msg));
  s.refreshPromptOptions();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const catalogs = seen.filter((msg) => msg.type === "prompt_options");
  const latest = catalogs.at(-1);
  assert.ok(latest?.type === "prompt_options");
  assert.deepEqual(
    latest.options.filter((option) => option.trigger === "/").map((option) => option.value),
    ["/model", "/effort"],
    "TUI-only commands must never be advertised then sent to the model as prose",
  );
  assert.equal(
    latest.options.find((option) => option.value === "$audit")?.source,
    "codex",
    "workspace/provider skill text must carry fixed catalog provenance",
  );

  s.pushPrompt("continue");
  await waitForTurnEnds(seen as Any[]);
  const starts = server.threadStarts();
  assert.deepEqual([starts[0].method, starts[0].params.threadId, starts[0].params.cwd], ["thread/resume", "codex-thread-saved", tmp]);
  s.close();
});

test("Codex announces its provider resume id when the thread starts", async () => {
  const { s, awaitTurnEnd } = makeSession([DONE]);
  const resumeIds: string[] = [];
  s.onResumeId((id) => resumeIds.push(id));
  s.pushPrompt("start the thread");
  await awaitTurnEnd();
  assert.deepEqual(resumeIds, ["codex-thread-new"]);
  assert.equal(s.resumeId, "codex-thread-new");
  s.close();
});

test("the engine's resolved model becomes the label; a configured model is never overridden", async () => {
  const unconfigured = makeSession([DONE]);
  assert.equal(unconfigured.s.modelName, undefined, "unknown is reported as absent, never a stand-in");
  unconfigured.s.pushPrompt("go");
  await unconfigured.awaitTurnEnd();
  assert.equal(unconfigured.s.modelName, "gpt-test");
  unconfigured.s.close();

  const configured = makeSessionWithOptions({ model: "o3-configured" }, [DONE]);
  configured.s.pushPrompt("go");
  await configured.awaitTurnEnd();
  assert.equal(configured.s.modelName, "o3-configured");
  assert.equal(configured.server.threadStarts()[0].params.model, "o3-configured");
  configured.s.close();
});

const CATALOG = [
  { id: "gpt-9-sol", displayName: "GPT-9-Sol", description: "frontier", isDefault: true },
  { id: "gpt-9-terra", displayName: "GPT-9-Terra", description: "balanced", isDefault: false },
  { id: "gpt-9-luna", displayName: "GPT-9-Luna", description: "fast", isDefault: false },
];

function makeModelSession(listModels: () => Promise<any[]>, opts: SessionOpts = {}, ...turns: Scripted[]) {
  return makeSessionWithOptions({ ...opts, listModels }, ...turns);
}

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
  assert.equal(prompts().length, 0); // never reached the engine
  s.close();
});

test("/model <id> applies from the next turn on the same warm thread — no restart (V.2)", async () => {
  const { s, msgs, server, awaitTurnEnd } = makeModelSession(async () => CATALOG, {}, [DONE], [DONE]);
  s.pushPrompt("/model gpt-9-terra");
  await awaitTurnEnd();
  assert.equal(s.modelName, "gpt-9-terra");
  assert.ok(msgs.some((m) => m.type === "text_delta" && m.text.includes("gpt-9-terra")));
  assert.equal(server.specs.length, 0, "a switch alone spawns nothing");

  s.pushPrompt("hello");
  await awaitTurnEnd(2);
  assert.equal(server.threadStarts()[0].params.model, "gpt-9-terra");
  assert.equal(server.turnStarts()[0].model, "gpt-9-terra");

  // A later switch rides the next turn/start; the thread is never restarted.
  s.pushPrompt("/model gpt-9-luna");
  await awaitTurnEnd(3);
  s.pushPrompt("again");
  await awaitTurnEnd(4);
  assert.equal(server.turnStarts()[1].model, "gpt-9-luna");
  assert.equal(server.threadStarts().length, 1);
  assert.equal(server.clients.length, 1);
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

test("bare /effort paints the effort picker; no engine turn runs", async () => {
  const { s, msgs, prompts, awaitTurnEnd } = makeModelSession(async () => CATALOG);
  s.pushPrompt("/effort");
  await awaitTurnEnd();

  const p = msgs.find((m) => m.type === "picker")!;
  assert.ok(p, "effort picker rendered");
  assert.equal(p.title, "Select reasoning effort");
  const rows = p.rows as any[];
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
  assert.equal(prompts().length, 0); // never reached the engine
  s.close();
});

test("a discovered local /effort picker adds none and passes it to Codex", async () => {
  const { s, msgs, server, prompts, awaitTurnEnd } = makeModelSession(
    async () => CATALOG,
    { kind: "local", endpoint: "http://127.0.0.1:11434", localTurnTimeoutMs: 0 },
    [DONE],
  );

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
  assert.ok(msgs.some((m) => m.type === "text_delta" && m.text.includes("effort set to none")));
  assert.equal(prompts().length, 0, "the local slash command never becomes model prose");
  s.pushPrompt("hi");
  await awaitTurnEnd(3);
  assert.equal(server.turnStarts()[0].effort, "none");
  s.close();
});

test("/effort <level> applies from the next turn; a set effort reads back as current", async () => {
  const { s, msgs, server, awaitTurnEnd } = makeModelSession(async () => CATALOG, {}, [DONE]);
  s.pushPrompt("/effort high");
  await awaitTurnEnd();
  assert.ok(msgs.some((m) => m.type === "text_delta" && m.text.includes("effort set to high")));

  s.pushPrompt("/effort");
  await awaitTurnEnd(2);
  const p = msgs.filter((m) => m.type === "picker").at(-1)!;
  const hi = (p.rows as any[]).find((r) => r.label === "high")!;
  assert.equal(hi.current, true, "the set effort reads back as current");

  s.pushPrompt("/model gpt-9-luna");
  await awaitTurnEnd(3);
  s.pushPrompt("go");
  await awaitTurnEnd(4);
  const turn = server.turnStarts()[0];
  assert.deepEqual([turn.model, turn.effort], ["gpt-9-luna", "high"], "model and effort ride the turn together");
  s.close();
});

test("/effort <bad>: an unknown level gets a usage line, never reaches the engine", async () => {
  const { s, msgs, prompts, awaitTurnEnd } = makeModelSession(async () => CATALOG);
  s.pushPrompt("/effort turbo");
  await awaitTurnEnd();
  const line = msgs.find((m) => m.type === "text_delta" && m.text.includes("Usage:"))!;
  assert.ok(line, "usage line emitted");
  assert.ok(line.text.includes("minimal, low, medium, high, xhigh"), "lists the valid levels");
  assert.ok(!line.text.includes("none"), "non-local sessions do not advertise the extension");
  assert.equal(prompts().length, 0);
  s.close();
});

test("a command that RAN is never a red error, whatever its exit status — app-server marks any nonzero exit 'failed'", async () => {
  // The CA.2 regression: app-server reports a probe's nonzero exit as
  // status:"failed" (grep-no-match, a `gh repo view` on a missing repo),
  // where the old exec path said "completed". Both must read as ordinary
  // completed commands — non-error, foldable, exit code annotated — exactly
  // as the Codex TUI shows them. A completion without a start still
  // announces (ensureAnnounced).
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["item/completed", { item: { type: "commandExecution", id: "cA", command: "grep zzz f", aggregatedOutput: "", exitCode: 1, status: "failed" } }],
    ["item/completed", { item: { type: "commandExecution", id: "cB", command: "ls /nope", aggregatedOutput: "ls: cannot access", exitCode: 2, status: "failed" } }],
    ["item/completed", { item: { type: "commandExecution", id: "cC", command: "grep -r x src/", aggregatedOutput: "", exitCode: 1, status: "completed" } }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  assert.equal(msgs.filter((m) => m.type === "tool_use").length, 3, "each still announces once");
  const results = msgs.filter((m) => m.type === "tool_result");
  assert.ok(results.every((r) => r.isError !== true), "a command that ran is not a red error");
  assert.deepEqual(results.map((r) => r.output), ["(exit 1)", "ls: cannot access\n(exit 2)", "(exit 1)"]);
  s.close();
});

test("a command that could NOT run (failed with no exit code) is a real error, shown expanded", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["item/completed", { item: { type: "commandExecution", id: "c9", command: "no-such-binary", aggregatedOutput: "spawn error", status: "failed" } }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  assert.equal(msgs.find((m) => m.type === "tool_result" && m.id === "c9")!.isError, true);
  s.close();
});

test("the two mislabeled probes from the screenshot fold together instead of showing as expanded errors", async () => {
  // The exact shape of Kyle's 2026-08-25 screenshot: prose, then an rg probe
  // (no match → failed/exit 1) and a `gh repo view` (missing repo → failed),
  // then prose. Both ran, so both are non-error and fold into one run.
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["item/completed", { item: { type: "agentMessage", id: "m1", text: "The starting state is verified." } }],
    ["item/completed", { item: { type: "commandExecution", id: "rg", command: "rg --files --hidden", aggregatedOutput: "", exitCode: 1, status: "failed" } }],
    ["item/completed", { item: { type: "commandExecution", id: "gh", command: "gh repo view example/test-project", aggregatedOutput: "GraphQL: Could not resolve", exitCode: 1, status: "failed" } }],
    ["item/completed", { item: { type: "agentMessage", id: "m2", text: "The local project is now initialized." } }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const results = msgs.filter((m) => m.type === "tool_result");
  assert.ok(results.every((r) => r.isError !== true), "neither probe is a red error, so both are foldable");
  s.close();
});

test("a declined command (the user said no) is an error row that says so", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["item/started", { item: { type: "commandExecution", id: "c11", command: "rm -rf /x", status: "inProgress" } }],
    ["item/completed", { item: { type: "commandExecution", id: "c11", command: "rm -rf /x", aggregatedOutput: "", status: "declined" } }],
    ["item/completed", { item: { type: "fileChange", id: "f2", status: "declined", changes: [{ path: "/etc/x", kind: { type: "add" }, diff: "root:x\n" }] } }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const cmd = msgs.find((m) => m.type === "tool_result" && m.id === "c11")!;
  assert.deepEqual([cmd.isError, cmd.output], [true, "(declined)"]);
  const patch = msgs.find((m) => m.type === "tool_result" && m.id === "f2")!;
  assert.deepEqual([patch.isError, patch.output], [true, "(declined)"]);
  s.close();
});

test("mirafold MCP calls paint on success and fall back to honest rows on failure or an unknown tool", async () => {
  const mcp = (tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}): Notification => [
    "item/completed",
    {
      item: {
        type: "mcpToolCall",
        id: `g-${tool}`,
        server: MIRAFOLD_MCP,
        tool,
        arguments: args,
        status: "completed",
        result: { content: [], structuredContent: { renderId: "rid-1" } },
        ...extra,
      },
    },
  ];
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession([
    ["turn/started", {}],
    mcp("render_card", { title: "T", body: "b", id: "keep-me" }),
    mcp("emit_artifact", { html: "<b>x</b>", title: "demo" }),
    mcp("render_table", { columns: ["a"] }, { status: "failed" }),
    mcp("render_bogus", {}),
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();

  const render = msgs.find((m) => m.type === "render")!;
  assert.equal(render.component, "card");
  assert.deepEqual(render.props, { title: "T", body: "b" }); // id stripped from props
  assert.equal(render.id, "rid-1"); // structuredContent wins

  const art = msgs.find((m) => m.type === "artifact")!;
  assert.equal(art.html, "<b>x</b>");
  assert.equal(art.title, "demo");

  // The two successful calls are represented by their paintings only.
  assert.equal(msgs.filter((m) => m.type === "render" || m.type === "artifact").length, 2);
  // A failed or unknown call cannot disappear: each gets its ordinary MCP
  // row, while the successful render/artifact calls still get none.
  const uses = msgs.filter((m) => m.type === "tool_use");
  assert.deepEqual(uses.map((m) => [m.id, m.name]), [
    ["g-render_table", `${MIRAFOLD_MCP}.render_table`],
    ["g-render_bogus", `${MIRAFOLD_MCP}.render_bogus`],
  ]);
  const results = msgs.filter((m) => m.type === "tool_result");
  assert.deepEqual(results.map((m) => [m.id, m.isError]), [
    ["g-render_table", true],
    ["g-render_bogus", false],
  ]);
  assert.equal(turnEnds(), 1);
  s.close();
});

test("checklist (turn/plan/updated): one render id within a turn, a fresh one next turn", async () => {
  const plan = (status: string): Notification => ["turn/plan/updated", { plan: [{ step: "step", status }] }];
  const { s, msgs, awaitTurnEnd } = makeSession(
    [plan("pending"), plan("inProgress"), DONE],
    [plan("completed"), DONE],
  );
  s.pushPrompt("one");
  await awaitTurnEnd(1);
  s.pushPrompt("two");
  await awaitTurnEnd(2);
  const renders = msgs.filter((m) => m.type === "render" && m.component === "todo-list");
  assert.equal(renders.length, 3);
  assert.equal(renders[0].id, renders[1].id); // update-in-place within the turn
  assert.notEqual(renders[1].id, renders[2].id); // re-anchors next turn
  assert.deepEqual(renders[1].props, { todos: [{ content: "step", status: "in_progress" }] });
  s.close();
});

test("a failed turn: error before the single turn_end", async () => {
  const { s, msgs, turnEnds, awaitTurnEnd } = makeSession([
    ["turn/started", {}],
    ["turn/completed", { turn: { status: "failed", error: { message: "boom" } } }],
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const types = msgs.map((m) => m.type);
  assert.ok(types.indexOf("error") < types.indexOf("turn_end"));
  assert.equal(msgs.find((m) => m.type === "error")!.message, "boom");
  assert.equal(turnEnds(), 1);
  s.close();
});

test("a discovered local provider failure names the server/model recovery check", async () => {
  const { s, msgs, awaitTurnEnd } = makeSessionWithOptions(
    { kind: "local", endpoint: "http://127.0.0.1:11434", localTurnTimeoutMs: 0 },
    [
      ["turn/started", {}],
      ["turn/completed", { turn: { status: "failed", error: { message: "connection refused" } } }],
    ],
  );
  s.pushPrompt("go");
  await awaitTurnEnd();
  const error = msgs.find((m) => m.type === "error")!;
  assert.match(error.message, /^Local Codex could not complete the turn: connection refused/);
  assert.match(error.message, /server is running and still serves the selected model/);
  s.close();
});

/** A turn that runs until the session interrupts it (the fake completes it
 *  as "interrupted" then, exactly like the engine). */
const runsUntilInterrupted = async (ctx: TurnCtx) => {
  ctx.notify("turn/started", {});
  await ctx.interrupted;
};

test("a discovered local turn timeout interrupts with one actionable error and one turn_end", async () => {
  const { s, msgs, server, turnEnds, awaitTurnEnd } = makeSessionWithOptions(
    { kind: "local", endpoint: "http://127.0.0.1:11434", localTurnTimeoutMs: 25 },
    runsUntilInterrupted,
  );
  s.pushPrompt("go");
  await awaitTurnEnd();

  const errors = msgs.filter((m) => m.type === "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /local Codex turn did not finish/i);
  assert.match(errors[0].message, /\/effort none/);
  assert.match(errors[0].message, /MIRAFOLD_CODEX_LOCAL_TURN_TIMEOUT_MS/);
  assert.equal(turnEnds(), 1);
  assert.ok(server.requests.some((r) => r.method === "turn/interrupt"), "the timeout interrupts the engine's turn");
  s.close();
});

test("a local timeout does not recommend /effort none when reasoning is already disabled", async () => {
  const { s, msgs, awaitTurnEnd } = makeSessionWithOptions(
    { kind: "local", endpoint: "http://127.0.0.1:11434", localTurnTimeoutMs: 25 },
    runsUntilInterrupted,
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
    ['model_provider = "private"', "[model_providers.private]", `base_url = "${endpoint}"`].join("\n"),
  );
  const server = fakeAppServer();
  server.turns.push([
    ["turn/completed", { turn: { status: "failed", error: { message: `request ${endpoint}/responses failed` } } }],
  ]);
  const savedHome = process.env.CODEX_HOME;
  let s: CodexSession;
  try {
    process.env.CODEX_HOME = home;
    s = new CodexSession({ workspaceDir: tmp, kind: "local", provider: "private", makeAppServer: server.makeAppServer });
  } finally {
    if (savedHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = savedHome;
  }
  const msgs: Any[] = [];
  s.onMessage((msg) => msgs.push(msg as Any));
  s.pushPrompt("go");
  await waitForTurnEnds(msgs);
  const message = msgs.find((msg) => msg.type === "error")?.message ?? "";
  assert.equal(message, "request [selected endpoint]/responses failed");
  assert.doesNotMatch(message, /tenant|private|token-path/);
  s.close();
});

test("a retried engine error and a warning are attributed notices; the turn keeps going", async () => {
  // Codex's own advisories are its words, so they carry `source` — unbadged,
  // the dim system line is Mirafold's voice (2026-07-20 audit).
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["turn/started", {}],
    ["error", { error: { message: "stream disconnected" }, willRetry: true }],
    ["warning", { message: "Model metadata for `qwen3:1.7b` not found." }],
    ["item/completed", { item: { type: "agentMessage", id: "m1", text: "the reply" } }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const notices = msgs.filter((m) => m.type === "notice");
  assert.deepEqual(
    notices.map((n) => [n.kind, n.source]),
    [
      ["retry", "codex"],
      ["warning", "codex"],
    ],
  );
  assert.match(notices[0].text, /stream disconnected — retrying/);
  assert.match(notices[1].text, /Model metadata/);
  assert.ok(!msgs.some((m) => m.type === "error"), "a non-fatal advisory must not render as an error");
  const types = msgs.map((m) => m.type);
  assert.ok(types.indexOf("notice") < types.indexOf("text_delta"), "the advisory did not eat the turn");
  s.close();
});

test("app-server dies mid-turn: one error, one turn_end, and the next prompt respawns and RESUMES the thread", async () => {
  const { s, msgs, server, turnEnds, awaitTurnEnd } = makeSession(
    async (ctx) => {
      ctx.notify("turn/started", {});
      server.clients[0]!.exit();
    },
    [DONE],
  );
  s.pushPrompt("go");
  await awaitTurnEnd();
  assert.equal(msgs.filter((m) => m.type === "error").length, 1);
  assert.match(msgs.find((m) => m.type === "error")!.message, /exited/);
  assert.equal(turnEnds(), 1);

  s.pushPrompt("again");
  await awaitTurnEnd(2);
  assert.equal(server.clients.length, 2, "a fresh process for the next turn");
  const starts = server.threadStarts();
  assert.deepEqual(
    starts.map((r) => [r.method, r.params.threadId]),
    [
      ["thread/start", undefined],
      ["thread/resume", "codex-thread-new"],
    ],
    "the conversation survives the crash by id",
  );
  s.close();
});

test("interrupt: ends the turn silently — one turn_end, no error", async () => {
  const { s, msgs, server, turnEnds, awaitTurnEnd } = makeSession(runsUntilInterrupted);
  s.pushPrompt("go");
  await new Promise((r) => setTimeout(r, 50)); // let the turn start
  s.interrupt();
  await awaitTurnEnd();
  assert.equal(turnEnds(), 1);
  assert.ok(!msgs.some((m) => m.type === "error"));
  const interrupt = server.requests.find((r) => r.method === "turn/interrupt")!;
  assert.deepEqual(interrupt.params, { threadId: "codex-thread-new", turnId: "turn-1" });
  s.close();
});

test("interrupt while folder trust is pending denies the ask and releases the turn without spawning", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "mcp-codex-untrusted-stop-"));
  let spawned = 0;
  const s = new CodexSession({
    workspaceDir: workspace,
    makeAppServer: () => {
      spawned += 1;
      return fakeAppServer().makeAppServer({} as AppServerSpawn);
    },
  });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  s.pushPrompt("go");
  const ask = await waitFor(msgs, (m) => m.type === "permission_request");
  s.interrupt();
  await waitForTurnEnds(msgs);
  assert.equal(spawned, 0, "Stop before trust never reaches app-server startup");
  assert.ok(
    msgs.some((m) => m.type === "permission_resolved" && m.id === ask.id && m.allow === false),
    "the abandoned trust bar resolves visibly",
  );
  assert.ok(!msgs.some((m) => m.type === "notice" && /haven't trusted/.test(m.text)));
  s.close();
});

test("interrupt during thread startup cancels before turn/start — no ghost prompt", async () => {
  const threadStartGate = new Promise<void>(() => {});
  const server = fakeAppServer({ threadStartGate });
  const s = new CodexSession({ workspaceDir: tmp, makeAppServer: server.makeAppServer });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  s.pushPrompt("must not start");
  while (!server.requests.some((r) => r.method === "thread/start")) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  s.interrupt();
  await waitForTurnEnds(msgs);
  assert.equal(server.turnStarts().length, 0, "the stopped prompt never reaches the engine");
  assert.equal(server.clients[0]?.exited, true, "a startup with no answer is abandoned");
  assert.ok(!msgs.some((m) => m.type === "error"));
  s.close();
});

test("interrupt while turn/start never answers abandons the client and releases the turn", async () => {
  const turnStartGate = new Promise<void>(() => {});
  const server = fakeAppServer({ turnStartGate });
  const s = new CodexSession({ workspaceDir: tmp, makeAppServer: server.makeAppServer });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  s.pushPrompt("stop after acceptance");
  while (!server.requests.some((r) => r.method === "turn/start")) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  s.interrupt();
  await waitForTurnEnds(msgs);
  assert.equal(server.turnStarts().length, 1, "the request had already been sent to app-server");
  assert.equal(server.clients[0]?.exited, true, "the id-less turn cannot survive Stop");
  assert.equal(server.requests.filter((r) => r.method === "turn/interrupt").length, 0);
  assert.ok(!msgs.some((m) => m.type === "error"));
  s.close();
});

test("a successful turn/start response without an id abandons that client and retries fresh", async () => {
  const server = fakeAppServer({ omitTurnId: "once" });
  server.turns.push([DONE]);
  const s = new CodexSession({ workspaceDir: tmp, makeAppServer: server.makeAppServer });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  s.pushPrompt("malformed response");
  await waitForTurnEnds(msgs);
  assert.match(
    msgs.find((m) => m.type === "error")?.message ?? "",
    /turn\/start without a turn id/,
  );
  assert.equal(msgs.filter((m) => m.type === "turn_end").length, 1);
  assert.equal(server.clients[0]?.exited, true, "the unaddressable engine turn is abandoned");

  s.pushPrompt("retry");
  await waitForTurnEnds(msgs, 2);
  assert.equal(server.clients.length, 2, "the retry uses a fresh app-server");
  assert.equal(
    msgs.filter((m) => m.type === "error").length,
    1,
    "the valid retry adds no second error",
  );
  s.close();
});

test("interrupt grace abandons a valid-id turn whose completion never arrives", async () => {
  const server = fakeAppServer({ interruptCompletes: false });
  server.turns.push(async (ctx) => {
    ctx.notify("item/agentMessage/delta", { itemId: "m1", delta: "working" });
    await new Promise<void>(() => {});
  });
  const s = new CodexSession({
    workspaceDir: tmp,
    makeAppServer: server.makeAppServer,
    interruptGraceMs: 20,
  });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  s.pushPrompt("hang after Stop");
  await waitFor(msgs, (m) => m.type === "text_delta" && m.text === "working");
  s.interrupt();
  await waitForTurnEnds(msgs);
  assert.equal(server.requests.filter((r) => r.method === "turn/interrupt").length, 1);
  assert.equal(server.clients[0]?.exited, true, "the grace fallback reaps the wedged client");
  assert.ok(!msgs.some((m) => m.type === "error"));

  s.pushPrompt("/effort high");
  await waitForTurnEnds(msgs, 2);
  assert.ok(msgs.some((m) => m.type === "text_delta" && /high/.test(m.text)));
  s.close();
});

test("an engine approval becomes a bar ask: allow → accept, deny → decline, a permission grant carries the profile", async () => {
  const answers: Record<string, unknown> = {};
  const { s, msgs, awaitTurnEnd } = makeSession(async (ctx) => {
    ctx.notify("turn/started", {});
    answers.cmd = await ctx.serverRequest("item/commandExecution/requestApproval", {
      itemId: "c1",
      command: "git commit -m x",
      reason: "retry outside the sandbox?",
    });
    answers.patch = await ctx.serverRequest("item/fileChange/requestApproval", { itemId: "f1", reason: "write .git/index" });
    answers.perms = await ctx.serverRequest("item/permissions/requestApproval", {
      itemId: "p1",
      permissions: { network: { enabled: true } },
    });
    ctx.notify("item/completed", { item: { type: "agentMessage", id: "m1", text: "done" } });
    ctx.complete();
  });
  s.pushPrompt("go");
  const cmdAsk = await answerAsk(s, msgs, 1, true);
  await answerAsk(s, msgs, 2, false);
  await answerAsk(s, msgs, 3, true);
  await awaitTurnEnd();

  assert.deepEqual(answers.cmd, { decision: "accept" });
  assert.deepEqual(answers.patch, { decision: "decline" });
  assert.deepEqual(answers.perms, { permissions: { network: { enabled: true } } }, "an allowed permission ask grants exactly what was asked");
  // The ask states the command plainly and carries the engine's own reason.
  assert.equal(cmdAsk.tool, "Shell");
  assert.match(cmdAsk.detail, /git commit -m x — retry outside the sandbox\?/);
  // The permissions ask says what a yes GRANTS, not only why the engine asks
  // (audit 2026-08-26): the allow above echoed exactly this profile back.
  const permAsk = msgs.filter((m) => m.type === "permission_request")[2]!;
  assert.match(permAsk.detail, /network access/);
  // Every ask resolved visibly, in order.
  assert.deepEqual(
    msgs.filter((m) => m.type === "permission_resolved").map((m) => m.allow),
    [true, false, true],
  );
  s.close();
});

test("an unanswered approval denies at the timeout — fail-closed, and the command never runs", async () => {
  let decision: unknown;
  const { s, msgs, awaitTurnEnd } = makeSessionWithOptions({ permissionTimeoutMs: 25 }, async (ctx) => {
    ctx.notify("turn/started", {});
    decision = await ctx.serverRequest("item/commandExecution/requestApproval", { itemId: "c1", command: "rm -rf /x" });
    ctx.notify("item/completed", { item: { type: "agentMessage", id: "m1", text: "denied" } });
    ctx.complete();
  });
  s.pushPrompt("go");
  await awaitTurnEnd();
  assert.deepEqual(decision, { decision: "decline" }, "a timed-out ask declines");
  assert.equal(msgs.filter((m) => m.type === "permission_resolved" && m.allow === false).length, 1);
  s.close();
});

// ── The spawn: the chosen backend reaches the ENGINE's process — captured
// off the session's spawn spec (nothing is spawned in these tests).

function capturedSpawn(opts: {
  kind?: "api-key" | "subscription" | "local";
  endpoint?: string;
  provider?: string;
  model?: string;
}): AppServerSpawn {
  const s = new CodexSession({ workspaceDir: tmp, ...opts, makeAppServer: fakeAppServer().makeAppServer });
  const spec = (s as unknown as { spawnSpec: AppServerSpawn }).spawnSpec;
  s.close();
  return spec;
}

/** The `-c key=value` overrides of a spawn, as the nested object they encode. */
function configOf(spec: AppServerSpawn): Record<string, any> {
  const out: Record<string, any> = {};
  for (let i = 0; i < spec.args.length; i++) {
    if (spec.args[i] !== "-c") continue;
    const [key, ...rest] = spec.args[++i]!.split("=");
    const value = JSON.parse(rest.join("="));
    const parts = key!.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) node = node[part] ??= {};
    node[parts.at(-1)!] = value;
  }
  return out;
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

test("F.10: the installed Codex executable runs the app-server", () => {
  withEnvVar("MIRAFOLD_CODEX_BIN", "/operator/chosen/codex", () => {
    const spec = capturedSpawn({ kind: "subscription" });
    assert.equal(spec.command, "/operator/chosen/codex");
    assert.equal(spec.args[0], "app-server");
    assert.equal(
      configOf(spec).features?.apply_patch_streaming_events,
      true,
      "the process must enable current Codex's structured live patch snapshots",
    );
  });
});

test("N.5: a subscription choice withholds the env API key — the explicit pick beats env precedence", () => {
  withOpenAiKey("sk-env", () => {
    const spec = capturedSpawn({ kind: "subscription" });
    assert.ok(spec.env, "subscription must pass an env override");
    assert.ok(!("OPENAI_API_KEY" in spec.env!), "the env key must not reach the engine");
    assert.equal(configOf(spec).forced_login_method, undefined);
  });
});

test("N.5: an api-key choice keeps the env key AND forces the api login method (CA.1: app-server otherwise prefers auth.json)", () => {
  withOpenAiKey("sk-env", () => {
    const spec = capturedSpawn({ kind: "api-key" });
    // The engine env is always a filtered copy (audit 2026-08-26: the
    // daemon's own credentials never enter a child); the provider key stays.
    assert.equal(spec.env?.OPENAI_API_KEY, "sk-env", "the process inherits OPENAI_API_KEY");
    assert.equal(configOf(spec).forced_login_method, "api");
  });
});

test("N.5: no choice keeps the pre-N default — api-key iff the env var is set, nothing else", () => {
  withOpenAiKey("sk-env", () => {
    const spec = capturedSpawn({});
    assert.equal(spec.env?.OPENAI_API_KEY, "sk-env", "no choice: the env key stays with the engine");
    assert.equal(configOf(spec).forced_login_method, "api");
  });
  withOpenAiKey(undefined, () => {
    const spec = capturedSpawn({});
    assert.equal(spec.env?.OPENAI_API_KEY, undefined);
    assert.equal(configOf(spec).forced_login_method, undefined);
  });
});

test("N.5: a discovered-endpoint choice injects the documented provider recipe, keeping the MCP config", () => {
  let spec!: AppServerSpawn;
  withOpenAiKey("sk-env", () => {
    spec = capturedSpawn({ kind: "local", endpoint: "http://127.0.0.1:11434", model: "qwen3-coder" });
    // 2026-07-17 audit: the key is withheld from a local-endpoint engine —
    // same posture as the claude adapter's local branch.
    assert.ok(spec.env);
    assert.ok(!("OPENAI_API_KEY" in spec.env!));
  });
  const config = configOf(spec);
  assert.equal(config.model_provider, "mirafold_local");
  assert.equal(config.model_providers?.mirafold_local.base_url, "http://127.0.0.1:11434/v1");
  assert.equal(config.model_providers?.mirafold_local.wire_api, "responses"); // docs Path B
  assert.ok(config.mcp_servers?.[MIRAFOLD_MCP], "the render MCP server must survive the merge");
  assert.equal(config.mcp_servers[MIRAFOLD_MCP].default_tools_approval_mode, "approve");
});

test("a config.toml-provider choice (kind local, NO endpoint) injects nothing — the config default wins", () => {
  let spec!: AppServerSpawn;
  withOpenAiKey("sk-env", () => {
    spec = capturedSpawn({ kind: "local" });
    assert.ok(spec.env);
    assert.ok(!("OPENAI_API_KEY" in spec.env!));
  });
  const config = configOf(spec);
  // No override: Codex must resolve the user's own config.toml default
  // provider (faithful skin — inherit, not invent).
  assert.equal(config.model_provider, undefined);
  assert.equal(config.model_providers, undefined);
  assert.ok(config.mcp_servers?.[MIRAFOLD_MCP], "the render MCP server still rides along");
});

// ── Provider binding (2026-07-19): every pick forces the provider its label
// promised, so a config.toml custom default can't silently redirect a session
// the user was told runs elsewhere.

test("provider binding: a named config-provider pick forces that id, declaration inherited", () => {
  let spec!: AppServerSpawn;
  withOpenAiKey("sk-env", () => {
    spec = capturedSpawn({ kind: "local", provider: "openrouter" });
    assert.ok(spec.env);
    assert.ok(!("OPENAI_API_KEY" in spec.env!));
  });
  const config = configOf(spec);
  assert.equal(config.model_provider, "openrouter");
  // The provider's DEFINITION (base_url, env_key, wire_api) stays the user's
  // own [model_providers.openrouter] table — nothing injected over it.
  assert.equal(config.model_providers, undefined);
  assert.ok(config.mcp_servers?.[MIRAFOLD_MCP]);
});

test("provider binding: api-key and subscription picks force the first-party provider", () => {
  withOpenAiKey("sk-env", () => {
    assert.equal(configOf(capturedSpawn({ kind: "api-key" })).model_provider, "openai");
    assert.equal(configOf(capturedSpawn({ kind: "subscription" })).model_provider, "openai");
  });
});

test("provider binding: NO explicit pick still injects no provider — inherit stays inherit", () => {
  withOpenAiKey(undefined, () => {
    assert.equal(configOf(capturedSpawn({})).model_provider, undefined);
  });
});

test("faithful skin: no sandbox or approval override ever rides the spawn", () => {
  for (const kind of ["api-key", "subscription", "local", undefined] as const) {
    const config = configOf(capturedSpawn({ kind }));
    assert.equal(config.sandbox_mode, undefined);
    assert.equal(config.approval_policy, undefined);
    assert.equal(config.sandbox_workspace_write, undefined);
  }
});

// ── Provider binding, model axis: a forced-openai pick must not inherit a
// config.toml `model` chosen for a CUSTOM default provider — the first engine
// turn swaps in the ENGINE's own catalog default instead.

const FOREIGN_MODEL_TOML =
  'model = "qwen/qwen3-coder"\nmodel_provider = "openrouter"\n' +
  '[model_providers.openrouter]\nbase_url = "https://openrouter.ai/api/v1"\n';

/** A session plus a CODEX_HOME fixture (read at construction only) and the
 *  engine-catalog seam. */
function makeBindingSession(configToml: string | undefined, opts: {
  kind?: "api-key" | "subscription";
  model?: string;
  listEngineModels?: () => Promise<any[]>;
}, ...turns: Scripted[]) {
  const home = mkdtempSync(path.join(tmp, "codex-home-"));
  if (configToml !== undefined) writeFileSync(path.join(home, "config.toml"), configToml);
  const server = fakeAppServer();
  server.turns.push(...turns);
  // CODEX_HOME only matters at construction (the config scan runs there).
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  let s: CodexSession;
  try {
    s = new CodexSession({ workspaceDir: tmp, ...opts, makeAppServer: server.makeAppServer });
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  return { s, msgs, server, prompts: server.prompts, awaitTurnEnd: (count = 1) => waitForTurnEnds(msgs, count) };
}

// The model axis runs for BOTH first-party kinds. They aren't two code paths:
// providerBinding forces `openai` from a single `api-key || subscription`
// branch, and firstPartyOpenAI derives from that — so a regression would hit
// both at once. Parameterized anyway (2026-07-20) because the api-key path is
// the one that can't be exercised live without buying a key, which makes this
// the only thing pinning it.
for (const kind of ["subscription", "api-key"] as const) {
  test(`model axis (${kind}): the engine's catalog default replaces the foreign config model before the first turn`, async () => {
    const { s, server, prompts, awaitTurnEnd } = makeBindingSession(
      FOREIGN_MODEL_TOML,
      { kind, listEngineModels: async () => CATALOG },
      [DONE],
    );
    s.pushPrompt("hi");
    await awaitTurnEnd();
    assert.equal(server.threadStarts()[0].params.model, "gpt-9-sol", "the thread opens under the engine default");
    assert.equal(server.turnStarts()[0].model, "gpt-9-sol");
    assert.equal(s.modelName, "gpt-9-sol");
    assert.equal(prompts().length, 1); // the turn still ran, once, after the swap
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
    assert.equal(prompts().length, 0, "the foreign model must never reach the engine");
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
    assert.match(msgs.find((m) => m.type === "error")!.message, /default model could not be resolved/);
    assert.equal(prompts().length, 0);
    s.close();
  });

  test(`model axis (${kind}): a transient catalog failure is retried before the next prompt`, async () => {
    let lookups = 0;
    const { s, msgs, prompts, awaitTurnEnd } = makeBindingSession(
      FOREIGN_MODEL_TOML,
      {
        kind,
        listEngineModels: async () => {
          lookups += 1;
          if (lookups === 1) throw new Error("temporary catalog failure");
          return CATALOG;
        },
      },
      [DONE],
    );

    s.pushPrompt("first");
    await awaitTurnEnd(1);
    assert.equal(lookups, 1);
    assert.equal(prompts().length, 0, "the unresolved first-party model blocks the first prompt");
    assert.match(msgs.find((m) => m.type === "error")!.message, /default model could not be resolved/);

    s.pushPrompt("second");
    await awaitTurnEnd(2);
    assert.equal(lookups, 2, "the failed lookup did not disable the guard");
    assert.deepEqual(prompts(), ["second"]);
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
    assert.equal(prompts().length, 0);
    s.close();
  });
}

test("model axis: an explicit model (construction or /model) wins — no resolution", async () => {
  const viaOpts = makeBindingSession(
    FOREIGN_MODEL_TOML,
    {
      kind: "subscription",
      model: "gpt-9-luna",
      listEngineModels: async () => {
        throw new Error("must not be asked");
      },
    },
    [DONE],
  );
  viaOpts.s.pushPrompt("hi");
  await viaOpts.awaitTurnEnd();
  assert.equal(viaOpts.prompts().length, 1);
  assert.equal(viaOpts.s.modelName, "gpt-9-luna");
  viaOpts.s.close();

  const viaSwitch = makeBindingSession(
    FOREIGN_MODEL_TOML,
    {
      kind: "subscription",
      listEngineModels: async () => {
        throw new Error("must not be asked");
      },
    },
    [DONE],
  );
  viaSwitch.s.pushPrompt("/model gpt-9-terra");
  viaSwitch.s.pushPrompt("hi");
  await viaSwitch.awaitTurnEnd(2);
  assert.equal(viaSwitch.prompts().length, 1);
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
    const { s, server, prompts, awaitTurnEnd } = makeBindingSession(
      toml,
      {
        kind: "subscription",
        listEngineModels: async () => {
          throw new Error("must not be asked");
        },
      },
      [DONE],
    );
    s.pushPrompt("hi");
    await awaitTurnEnd();
    assert.equal(server.threadStarts()[0].params.model, undefined, `no model override for config: ${String(toml)}`);
    assert.equal(prompts().length, 1);
    s.close();
  }
});

test("a failed engine start does not burn anything: the retry spawns afresh and the guidance still lands", async () => {
  // The exec path once flipped its guidance flag before the engine accepted
  // the prompt, so a spawn failure on turn 1 lost RENDER_GUIDANCE forever.
  // With app-server the guidance is a thread/start param, and a start that
  // fails is simply retried by the next turn.
  const server = fakeAppServer({ startError: new Error("codex binary missing") });
  server.turns.push([DONE]);
  const s = new CodexSession({ workspaceDir: tmp, makeAppServer: server.makeAppServer });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  s.pushPrompt("first ask");
  await waitForTurnEnds(msgs, 1);
  assert.ok(msgs.some((m) => m.type === "error" && m.message.includes("codex binary missing")), "the failure itself surfaced");
  assert.equal(server.prompts().length, 0);

  s.pushPrompt("second ask");
  // This fake fails every start the same way; what must hold is the shape:
  // another spawn, another initialize, one turn_end each — never a wedged
  // session holding a dead first attempt.
  await waitForTurnEnds(msgs, 2);
  assert.equal(server.clients.length, 2, "each attempt gets a fresh process");
  assert.equal(server.requests.filter((r) => r.method === "initialize").length, 2);
  s.close();
});


// ── The folder-trust gate (CA.3): headless Codex writes trust_level into the
// user's config.toml on the first thread/start; Mirafold asks first. These
// tests share the module's global trust record (trustRecord, listing tmp);
// each uses a fresh workspace OUTSIDE tmp so it starts untrusted.

type TrustRecord = {
  version: 2;
  scopes: { "gemini-cli": string[]; codex: string[] };
};

const trustRecordNow = (): TrustRecord => JSON.parse(readFileSync(trustRecord, "utf8"));
const trustedNow = (): string[] => trustRecordNow().scopes.codex;

function makeSessionAt(workspaceDir: string, ...turns: Scripted[]) {
  const server = fakeAppServer();
  server.turns.push(...turns);
  const s = new CodexSession({ workspaceDir, makeAppServer: server.makeAppServer });
  const msgs: Any[] = [];
  s.onMessage((m) => msgs.push(m as Any));
  return { s, msgs, server, awaitTurnEnd: (count = 1) => waitForTurnEnds(msgs, count) };
}

test("an untrusted folder is asked before anything spawns; yes runs the turn and records the folder", async () => {
  const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "codex-untrusted-yes-")));
  assert.ok(!trustedNow().includes(ws), "the fresh folder must start untrusted");
  const { s, msgs, server, awaitTurnEnd } = makeSessionAt(ws, [DONE]);
  // try/finally: a red run must not sit on the 5-minute trust timer
  // (test-audit 2026-08-26).
  try {
    s.pushPrompt("go");
    const ask = await waitFor(msgs, (m) => m.type === "permission_request", "the trust ask");
    assert.equal(ask.tool, "Codex");
    assert.match(ask.detail, /trust this folder/);
    assert.match(ask.detail, /config\.toml/);
    assert.equal(server.specs.length, 0, "nothing spawned before the yes");
    s.resolvePermission(ask.id, true);
    await awaitTurnEnd();
    assert.equal(server.threadStarts().length, 1, "the thread starts only after the yes");
    assert.ok(trustedNow().includes(ws), "the yes was remembered");
  } finally {
    s.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("an untrusted folder denied: nothing spawns, config.toml is never touched, a refusal notice shows", async () => {
  const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "codex-untrusted-no-")));
  // The name's config.toml claim is ASSERTED: an isolated CODEX_HOME whose
  // config.toml must be byte-identical after the no (test-audit 2026-08-26).
  const priorHome = process.env.CODEX_HOME;
  const home = mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const configToml = path.join(home, "config.toml");
  writeFileSync(configToml, 'model = "gpt-5"\n');
  process.env.CODEX_HOME = home;
  const { s, msgs, server, awaitTurnEnd } = makeSessionAt(ws, [DONE]);
  try {
    s.pushPrompt("go");
    const ask = await waitFor(msgs, (m) => m.type === "permission_request", "the trust ask");
    s.resolvePermission(ask.id, false);
    await awaitTurnEnd();
    assert.equal(server.specs.length, 0, "a denied folder never spawns the engine");
    assert.equal(server.threadStarts().length, 0);
    const notice = msgs.find((m) => m.type === "notice")!;
    assert.equal(notice.kind, "refusal");
    assert.match(notice.text, /won't run in a folder you haven't trusted/);
    assert.ok(!trustedNow().includes(ws), "a denied trust records nothing");
    assert.equal(readFileSync(configToml, "utf8"), 'model = "gpt-5"\n', "config.toml is never touched");
  } finally {
    s.close();
    if (priorHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorHome;
    rmSync(ws, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a pre-trusted folder never asks", async () => {
  const ws = realpathSync(mkdtempSync(path.join(os.tmpdir(), "codex-trusted-")));
  const record = trustRecordNow();
  writeFileSync(
    trustRecord,
    JSON.stringify({ ...record, scopes: { ...record.scopes, codex: [...record.scopes.codex, ws] } }),
  );
  const { s, msgs, server, awaitTurnEnd } = makeSessionAt(ws, [DONE]);
  try {
    s.pushPrompt("go");
    await awaitTurnEnd();
    assert.ok(!msgs.some((m) => m.type === "permission_request"), "a trusted folder is not asked");
    assert.equal(server.threadStarts().length, 1);
  } finally {
    s.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("describePermissionProfile: every shape of the engine's RequestPermissionProfile is stated in words", () => {
  assert.equal(
    describePermissionProfile({
      fileSystem: {
        entries: [
          { access: "write", path: { type: "path", path: "/home/u/proj/out" } },
          { access: "read", path: { type: "glob_pattern", pattern: "/etc/**" } },
          { access: "write", path: { type: "special", value: { kind: "root" } } },
        ],
        read: ["/var/log"],
        write: ["/tmp/x"],
      },
      network: { enabled: true },
    }),
    "grant for this turn: write /home/u/proj/out, read /etc/** (glob), write the ENTIRE filesystem, read /var/log, write /tmp/x, network access",
  );
  assert.equal(describePermissionProfile({ network: { enabled: false } }), "grant additional permissions for this turn (the engine named none)");
  assert.equal(describePermissionProfile({ fileSystem: "junk", network: null }), "grant additional permissions for this turn (the engine named none)");
});

test("describePermissionProfile: the special kinds that carry a literal path or subpath state it", () => {
  assert.equal(
    describePermissionProfile({
      fileSystem: {
        entries: [
          { access: "write", path: { type: "special", value: { kind: "unknown", path: "/etc/cron.d" } } },
          { access: "read", path: { type: "special", value: { kind: "project_roots", subpath: "secrets" } } },
          { access: "read", path: { type: "special", value: { kind: "unknown", path: "/var/x", subpath: "y" } } },
        ],
      },
    }),
    "grant for this turn: write /etc/cron.d, read secrets inside each project root, read /var/x/y",
  );
});


test("apply_patch changes normalize from the wire shape and the rollout shape alike (TS.6)", () => {
  const ws = "/home/u/proj";
  const wire = normalizePatchChanges(
    [
      { path: `${ws}/a.ts`, kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" },
      { path: `${ws}/new.md`, kind: { type: "add" }, diff: "hello\n" },
      { path: `${ws}/old.md`, kind: { type: "delete" }, diff: "bye\n" },
      { path: `${ws}/x.ts`, kind: { type: "update", move_path: `${ws}/y.ts` }, diff: "" },
      { path: "/etc/hosts", kind: { type: "update" }, diff: "" },
    ],
    ws,
  );
  assert.deepEqual(wire.map(describePatchChange), [
    "Updated a.ts",
    "Added new.md",
    "Deleted old.md",
    "Moved x.ts → y.ts",
    "Updated /etc/hosts", // outside the workspace stays absolute
  ]);
  assert.deepEqual(wire[0], { path: "a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b\n" });
  const rollout = normalizePatchChanges(
    { [`${ws}/a.ts`]: { type: "update", unified_diff: "@@ -1 +1 @@\n-a\n+b\n", move_path: null }, [`${ws}/n.md`]: { type: "add", content: "hi\n" } },
    ws,
  );
  assert.deepEqual(rollout, [
    { path: "a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b\n" },
    { path: "n.md", kind: "add", diff: "hi\n" },
  ]);
  // The guessed shape that hid a month of diffs must never come back:
  // an object kind is never stringified.
  assert.ok(!JSON.stringify(wire).includes("[object Object]"));
  assert.deepEqual(normalizePatchChanges(undefined, ws), []);
  assert.deepEqual(normalizePatchChanges("garbage", ws), []);
});


test("an item kind or notification the adapter cannot map is reported once, never dropped silently (TS.7)", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["turn/started", {}],
    ["item/completed", { item: { type: "futureItemKind", id: "fx1", payload: 1 } }],
    ["item/completed", { item: { type: "futureItemKind", id: "fx2", payload: 2 } }],
    ["item/completed", { item: { type: "userMessage", id: "u1", content: [] } }], // deliberately ignored
    ["thread/somethingNewer", { detail: "a kind this build has never heard of" }],
    ["thread/name/updated", { name: "x" }], // deliberately ignored
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const notices = msgs.filter((m) => m.type === "notice").map((m) => m.text);
  assert.deepEqual(notices, [
    "Mirafold doesn't display this Codex item yet: futureItemKind",
    "Mirafold doesn't display this Codex event yet: thread/somethingNewer",
  ]);
  // Shell-voiced: no `source` badge on Mirafold's own sentence.
  assert.ok(msgs.filter((m) => m.type === "notice").every((m) => m.source === undefined));
  s.close();
});


test("agent-message prose carries the engine's phase; a plan streams as commentary (TS.8)", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["turn/started", {}],
    ["item/started", { item: { type: "agentMessage", id: "c1", text: "", phase: "commentary" } }],
    ["item/agentMessage/delta", { itemId: "c1", delta: "Checking the watcher. " }],
    ["item/completed", { item: { type: "agentMessage", id: "c1", text: "Checking the watcher. Done.", phase: "commentary" } }],
    ["item/started", { item: { type: "plan", id: "p1", text: "" } }],
    ["item/plan/delta", { itemId: "p1", delta: "1. read 2. fix" }],
    ["item/completed", { item: { type: "plan", id: "p1", text: "1. read 2. fix" } }],
    ["item/started", { item: { type: "agentMessage", id: "f1", text: "", phase: "final_answer" } }],
    ["item/agentMessage/delta", { itemId: "f1", delta: "Fixed: " }],
    ["item/completed", { item: { type: "agentMessage", id: "f1", text: "Fixed: the flush waits.", phase: "final_answer" } }],
    ["item/completed", { item: { type: "enteredReviewMode", id: "r1", review: {} } }],
    ["model/rerouted", { fromModel: "gpt-a", toModel: "gpt-b" }],
    ["configWarning", { message: "config key x is unknown" }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  assert.deepEqual(
    msgs.filter((m) => m.type === "text_delta").map((m) => [m.text, m.phase]),
    [
      ["Checking the watcher. ", "commentary"],
      ["Done.", "commentary"],
      ["1. read 2. fix", "commentary"],
      ["Fixed: ", "final"],
      ["the flush waits.", "final"],
    ],
  );
  assert.deepEqual(
    msgs.filter((m) => m.type === "notice").map((m) => [m.text, m.kind, m.source]),
    [
      ["Codex entered review mode.", "info", undefined],
      ["Codex rerouted the model from gpt-a to gpt-b.", "info", undefined],
      ["config key x is unknown", "warning", "codex"],
    ],
  );
  s.close();
});


test("subagent collab calls are rows, child activity narrates under its spawn; sleep and dynamic tools are rows (TS.9)", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["turn/started", {}],
    ["item/started", { item: { type: "collabAgentToolCall", id: "cb1", tool: "spawn_agent", prompt: "Audit the watcher\nthen report", receiverThreadIds: ["t-child"], senderThreadId: "t-root", status: "inProgress", agentsStates: {} } }],
    ["item/completed", { item: { type: "subAgentActivity", id: "sa1", kind: "started", agentThreadId: "t-child", agentPath: "worker" } }],
    ["item/completed", { item: { type: "collabAgentToolCall", id: "cb1", tool: "spawn_agent", prompt: "Audit the watcher\nthen report", receiverThreadIds: ["t-child"], senderThreadId: "t-root", status: "completed", agentsStates: { "t-child": { status: "running", message: null } } } }],
    ["item/completed", { item: { type: "subAgentActivity", id: "sa2", kind: "completed", agentThreadId: "t-child", agentPath: "worker" } }],
    ["item/completed", { item: { type: "subAgentActivity", id: "sa3", kind: "started", agentThreadId: "t-unknown", agentPath: "stray" } }],
    ["item/completed", { item: { type: "sleep", id: "sl1", durationMs: 1500 } }],
    ["item/started", { item: { type: "dynamicToolCall", id: "dt1", tool: "lookup", namespace: "crm", arguments: { query: "acme" }, status: "inProgress" } }],
    ["item/completed", { item: { type: "dynamicToolCall", id: "dt1", tool: "lookup", namespace: "crm", arguments: { query: "acme" }, status: "completed", success: true, contentItems: [{ type: "text", text: "2 accounts" }] } }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const uses = msgs.filter((m) => m.type === "tool_use").map((m) => [m.name, m.detail, m.id]);
  assert.deepEqual(uses, [
    ["spawn_agent", "Audit the watcher", "cb1"],
    ["sleep", "1.5 s", "sl1"],
    ["crm.lookup", "acme", "dt1"],
  ]);
  const results = msgs.filter((m) => m.type === "tool_result").map((m) => [m.id, m.output, m.isError]);
  assert.deepEqual(results, [
    ["cb1", "t-child: running", false],
    ["sl1", "(done)", undefined],
    ["dt1", "2 accounts", false],
  ]);
  // The child's lifecycle groups under the spawn row; a thread no call named
  // is narrated in the transcript instead of dropped.
  assert.deepEqual(
    msgs.filter((m) => m.type === "text_delta").map((m) => [m.text, m.parentId, m.phase]),
    [
      ["worker started\n", "cb1", undefined],
      ["worker completed\n", "cb1", undefined],
      ["Subagent stray started.\n", undefined, "commentary"],
    ],
  );
  assert.equal(msgs.filter((m) => m.type === "notice").length, 0, "nothing was reported as unmapped");
  s.close();
});

test("an image the model viewed is a row plus the picture inline; outside the workspace the row stands alone (TS.10)", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  writeFileSync(path.join(tmp, "shot.png"), png);
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["turn/started", {}],
    ["item/completed", { item: { type: "imageView", id: "iv1", path: `${tmp}/shot.png` } }],
    ["item/completed", { item: { type: "imageView", id: "iv2", path: "/etc/hostname" } }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  assert.deepEqual(
    msgs.filter((m) => m.type === "tool_use").map((m) => [m.name, m.detail]),
    [["view_image", "shot.png"], ["view_image", "/etc/hostname"]],
  );
  const paintings = msgs.filter((m) => m.type === "render");
  assert.equal(paintings.length, 1);
  assert.equal(paintings[0].component, "image");
  assert.match(String(paintings[0].props["src"]), /^data:image\/png;base64,/);
  s.close();
});

test("command output streams while the call runs, capped, and the result still closes the row (TS.11)", async () => {
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["turn/started", {}],
    ["item/started", { item: { type: "commandExecution", id: "c1", command: "yarn test", status: "inProgress" } }],
    ["item/commandExecution/outputDelta", { itemId: "c1", delta: "running 1\n" }],
    ["item/commandExecution/outputDelta", { itemId: "c1", delta: "running 2\n" }],
    ["item/commandExecution/outputDelta", { itemId: "never-announced", delta: "orphan" }],
    ["item/completed", { item: { type: "commandExecution", id: "c1", command: "yarn test", aggregatedOutput: "running 1\nrunning 2\nok\n", exitCode: 0, status: "completed" } }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  assert.deepEqual(
    msgs.filter((m) => m.type === "tool_output_delta").map((m) => [m.id, m.text]),
    [["c1", "running 1\n"], ["c1", "running 2\n"]],
  );
  assert.equal(msgs.find((m) => m.type === "tool_result")!.output, "running 1\nrunning 2\nok\n");
  s.close();
});

test("current file-change snapshots repaint one apply_patch row through completion", async () => {
  const firstChanges = [
    {
      path: `${tmp}/a.ts`,
      kind: { type: "update", move_path: null },
      diff: "@@ -1 +1 @@\n-a\n+b\n",
    },
  ];
  const finalChanges = [
    {
      path: `${tmp}/a.ts`,
      kind: { type: "update", move_path: null },
      diff: "@@ -1 +1 @@\n-a\n+c\n",
    },
  ];
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["turn/started", {}],
    ["item/started", { item: { type: "fileChange", id: "p1", status: "inProgress", changes: [] } }],
    ["item/fileChange/patchUpdated", { itemId: "p1", changes: firstChanges }],
    ["item/fileChange/patchUpdated", { itemId: "p1", changes: finalChanges }],
    ["item/completed", { item: { type: "fileChange", id: "p1", status: "completed", changes: finalChanges } }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();

  const uses = msgs.filter((m) => m.type === "tool_use" && m.id === "p1");
  assert.equal(uses.length, 1);
  assert.equal(uses[0].name, "apply_patch");
  assert.deepEqual(uses[0].input?.changes, []);
  const updates = msgs.filter((m) => m.type === "tool_update" && m.id === "p1");
  assert.equal(updates.length, 2, "the identical completion snapshot is not repainted");
  assert.deepEqual(
    updates.map((m) => m.input?.changes),
    [
      [{ path: "a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b\n" }],
      [{ path: "a.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+c\n" }],
    ],
  );
  assert.equal(updates[1].detail, "Updated a.ts");
  assert.equal(msgs.find((m) => m.type === "tool_result" && m.id === "p1")?.output, "Updated a.ts");
  s.close();
});

test("streamed command output applies the final-output ceiling in UTF-8 bytes, not characters", async () => {
  const unicode = "€".repeat(OUTPUT_CAP_BYTES);
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["turn/started", {}],
    ["item/started", { item: { type: "commandExecution", id: "bytes", command: "unicode", status: "inProgress" } }],
    ["item/commandExecution/outputDelta", { itemId: "bytes", delta: unicode }],
    ["item/commandExecution/outputDelta", { itemId: "bytes", delta: "must not pass the exhausted budget" }],
    ["item/completed", { item: { type: "commandExecution", id: "bytes", command: "unicode", aggregatedOutput: unicode, exitCode: 0, status: "completed" } }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();

  const streamed = msgs
    .filter((m) => m.type === "tool_output_delta" && m.id === "bytes")
    .map((m) => m.text)
    .join("");
  // The ceiling holds for the bytes, and crossing it is said exactly once —
  // an interrupted command settles from this stream (release review 2026-09-01).
  const body = streamed.replace(STREAM_CAP_MARKER, "");
  assert.ok(Buffer.byteLength(body, "utf8") <= OUTPUT_CAP_BYTES);
  assert.ok(Buffer.byteLength(body, "utf8") >= OUTPUT_CAP_BYTES - 3);
  assert.equal(streamed.split(STREAM_CAP_MARKER).length - 1, 1, "the cap marker appears once");
  assert.doesNotMatch(streamed, /must not pass/);
  s.close();
});

test("a stream that lands exactly on the ceiling is marked too, and stays silent after", async () => {
  const exact = "a".repeat(OUTPUT_CAP_BYTES);
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["turn/started", {}],
    ["item/started", { item: { type: "commandExecution", id: "exact", command: "x", status: "inProgress" } }],
    ["item/commandExecution/outputDelta", { itemId: "exact", delta: exact }],
    ["item/commandExecution/outputDelta", { itemId: "exact", delta: "after the ceiling" }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const streamed = msgs.filter((m) => m.type === "tool_output_delta" && m.id === "exact").map((m) => m.text).join("");
  assert.equal(streamed.split(STREAM_CAP_MARKER).length - 1, 1);
  assert.doesNotMatch(streamed, /after the ceiling/);
  s.close();
});

test("subagent activity lines are clamped and share the narration budget", async () => {
  const events: [string, Record<string, unknown>][] = [
    ["turn/started", {}],
    ["item/started", { item: { type: "collabAgentToolCall", id: "cb1", tool: "spawn_agent", prompt: "go", receiverThreadIds: ["t-child"], status: "inProgress", agentsStates: {} } }],
  ];
  // An engine-chosen path at engine-chosen length, with a direction override.
  const noisyPath = `${"p".repeat(10)}\u202e${"p".repeat(300)}`;
  for (let i = 0; i < 800; i++) {
    events.push(["item/completed", { item: { type: "subAgentActivity", id: `sa${i}`, kind: "working", agentThreadId: "t-child", agentPath: noisyPath } }]);
  }
  events.push(DONE);
  const { s, msgs, awaitTurnEnd } = makeSession(events);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const lines = msgs.filter((m) => m.type === "text_delta" && m.parentId === "cb1");
  assert.ok(lines.length > 0);
  assert.ok(lines[0].text.length <= 120, "agentPath is clamped");
  assert.ok(lines[0].text.includes("‹U+202E›"), "direction controls are marked, not merely dropped");
  assert.ok(!lines[0].text.includes("\u202e"), "no raw direction control passes through");
  const markers = lines.filter((m) => m.text.includes("narration cap reached"));
  assert.equal(markers.length, 1, "the budget's elision marker fires exactly once");
  const total = lines.reduce((n, m) => n + Buffer.byteLength(m.text, "utf8"), 0);
  assert.ok(total <= 64_000 + 200, "the lane is byte-bounded");
});

test("unanchored subagent activity is budgeted too", async () => {
  const events: [string, Record<string, unknown>][] = [["turn/started", {}]];
  for (let i = 0; i < 800; i++) {
    events.push(["item/completed", { item: { type: "subAgentActivity", id: `sx${i}`, kind: "working", agentThreadId: "t-stray", agentPath: "p".repeat(96) } }]);
  }
  events.push(DONE);
  const { s, msgs, awaitTurnEnd } = makeSession(events);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const lines = msgs.filter((m) => m.type === "text_delta" && m.parentId === undefined && m.phase === "commentary");
  assert.ok(lines.length > 0 && lines.length < 800, "the budget stops the stream");
  const markers = lines.filter((m) => m.text.includes("narration cap reached"));
  assert.equal(markers.length, 1, "the elision marker fires exactly once");
  const total = lines.reduce((n, m) => n + Buffer.byteLength(m.text, "utf8"), 0);
  assert.ok(total <= 64_000 + 200, "the unanchored lane is byte-bounded");
});

test("an MCP call's engine-chosen server/tool names are clamped and control-visible", async () => {
  const hugeTool = `t\u202e${"t".repeat(10_000)}`;
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["turn/started", {}],
    ["item/started", { item: { type: "mcpToolCall", id: "m1", server: "srv", tool: hugeTool, status: "inProgress" } }],
    ["item/completed", { item: { type: "mcpToolCall", id: "m1", server: "srv", tool: hugeTool, status: "completed", result: { content: [{ type: "text", text: "ok" }] } } }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const use = msgs.find((m) => m.type === "tool_use" && m.id === "m1");
  assert.ok(use && use.type === "tool_use");
  assert.ok(use.name.length <= 140, "the name is clamped");
  assert.ok(use.name.includes("‹U+202E›") && !use.name.includes("\u202e"), "controls are marked");
  assert.ok((use.detail ?? "").length <= 110, "the detail is clamped");
});

test("the subagent anchor map is bounded; overflow threads fall to the budgeted lane", async () => {
  const many = Array.from({ length: 5_010 }, (_, i) => `t-${i}`);
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["turn/started", {}],
    ["item/started", { item: { type: "collabAgentToolCall", id: "cb1", tool: "spawn_agent", prompt: "go", receiverThreadIds: many, status: "inProgress", agentsStates: {} } }],
    ["item/completed", { item: { type: "subAgentActivity", id: "sa1", kind: "started", agentThreadId: "t-10", agentPath: "early" } }],
    ["item/completed", { item: { type: "subAgentActivity", id: "sa2", kind: "started", agentThreadId: "t-5005", agentPath: "late" } }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  const deltas = msgs.filter((m) => m.type === "text_delta");
  assert.ok(deltas.some((m) => m.parentId === "cb1" && m.text.includes("early")), "a thread under the cap anchors");
  assert.ok(deltas.some((m) => m.parentId === undefined && m.text.includes("late")), "a thread past the cap is narrated, not dropped");
});

test("engine-sized completion text is capped on every result path (PR #80 review)", async () => {
  const states: Record<string, { status: string; message: string }> = {};
  for (let i = 0; i < 3_000; i++) states[`t-${i}`] = { status: "running", message: "m".repeat(150) };
  const { s, msgs, awaitTurnEnd } = makeSession([
    ["turn/started", {}],
    ["item/started", { item: { type: "collabAgentToolCall", id: "cb1", tool: "spawn_agent", prompt: "go", receiverThreadIds: ["t-0"], status: "inProgress", agentsStates: {} } }],
    ["item/completed", { item: { type: "collabAgentToolCall", id: "cb1", tool: "spawn_agent", prompt: "go", receiverThreadIds: ["t-0"], status: "completed", agentsStates: states } }],
    ["item/completed", { item: { type: "imageGeneration", id: "ig1", status: "failed", failure: "f".repeat(200_000) } }],
    DONE,
  ]);
  s.pushPrompt("go");
  await awaitTurnEnd();
  for (const id of ["cb1", "ig1"]) {
    const res = msgs.find((m) => m.type === "tool_result" && m.id === id);
    assert.ok(res && res.type === "tool_result", `${id} resolved`);
    assert.ok(Buffer.byteLength(res.output, "utf8") <= OUTPUT_CAP_BYTES + 64, `${id} capped`);
    // The elision is reported either way: capOutput's byte count, or the
    // collab fan-out's own "… N more" line (it stops materializing states at
    // the ceiling rather than building them all first).
    assert.ok((res.truncatedBytes ?? 0) > 0 || /… \d+ more$/.test(res.output), `${id} reports the elision`);
  }
  const collab = msgs.find((m) => m.type === "tool_result" && m.id === "cb1");
  assert.ok(collab && collab.type === "tool_result" && /… \d+ more$/.test(collab.output), "the fan-out was bounded before it was built");
  s.close();
});
