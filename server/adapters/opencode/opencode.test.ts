import { after, test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { WireMsg } from "../../protocol";
import { MIRAFOLD_CONTEXT, RENDER_GUIDANCE } from "../../render-tools";
import { OpenCodeSession, openCodeRenderMcpConfig } from "./opencode";
import { OpenCodeServerProcess, type OpenCodeEvent, type OpenCodeTransport } from "./opencode-client";
import { MIRAFOLD_MCP } from "../render-mcp-cmd";
import { waitFor } from "../../testing/wait-for";
import { OPENCODE_SUBAGENT_EVENTS } from "../../testing/fixtures/opencode-subagent-fixture";

// OC.1: the OpenCode event→WireMsg mapping and the turn grammar, on synthetic
// events whose shapes are the OC.0 live capture (opencode.spike.md) — no
// engine, no network. The session is real; only the transport is a fake, so
// the whole worker → runTurn → mapper path runs as shipped.

type Any = WireMsg & Record<string, any>;

const previousTrustFile = process.env.MIRAFOLD_WORKSPACE_TRUST_FILE;
const tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-opencode-test-"));
// The folder-trust gate (audit 2026-08-26): sessions under `tmp` start warm;
// the gate has its own untrusted-folder test at the end.
const trustRecord = path.join(tmp, "trusted-workspaces.json");
writeFileSync(trustRecord, JSON.stringify({ version: 2, scopes: { opencode: [tmp] } }));
process.env.MIRAFOLD_WORKSPACE_TRUST_FILE = trustRecord;
after(() => {
  if (previousTrustFile === undefined) delete process.env.MIRAFOLD_WORKSPACE_TRUST_FILE;
  else process.env.MIRAFOLD_WORKSPACE_TRUST_FILE = previousTrustFile;
  rmSync(tmp, { recursive: true, force: true });
});
const SES = "ses_test";

class FakeTransport implements OpenCodeTransport {
  onEvent: (ev: OpenCodeEvent) => void = () => {};
  prompts: Record<string, unknown>[] = [];
  promptSessionIDs: string[] = [];
  aborts = 0;
  forks: string[] = [];
  replies: { permissionID: string; response: string }[] = [];
  closed = false;
  existing = new Set<string>();
  failPrompt?: Error;
  failPermissionReply?: Error;
  configContent?: Record<string, unknown>;
  // OC.3 classification inputs — defaults let a pinless session resolve the
  // user's config default onto an allowed BYO provider.
  catalog: Awaited<ReturnType<OpenCodeTransport["providerCatalog"]>> = [
    { id: "fake", source: "config" },
  ];
  cfgModel: string | undefined = "fake/fake-model";
  sessionsCreated = 0;
  uniqueSessionIDs = false;
  agents: Awaited<ReturnType<OpenCodeTransport["agentCatalog"]>> = [
    { name: "build", mode: "primary", description: "The default agent" },
    { name: "plan", mode: "primary", description: "Plan mode" },
    { name: "title", mode: "primary", hidden: true },
    { name: "explore", mode: "subagent" },
  ];
  engineCommands: Awaited<ReturnType<OpenCodeTransport["commandCatalog"]>> = [
    { name: "init", description: "guided AGENTS.md setup" },
  ];
  models: Awaited<ReturnType<OpenCodeTransport["modelCatalog"]>> = [
    { providerID: "fake", modelID: "fake-model", name: "Fake Model" },
  ];
  commands: { name: string; args: string; opts: Record<string, unknown> }[] = [];
  async start(cb: (ev: OpenCodeEvent) => void) {
    this.onEvent = cb;
  }
  async providerCatalog() {
    return this.catalog;
  }
  async configModel() {
    return this.cfgModel;
  }
  async agentCatalog() {
    return this.agents;
  }
  async commandCatalog() {
    return this.engineCommands;
  }
  async modelCatalog() {
    return this.models;
  }
  async command(_sessionID: string, name: string, args: string, opts: Record<string, unknown>) {
    this.commands.push({ name, args, opts });
  }
  async createSession() {
    this.sessionsCreated++;
    return {
      id:
        this.uniqueSessionIDs && this.sessionsCreated > 1
          ? `${SES}_${this.sessionsCreated}`
          : SES,
    };
  }
  async forkSession(id: string) {
    this.forks.push(id);
    return { id: `${id}_fork_${this.forks.length}` };
  }
  async sessionExists(id: string) {
    return this.existing.has(id);
  }
  async prompt(sessionID: string, body: Record<string, unknown>) {
    if (this.failPrompt) throw this.failPrompt;
    this.promptSessionIDs.push(sessionID);
    this.prompts.push(body);
  }
  async abort(_sessionID: string) {
    this.aborts++;
  }
  async replyPermission(permissionID: string, response: "once" | "reject") {
    this.replies.push({ permissionID, response });
    if (this.failPermissionReply) throw this.failPermissionReply;
  }
  close() {
    this.closed = true;
  }
}

const ev = (type: string, properties: Record<string, unknown>): OpenCodeEvent => ({
  type,
  properties,
});
const snap = (part: Record<string, unknown>) =>
  ev("message.part.updated", {
    sessionID: SES,
    part: { sessionID: SES, messageID: "m1", id: "p1", ...part },
  });
const delta = (partID: string, text: string) =>
  ev("message.part.delta", { sessionID: SES, messageID: "m1", partID, field: "text", delta: text });
const idle = (sessionID = SES) => ev("session.idle", { sessionID });
const asked = (id = "per1") =>
  ev("permission.asked", {
    id,
    sessionID: SES,
    permission: "bash",
    patterns: ["echo hi"],
    metadata: { command: "echo hi" },
    always: ["echo *"],
    tool: { messageID: "m1", callID: "c1" },
  });
const assistant = (
  id: string,
  tokens: { input: number; output: number; reasoning?: number },
  modelID = "fake-model",
  cost = 0,
) =>
  ev("message.updated", {
    sessionID: SES,
    info: {
      id,
      role: "assistant",
      sessionID: SES,
      modelID,
      cost,
      tokens: { reasoning: 0, cache: { read: 0, write: 0 }, ...tokens },
    },
  });

function makeSession(opts: Partial<ConstructorParameters<typeof OpenCodeSession>[0]> = {}) {
  const fake = new FakeTransport();
  const session = new OpenCodeSession({
    workspaceDir: tmp,
    makeTransport: (config) => {
      fake.configContent = config;
      return fake;
    },
    ...opts,
  });
  const msgs: Any[] = [];
  session.onMessage((m) => msgs.push(m as Any));
  const turnEnds = () => msgs.filter((m) => m.type === "turn_end").length;
  const prompt = async (text: string) => {
    const before = fake.prompts.length;
    session.pushPrompt(text);
    await waitFor(() => fake.prompts.length > before, "prompt to reach transport");
  };
  const awaitTurnEnd = (count = 1) => waitFor(() => turnEnds() >= count, `turn_end #${count}`);
  const feed = (...events: OpenCodeEvent[]) => events.forEach((e) => fake.onEvent(e));
  return { session, fake, msgs, prompt, feed, awaitTurnEnd };
}

test("text streams as deltas; the final snapshot never duplicates", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    snap({ type: "text", text: "" }),
    delta("p1", "hel"),
    delta("p1", "lo"),
    snap({ type: "text", text: "hello" }), // full-text snapshot after deltas
    idle(),
  );
  await awaitTurnEnd();
  const texts = msgs.filter((m) => m.type === "text_delta").map((m) => m.text);
  assert.deepEqual(texts, ["hel", "lo"]);
  session.close();
});

test("a buffered part (snapshot only, no deltas) still emits its text", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(snap({ type: "text", text: "all at once" }), idle());
  await awaitTurnEnd();
  assert.deepEqual(
    msgs.filter((m) => m.type === "text_delta").map((m) => m.text),
    ["all at once"],
  );
  session.close();
});

test("reasoning parts become thinking_delta behind a thinking status", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    snap({ type: "reasoning", text: "", id: "r1" }),
    delta("r1", "pondering"),
    idle(),
  );
  await awaitTurnEnd();
  assert.equal(msgs.find((m) => m.type === "status")?.state, "thinking");
  assert.deepEqual(
    msgs.filter((m) => m.type === "thinking_delta").map((m) => m.text),
    ["pondering"],
  );
  session.close();
});

test("tool lifecycle: running announces, completed resolves, output is capped", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  const input = { command: "echo hi", description: "d" };
  feed(
    snap({ type: "tool", id: "t1", tool: "bash", callID: "c1", state: { status: "running", input } }),
    snap({
      type: "tool",
      id: "t1",
      tool: "bash",
      callID: "c1",
      state: { status: "completed", input, output: "x".repeat(70_000), title: "echo hi" },
    }),
    idle(),
  );
  await awaitTurnEnd();
  const use = msgs.find((m) => m.type === "tool_use");
  assert.equal(use?.name, "bash");
  assert.equal(use?.detail, "echo hi");
  assert.equal(use?.id, "t1");
  assert.deepEqual(use?.input, input);
  assert.equal(msgs.find((m) => m.type === "status" && m.state === "tool")?.label, "bash");
  const result = msgs.find((m) => m.type === "tool_result");
  assert.equal(result?.id, "t1");
  assert.ok((result?.truncatedBytes ?? 0) > 0, "long output reports its elided bytes");
  session.close();
});

test("OpenCode write/edit calls use the shared code and diff painter shapes", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    snap({
      type: "tool",
      id: "write-1",
      tool: "write",
      state: {
        status: "completed",
        input: { filePath: path.join(tmp, "new.txt"), content: "new file\n" },
        output: "Wrote file successfully.",
      },
    }),
    snap({
      type: "tool",
      id: "edit-1",
      tool: "edit",
      state: {
        status: "completed",
        input: {
          filePath: path.join(tmp, "old.txt"),
          oldString: "before\n",
          newString: "after\n",
          replaceAll: true,
        },
        output: "Edit applied successfully.",
      },
    }),
    idle(),
  );
  await awaitTurnEnd();

  const uses = msgs.filter((m) => m.type === "tool_use");
  assert.deepEqual(
    uses.map(({ name, detail, input }) => ({ name, detail, input })),
    [
      {
        name: "Write",
        detail: "new.txt",
        input: { file_path: "new.txt", content: "new file\n" },
      },
      {
        name: "Edit",
        detail: "old.txt",
        input: {
          file_path: "old.txt",
          old_string: "before\n",
          new_string: "after\n",
          replace_all: true,
        },
      },
    ],
  );
  session.close();
});

test("tool error resolves as an isError result; completed-first still announces", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    // completed arrives with no prior running snapshot — announce then resolve
    snap({
      type: "tool",
      id: "t1",
      tool: "webfetch",
      state: { status: "error", input: { url: "https://x" }, error: "boom" },
    }),
    idle(),
  );
  await awaitTurnEnd();
  assert.equal(msgs.find((m) => m.type === "tool_use")?.name, "webfetch");
  const result = msgs.find((m) => m.type === "tool_result");
  assert.equal(result?.isError, true);
  assert.equal(result?.output, "boom");
  session.close();
});

test("a mirafold render call paints the component, no raw tool block", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    snap({
      type: "tool",
      id: "t1",
      tool: "mirafold_render_card",
      state: {
        status: "completed",
        input: { title: "Hi", body: "b" },
        output: "Rendered card (id: 0a1b2c3d-0000-0000-0000-000000000000)",
      },
    }),
    idle(),
  );
  await awaitTurnEnd();
  const render = msgs.find((m) => m.type === "render");
  assert.equal(render?.component, "card");
  assert.equal(render?.id, "0a1b2c3d-0000-0000-0000-000000000000");
  assert.deepEqual(render?.props, { title: "Hi", body: "b" });
  assert.equal(msgs.some((m) => m.type === "tool_use" || m.type === "tool_result"), false);
  session.close();
});

test("an agent-chosen render id (update-in-place) paints under that id", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    snap({
      type: "tool",
      id: "t1",
      tool: "mirafold_render_progress",
      state: {
        status: "completed",
        input: { id: "deploy-status", label: "deploy", percent: 40 },
        output: "Rendered progress (id: deploy-status)",
      },
    }),
    idle(),
  );
  await awaitTurnEnd();
  const render = msgs.find((m) => m.type === "render");
  assert.equal(render?.component, "progress");
  assert.equal(render?.id, "deploy-status");
  assert.equal(msgs.some((m) => m.type === "tool_use" || m.type === "tool_result"), false);
  session.close();
});

test("mirafold emit_artifact paints an artifact", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    snap({
      type: "tool",
      id: "t1",
      tool: "mirafold_emit_artifact",
      state: {
        status: "completed",
        input: { html: "<b>x</b>", title: "T" },
        output: "Rendered artifact (id: 0a1b2c3d-0000-0000-0000-00000000ffff)",
      },
    }),
    idle(),
  );
  await awaitTurnEnd();
  const artifact = msgs.find((m) => m.type === "artifact");
  assert.equal(artifact?.html, "<b>x</b>");
  assert.equal(artifact?.title, "T");
  session.close();
});

test("a mirafold call without a recognizable ack falls back to the tool record", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    snap({
      type: "tool",
      id: "t1",
      tool: "mirafold_render_card",
      state: { status: "error", input: { title: "Hi" }, error: "invalid props" },
    }),
    idle(),
  );
  await awaitTurnEnd();
  assert.equal(msgs.some((m) => m.type === "render"), false);
  assert.equal(msgs.find((m) => m.type === "tool_use")?.name, "mirafold_render_card");
  const result = msgs.find((m) => m.type === "tool_result");
  assert.equal(result?.isError, true);
  assert.equal(result?.output, "invalid props");
  session.close();
});

test("permission ask bridges to the bar; allow replies `once` and resolves", async () => {
  const { session, fake, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(asked());
  await waitFor(() => msgs.some((m) => m.type === "permission_request"), "ask");
  const request = msgs.find((m) => m.type === "permission_request");
  assert.equal(request?.tool, "bash");
  assert.equal(request?.detail, "echo hi");
  session.resolvePermission("per1", true);
  await waitFor(() => fake.replies.length === 1, "engine reply");
  assert.deepEqual(fake.replies[0], { permissionID: "per1", response: "once" });
  const resolved = msgs.find((m) => m.type === "permission_resolved");
  assert.deepEqual({ id: resolved?.id, allow: resolved?.allow }, { id: "per1", allow: true });
  feed(idle());
  await awaitTurnEnd();
  session.close();
});

test("deny replies `reject`; a second answer for the same ask is a no-op", async () => {
  const { session, fake, msgs, prompt, feed } = makeSession();
  await prompt("hi");
  feed(asked());
  await waitFor(() => msgs.some((m) => m.type === "permission_request"), "ask");
  session.resolvePermission("per1", false);
  session.resolvePermission("per1", true); // stale — must not reach the engine
  await waitFor(() => fake.replies.length === 1, "engine reply");
  assert.deepEqual(fake.replies[0], { permissionID: "per1", response: "reject" });
  assert.equal(msgs.filter((m) => m.type === "permission_resolved").length, 1);
  session.close();
});

test("a failed permission reply reports beside the still-active engine turn", async () => {
  const { session, fake, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(asked());
  await waitFor(() => msgs.some((m) => m.type === "permission_request"), "ask");
  fake.failPermissionReply = new Error("permission endpoint unavailable");
  session.resolvePermission("per1", true);
  await waitFor(
    () => msgs.some((m) => m.type === "error" && /permission reply failed/.test(m.message)),
    "failed permission reply",
  );
  const error = msgs.find(
    (m): m is Extract<WireMsg, { type: "error" }> =>
      m.type === "error" && /permission reply failed/.test(m.message),
  );
  assert.equal(error?.terminal, false);
  assert.equal(msgs.some((m) => m.type === "turn_end"), false, "the engine turn is still open");

  feed(delta("answer", "still working"), idle());
  await awaitTurnEnd();
  assert.ok(msgs.some((m) => m.type === "text_delta" && m.text === "still working"));
  session.close();
});

test("an unanswered ask auto-denies on the timeout", async () => {
  const { session, fake, msgs, prompt, feed } = makeSession({ permissionTimeoutMs: 30 });
  await prompt("hi");
  feed(asked());
  await waitFor(() => fake.replies.length === 1, "timeout reply");
  assert.equal(fake.replies[0]?.response, "reject");
  assert.equal(msgs.find((m) => m.type === "permission_resolved")?.allow, false);
  session.close();
});

test("a reply observed on the stream (another client) resolves without an engine echo", async () => {
  const { session, fake, msgs, prompt, feed } = makeSession();
  await prompt("hi");
  feed(asked());
  await waitFor(() => msgs.some((m) => m.type === "permission_request"), "ask");
  feed(ev("permission.replied", { sessionID: SES, requestID: "per1", reply: "once" }));
  await waitFor(() => msgs.some((m) => m.type === "permission_resolved"), "resolution");
  assert.equal(fake.replies.length, 0, "no reply sent back at the engine");
  assert.equal(msgs.find((m) => m.type === "permission_resolved")?.allow, true);
  session.close();
});

test("the user message's own echoed parts never replay as output", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    // The stream announces the user message, then echoes its parts —
    // observed live (OC.2): snapshot AND delta forms both appear.
    ev("message.updated", { sessionID: SES, info: { id: "mu", role: "user", sessionID: SES } }),
    ev("message.part.updated", {
      sessionID: SES,
      part: { sessionID: SES, messageID: "mu", id: "pu", type: "text", text: "guidance + hi" },
    }),
    ev("message.part.delta", { sessionID: SES, messageID: "mu", partID: "pu", field: "text", delta: "more" }),
    assistant("ma", { input: 1, output: 1 }),
    ev("message.part.updated", {
      sessionID: SES,
      part: { sessionID: SES, messageID: "ma", id: "pa", type: "text", text: "real reply" },
    }),
    idle(),
  );
  await awaitTurnEnd();
  assert.deepEqual(
    msgs.filter((m) => m.type === "text_delta").map((m) => m.text),
    ["real reply"],
  );
  session.close();
});

test("an UNROUTABLE session's events are skipped whole (no spawn edge, no lane — SA.3 fallback)", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    ev("message.part.updated", {
      sessionID: "ses_child",
      part: { sessionID: "ses_child", messageID: "m9", id: "p9", type: "text", text: "child text" },
    }),
    ev("session.idle", { sessionID: "ses_child" }),
    idle(),
  );
  await awaitTurnEnd();
  assert.equal(msgs.some((m) => m.type === "text_delta"), false);
  assert.equal(msgs.filter((m) => m.type === "turn_end").length, 1);
  session.close();
});

// ---- SA.3: the subagent lane, proven against the SA.0 live capture. The
// fixture is a REAL `opencode serve` 1.18.18 subagent run recorded raw; ids
// (part, message, permission) are verbatim, sessions normalized.

function feedFixture(feed: (...evs: OpenCodeEvent[]) => void, rootAs: string) {
  for (const e of OPENCODE_SUBAGENT_EVENTS) {
    const rewritten = JSON.parse(
      JSON.stringify(e).replaceAll("ses_sa0probe00000000000root", rootAs),
    ) as OpenCodeEvent;
    feed(rewritten);
  }
}

const FIXTURE_CHILD = "ses_sa0probe0000000000child";

test("SA.3: the captured subagent run maps whole — spawn card anchor, parented calls and prose, ask surfaced, no early turn end", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("spawn the probe subagent");
  // The fixture's join key: the root task part that announced the child.
  const spawnEvent = OPENCODE_SUBAGENT_EVENTS.find((e) => {
    const part = (e.properties as Record<string, any>)["part"];
    return part?.tool === "task" && part?.state?.metadata?.sessionId === FIXTURE_CHILD;
  })!;
  const spawnPartId = (spawnEvent.properties as Record<string, any>)["part"]["id"] as string;
  feedFixture(feed, SES);
  await awaitTurnEnd();

  // The spawn announces un-parented — it IS the card anchor.
  const spawn = msgs.find((m) => m.type === "tool_use" && m.id === spawnPartId)!;
  assert.equal(spawn.name, "task");
  assert.equal(spawn.parentId, undefined);
  // The child's bash rides the lane, tagged with the spawn part id.
  const childBash = msgs.find((m) => m.type === "tool_use" && m.name === "bash")!;
  assert.equal(childBash.parentId, spawnPartId);
  assert.equal(
    msgs.find((m) => m.type === "tool_result" && m.id === childBash.id)?.parentId,
    spawnPartId,
  );
  // The child's prose rides too, parented (never as top-level transcript).
  const childProse = msgs.filter((m) => m.type === "text_delta" && m.parentId === spawnPartId);
  assert.ok(childProse.length >= 1, "child narration forwarded on the lane");
  assert.ok(
    childProse.some((m) => /CHILD DONE/.test(m.text)),
    "the child's own words arrived verbatim",
  );
  // The child's permission ask SURFACED, attributed to the card — before
  // SA.3 it was dropped whole and the subagent hung (SA.0 finding).
  const ask = msgs.find((m) => m.type === "permission_request")!;
  assert.equal(ask.tool, "bash");
  assert.equal(ask.parentId, spawnPartId);
  // The fixture's own reply event resolves it (another-client path).
  assert.ok(msgs.some((m) => m.type === "permission_resolved" && m.id === ask.id));
  // The child's session.idle must NOT have ended the turn — exactly one
  // turn_end, and it comes after the parent's own idle.
  assert.equal(msgs.filter((m) => m.type === "turn_end").length, 1);
  session.close();
});

test("a background child stays routable ACROSS turns — its ask surfaces instead of hanging (bughunt 2026-08-14)", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("spawn a background task");
  // Turn 1: the spawn edge is learned, the parent turn completes.
  feed(
    ev("message.part.updated", {
      sessionID: SES,
      part: {
        sessionID: SES,
        messageID: "m1",
        id: "prt_bg",
        type: "tool",
        tool: "task",
        callID: "c1",
        state: {
          status: "completed",
          input: { description: "bg child" },
          output: "started in background",
          metadata: { sessionId: "ses_bg", parentSessionId: SES, background: true },
        },
      },
    }),
    ev("session.created", { sessionID: "ses_bg", info: { id: "ses_bg", parentID: SES } }),
    idle(),
  );
  await awaitTurnEnd();
  // Turn 2 begins (startTurn resets the per-turn maps); only NOW does the
  // still-running background child ask and speak. Before the fix the lane
  // maps cleared with the turn and both events were dropped — the ask hang.
  await prompt("meanwhile…");
  feed(
    ev("permission.asked", {
      sessionID: "ses_bg",
      id: "per_bg1",
      permission: "bash",
      patterns: ["touch x"],
    }),
    ev("message.part.updated", {
      sessionID: "ses_bg",
      part: { sessionID: "ses_bg", messageID: "m9", id: "p9", type: "text", text: "still working" },
    }),
    idle(),
  );
  await awaitTurnEnd(2);
  const ask = msgs.find((m) => m.type === "permission_request" && m.id === "per_bg1")!;
  assert.equal(ask.parentId, "prt_bg", "the cross-turn ask surfaced, attributed to its deck");
  assert.ok(
    msgs.some((m) => m.type === "text_delta" && m.parentId === "prt_bg" && /still working/.test(m.text)),
    "the cross-turn prose still routes to the deck",
  );
  session.close();
});

test("SA.3: a grandchild resolves transitively to the nearest stream-visible card", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("go");
  feed(
    // Root spawns a child (task part metadata = the join key)…
    ev("message.part.updated", {
      sessionID: SES,
      part: {
        sessionID: SES,
        messageID: "m1",
        id: "prt_spawn",
        type: "tool",
        tool: "task",
        callID: "c1",
        state: {
          status: "running",
          input: { description: "child" },
          metadata: { sessionId: "ses_kid", parentSessionId: SES },
        },
      },
    }),
    ev("session.created", { sessionID: "ses_kid", info: { id: "ses_kid", parentID: SES } }),
    // …and the child (user-configured nesting) spawns a grandchild.
    ev("session.created", { sessionID: "ses_grand", info: { id: "ses_grand", parentID: "ses_kid" } }),
    ev("message.part.updated", {
      sessionID: "ses_grand",
      part: {
        sessionID: "ses_grand",
        messageID: "m2",
        id: "prt_g1",
        type: "tool",
        tool: "grep",
        callID: "c2",
        state: { status: "completed", input: { pattern: "x" }, output: "hit" },
      },
    }),
    idle(),
  );
  await awaitTurnEnd();
  // The grandchild's call lands on the CHILD's card — the nearest
  // stream-visible ancestor — documented degradation, never breakage.
  const grand = msgs.find((m) => m.type === "tool_use" && m.id === "prt_g1")!;
  assert.equal(grand.parentId, "prt_spawn");
  session.close();
});

test("SA.3: a subagent's render call gets the honest tool record, never a painting", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("go");
  feed(
    ev("message.part.updated", {
      sessionID: SES,
      part: {
        sessionID: SES,
        messageID: "m1",
        id: "prt_spawn",
        type: "tool",
        tool: "task",
        callID: "c1",
        state: {
          status: "running",
          input: { description: "child" },
          metadata: { sessionId: "ses_kid", parentSessionId: SES },
        },
      },
    }),
    ev("message.part.updated", {
      sessionID: "ses_kid",
      part: {
        sessionID: "ses_kid",
        messageID: "m2",
        id: "prt_r1",
        type: "tool",
        tool: "mirafold_render_card",
        callID: "c2",
        state: {
          status: "completed",
          input: { title: "T", body: "B" },
          output: "rendered mirafold-id=abc123",
        },
      },
    }),
    idle(),
  );
  await awaitTurnEnd();
  assert.equal(msgs.some((m) => m.type === "render"), false, "no painting from inside a card");
  const row = msgs.find((m) => m.type === "tool_use" && m.id === "prt_r1")!;
  assert.equal(row.parentId, "prt_spawn");
  assert.ok(msgs.some((m) => m.type === "tool_result" && m.id === "prt_r1" && m.parentId === "prt_spawn"));
  session.close();
});

test("usage sums the turn's assistant messages and rides just before turn_end", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    assistant("a1", { input: 11, output: 0 }, "laguna-s-2.1", 0.01),
    assistant("a2", { input: 20, output: 5 }, "laguna-s-2.1", 0.02),
    idle(),
  );
  await awaitTurnEnd();
  const usage = msgs.find((m) => m.type === "usage");
  assert.deepEqual(
    { model: usage?.model, input: usage?.inputTokens, output: usage?.outputTokens },
    { model: "laguna-s-2.1", input: 31, output: 5 },
  );
  assert.ok(Math.abs((usage?.costUsd ?? 0) - 0.03) < 1e-9);
  // Qualified form: bare ids are ambiguous across providers, and the
  // checkpointed modelName must round-trip parseModelPin on restore.
  assert.equal(session.modelName, "fake/laguna-s-2.1", "modelName refined, provider-qualified");
  assert.ok(
    msgs.findIndex((m) => m.type === "usage") < msgs.findIndex((m) => m.type === "turn_end"),
  );
  session.close();
});

test("session.error surfaces and ends the turn exactly once", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    ev("session.error", { sessionID: SES, error: { name: "ProviderError", data: { message: "no key" } } }),
    idle(), // late idle after the error must not double-end
  );
  await awaitTurnEnd();
  assert.match(msgs.find((m) => m.type === "error")?.message ?? "", /no key/);
  assert.equal(msgs.filter((m) => m.type === "turn_end").length, 1);
  session.close();
});

test("render guidance rides the first accepted turn only", async () => {
  const { session, fake, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("first");
  feed(idle());
  await awaitTurnEnd();
  await prompt("second");
  feed(idle());
  await awaitTurnEnd(2);
  const text = (p: Record<string, unknown>) =>
    (p["parts"] as { text: string }[])[0]?.text ?? "";
  assert.ok(text(fake.prompts[0]).startsWith(RENDER_GUIDANCE));
  assert.ok(text(fake.prompts[0]).endsWith("first"));
  assert.equal(text(fake.prompts[1]), "second");
  session.close();
});

test("a failed prompt surfaces honestly and frees the queue for the next turn", async () => {
  const { session, fake, msgs, feed, awaitTurnEnd } = makeSession();
  fake.failPrompt = new Error("HTTP 500: kaput");
  session.pushPrompt("first");
  await waitFor(() => msgs.some((m) => m.type === "error"), "error");
  await awaitTurnEnd();
  assert.match(msgs.find((m) => m.type === "error")?.message ?? "", /kaput/);
  fake.failPrompt = undefined;
  session.pushPrompt("second");
  await waitFor(() => fake.prompts.length === 1, "second prompt");
  feed(idle());
  await awaitTurnEnd(2);
  session.close();
});

test("a model pin is provider/model per prompt; a bare id falls back to the config default", async () => {
  const pinned = makeSession({ model: "prov1/laguna-s-2.1-free" });
  pinned.fake.catalog = [{ id: "prov1", source: "api" }];
  await pinned.prompt("hi");
  assert.deepEqual(pinned.fake.prompts[0]?.["model"], {
    providerID: "prov1",
    modelID: "laguna-s-2.1-free",
  });
  assert.equal(pinned.session.modelName, "prov1/laguna-s-2.1-free");
  pinned.session.close();

  // A bare id can't name a provider — the user's own opencode config default
  // resolves instead (inherit, never invent), and the prompt pins THAT.
  const bare = makeSession({ model: "laguna-s-2.1-free" });
  await bare.prompt("hi");
  assert.deepEqual(bare.fake.prompts[0]?.["model"], {
    providerID: "fake",
    modelID: "fake-model",
  });
  bare.session.close();
});

test("policy refusals at start: each names its reason and frees the turn", async () => {
  const cases: {
    catalog?: FakeTransport["catalog"];
    cfgModel?: string;
    model?: string;
    expect: RegExp;
  }[] = [
    // no pin anywhere
    { cfgModel: undefined, expect: /no model is pinned/i },
    // pinned provider not connected
    { model: "ghost/some-model", expect: /isn't connected in opencode/ },
    // a non-openai subscription OAuth — fail-closed
    {
      model: "github-copilot/gpt-5",
      catalog: [{ id: "github-copilot", source: "custom", apiKeyOption: "opencode-oauth-dummy-key" }],
      expect: /API key/,
    },
  ];
  for (const c of cases) {
    const { session, fake, msgs, awaitTurnEnd } = makeSession({ model: c.model });
    if (c.catalog) fake.catalog = c.catalog;
    fake.cfgModel = "cfgModel" in c ? c.cfgModel : fake.cfgModel;
    session.pushPrompt("hi");
    await waitFor(() => msgs.some((m) => m.type === "error"), `refusal for ${c.expect}`);
    await awaitTurnEnd();
    assert.match(msgs.find((m) => m.type === "error")?.message ?? "", c.expect);
    assert.equal(fake.sessionsCreated, 0, "no engine session before the policy gate");
    assert.equal(fake.prompts.length, 0, "no prompt reaches a refused provider");
    session.close();
  }
});

test("/model with no arg paints the picker from allowed providers only", async () => {
  const { session, fake, msgs, feed, awaitTurnEnd } = makeSession();
  fake.catalog = [
    { id: "fake", source: "config" },
    { id: "deepseek", source: "api" },
    { id: "opencode", source: "custom", apiKeyOption: "public" }, // Zen — open (2026-08-13), so offered
    { id: "github-copilot", source: "custom", apiKeyOption: "opencode-oauth-dummy-key" }, // blocked — never offered
  ];
  fake.models = [
    { providerID: "fake", modelID: "fake-model" },
    { providerID: "deepseek", modelID: "deepseek-v4" },
    { providerID: "opencode", modelID: "laguna-s-2.1-free" },
    { providerID: "github-copilot", modelID: "gpt-5" },
  ];
  session.pushPrompt("/model");
  await awaitTurnEnd();
  const picker = msgs.find((m) => m.type === "picker");
  assert.deepEqual(
    picker?.rows.map((r: { label: string }) => r.label),
    ["fake/fake-model", "deepseek/deepseek-v4", "opencode/laguna-s-2.1-free"],
  );
  // /model runs on the ENGINE latch alone (so it can rescue a pinless
  // session) — before any turn adopts a pin, no row is current yet.
  assert.equal(picker?.rows.some((r: { current?: boolean }) => r.current), false);

  // After a turn adopts the config default, the picker marks it.
  session.pushPrompt("hi");
  await waitFor(() => fake.prompts.length === 1, "prompt");
  feed(idle());
  await awaitTurnEnd(2);
  session.pushPrompt("/model");
  await awaitTurnEnd(3);
  const second = msgs.filter((m) => m.type === "picker").at(-1);
  assert.equal(
    second?.rows.find((r: { current?: boolean }) => r.current)?.label,
    "fake/fake-model",
  );
  session.close();
});

test("/model switches to an allowed provider; a blocked pick refuses and keeps the pin", async () => {
  const { session, fake, msgs, feed, awaitTurnEnd } = makeSession();
  fake.catalog = [
    { id: "fake", source: "config" },
    { id: "deepseek", source: "api" },
    { id: "github-copilot", source: "custom", apiKeyOption: "opencode-oauth-dummy-key" },
  ];
  session.pushPrompt("/model deepseek/deepseek-v4");
  await awaitTurnEnd();
  assert.ok(msgs.some((m) => m.type === "text_delta" && /Model set to deepseek/.test(m.text)));
  assert.equal(session.modelName, "deepseek/deepseek-v4");

  session.pushPrompt("/model github-copilot/gpt-5");
  await awaitTurnEnd(2);
  assert.match(msgs.find((m) => m.type === "error")?.message ?? "", /API key/);
  assert.equal(session.modelName, "deepseek/deepseek-v4", "blocked pick must not move the pin");

  session.pushPrompt("hi");
  await waitFor(() => fake.prompts.length === 1, "prompt");
  assert.deepEqual(fake.prompts[0]?.["model"], { providerID: "deepseek", modelID: "deepseek-v4" });
  feed(idle());
  await awaitTurnEnd(3);
  session.close();
});

test("/agent paints user-facing primaries only; a pick rides subsequent prompts", async () => {
  const { session, fake, msgs, feed, awaitTurnEnd } = makeSession();
  session.pushPrompt("/agent");
  await awaitTurnEnd();
  const picker = msgs.find((m) => m.type === "picker");
  assert.deepEqual(
    picker?.rows.map((r: { label: string }) => r.label),
    ["build", "plan"],
    "hidden primaries and subagents never offered",
  );
  assert.equal(picker?.rows.find((r: { current?: boolean }) => r.current)?.label, "build");

  session.pushPrompt("/agent plan");
  await awaitTurnEnd(2);
  assert.ok(msgs.some((m) => m.type === "text_delta" && /Agent set to plan/.test(m.text)));
  session.pushPrompt("hi");
  await waitFor(() => fake.prompts.length === 1, "prompt");
  assert.equal(fake.prompts[0]?.["agent"], "plan");
  feed(idle());
  await awaitTurnEnd(3);
  session.close();
});

test("an engine command routes to the engine's dispatcher with pin and agent", async () => {
  const { session, fake, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("warm up"); // learns the engine command catalog
  feed(idle());
  await awaitTurnEnd();
  session.pushPrompt("/agent plan");
  await awaitTurnEnd(2);
  session.pushPrompt("/init focus on tests");
  await waitFor(() => fake.commands.length === 1, "engine command dispatch");
  assert.deepEqual(fake.commands[0], {
    name: "init",
    args: "focus on tests",
    opts: { model: "fake/fake-model", agent: "plan" },
  });
  feed(idle());
  await awaitTurnEnd(3);
  assert.equal(fake.prompts.length, 1, "the command never rides as prompt text");
  session.close();
});

test("prompt options: our re-skins immediately, the engine catalog behind them", async () => {
  const { session, fake, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("warm up");
  feed(idle());
  await awaitTurnEnd();
  session.refreshPromptOptions();
  await waitFor(
    () =>
      msgs.some(
        (m) => m.type === "prompt_options" && m.options.some((o: { value: string }) => o.value === "/init"),
      ),
    "engine catalog options",
  );
  const options = msgs.filter((m) => m.type === "prompt_options").at(-1)?.options as {
    value: string;
    source?: string;
  }[];
  assert.deepEqual(
    options.map((o) => o.value),
    ["/model", "/agent", "/init"],
  );
  assert.equal(options.find((o) => o.value === "/init")?.source, "opencode");
  assert.equal(options.find((o) => o.value === "/model")?.source, undefined, "our re-skin, no badge");
  assert.equal(fake.commands.length, 0);
  session.close();
});

test("OC.4c: gray/gateway providers RUN, publish their true kind, and disclose once", async () => {
  const cases = [
    {
      model: "openai/gpt-5.5",
      catalog: [
        { id: "openai", source: "custom" as const, apiKeyOption: "opencode-oauth-dummy-key" },
      ],
      kind: "subscription",
      disclosure: /not clearly\s+permitted .* your account, your\s+call/s,
    },
    {
      model: "opencode/big-pickle",
      catalog: [{ id: "opencode", source: "custom" as const, apiKeyOption: "public" }],
      kind: "gateway",
      disclosure: /improve the model/,
    },
  ];
  for (const c of cases) {
    const { session, fake, msgs, prompt, feed, awaitTurnEnd } = makeSession({ model: c.model });
    fake.catalog = c.catalog;
    const published: { kind: string; provider?: string }[] = [];
    session.onBackendKind?.((u) => published.push(u));
    await prompt("hi");
    feed(idle());
    await awaitTurnEnd();
    assert.deepEqual(published, [{ kind: c.kind, provider: c.catalog[0].id }]);
    const notices = msgs.filter((m) => m.type === "notice");
    assert.equal(notices.length, 1, "the disclosure rides exactly once");
    assert.match(notices[0].text, c.disclosure);
    assert.equal(notices[0].source, undefined, "Mirafold-composed — no engine badge");
    // A second turn must not re-disclose.
    await prompt("again");
    feed(idle());
    await awaitTurnEnd(2);
    assert.equal(msgs.filter((m) => m.type === "notice").length, 1);
    session.close();
  }
});

test("OC.4c: an api-key provider publishes api-key; a /model switch re-publishes", async () => {
  const { session, fake, msgs, prompt, feed, awaitTurnEnd } = makeSession({
    model: "deepseek/deepseek-v4",
  });
  fake.catalog = [
    { id: "deepseek", source: "api" },
    { id: "opencode", source: "custom", apiKeyOption: "public" },
  ];
  fake.models = [
    { providerID: "deepseek", modelID: "deepseek-v4" },
    { providerID: "opencode", modelID: "big-pickle" },
  ];
  const published: { kind: string; provider?: string }[] = [];
  session.onBackendKind?.((u) => published.push(u));
  await prompt("hi");
  feed(idle());
  await awaitTurnEnd();
  assert.deepEqual(published, [{ kind: "api-key", provider: "deepseek" }]);
  session.pushPrompt("/model opencode/big-pickle");
  await awaitTurnEnd(2);
  assert.deepEqual(published.at(-1), { kind: "gateway", provider: "opencode" });
  assert.ok(
    msgs.some((m) => m.type === "notice" && /improve the model/.test(m.text)),
    "the switch to Zen carries its disclosure",
  );
  session.close();
});

test("an allowed stored-key provider runs; the refusal latch retries after a fix", async () => {
  const { session, fake, msgs, feed, awaitTurnEnd } = makeSession({ model: "deepseek/deepseek-v4" });
  fake.catalog = []; // not connected yet
  session.pushPrompt("hi");
  await waitFor(() => msgs.some((m) => m.type === "error"), "first refusal");
  await awaitTurnEnd();
  fake.catalog = [{ id: "deepseek", source: "api" }]; // user connected it
  session.pushPrompt("hi again");
  await waitFor(() => fake.prompts.length === 1, "prompt after fix");
  feed(idle());
  await awaitTurnEnd(2);
  assert.deepEqual(fake.prompts[0]?.["model"], { providerID: "deepseek", modelID: "deepseek-v4" });
  session.close();
});

test("resume: an existing engine session id is reattached, a dead one recreated", async () => {
  const alive = makeSession({ resumeId: SES });
  alive.fake.existing.add(SES);
  const seen: string[] = [];
  alive.session.onResumeId((id) => seen.push(id));
  await alive.prompt("hi");
  assert.equal(alive.session.resumeId, SES);
  alive.session.close();

  const dead = makeSession({ resumeId: "ses_gone" });
  await dead.prompt("hi");
  assert.equal(dead.session.resumeId, SES, "fresh engine session replaces the dead id");
  dead.session.close();
  assert.ok(seen.includes(SES));
});

test("interrupt aborts the engine turn and denies the pending ask", async () => {
  const { session, fake, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(asked());
  await waitFor(() => msgs.some((m) => m.type === "permission_request"), "ask");
  session.interrupt();
  await waitFor(() => fake.aborts === 1, "abort");
  assert.equal(fake.replies[0]?.response, "reject");
  assert.equal(msgs.find((m) => m.type === "permission_resolved")?.allow, false);
  feed(idle()); // the engine's own idle after abort ends the turn
  await awaitTurnEnd();
  session.close();
});

test("close releases an in-flight turn and shuts the transport", async () => {
  const { session, fake, msgs, prompt } = makeSession();
  await prompt("hi");
  session.close();
  await waitFor(() => fake.closed, "transport closed");
  // turn_end is not emitted post-close (no listeners should hear a ghost);
  // the internal latch is released so the worker exits.
  assert.equal(msgs.some((m) => m.type === "turn_end"), false);
});

test("the render MCP injects additively through config content", () => {
  const { session, fake } = makeSession();
  const mcp = (fake.configContent?.["mcp"] ?? {}) as Record<string, Record<string, unknown>>;
  assert.equal(mcp["mirafold"]?.["type"], "local");
  assert.ok(Array.isArray(mcp["mirafold"]?.["command"]));
  assert.equal(mcp["mirafold"]?.["environment"], undefined, "ordinary Node adds no Electron override");
  session.close();
});

test("OpenCode maps Electron Node mode to the local MCP `environment` field", () => {
  const childEnv = { ELECTRON_RUN_AS_NODE: "1" };
  const mcp = openCodeRenderMcpConfig({
    command: "/runtime/Mirafold",
    args: ["/app/render-mcp.js"],
    childEnv,
  });
  assert.deepEqual(mcp, {
    type: "local",
    command: ["/runtime/Mirafold", "/app/render-mcp.js"],
    environment: childEnv,
    enabled: true,
  });
  assert.equal("env" in mcp, false, "OpenCode does not accept the Codex/Gemini field name");
});

test("BUGFIX: /model rescues a PINLESS session instead of dying on the pin gate", async () => {
  const { session, fake, msgs, feed, awaitTurnEnd } = makeSession();
  fake.cfgModel = undefined; // no OPENCODE_MODEL, no config default
  fake.catalog = [{ id: "deepseek", source: "api" }];
  fake.models = [{ providerID: "deepseek", modelID: "deepseek-v4" }];
  session.pushPrompt("/model deepseek/deepseek-v4");
  await awaitTurnEnd();
  assert.equal(
    msgs.some((m) => m.type === "error" && /no model is pinned/.test(m.message)),
    false,
    "the rescue command must not hit the no-pin gate it exists to fix",
  );
  assert.ok(msgs.some((m) => m.type === "text_delta" && /Model set to deepseek/.test(m.text)));
  session.pushPrompt("hi");
  await waitFor(() => fake.prompts.length === 1, "prompt after rescue");
  assert.deepEqual(fake.prompts[0]?.["model"], { providerID: "deepseek", modelID: "deepseek-v4" });
  feed(idle());
  await awaitTurnEnd(2);
  session.close();
});

test("BUGFIX: one transport start per engine, even across policy-failure retries", async () => {
  const { session, fake, msgs, feed, awaitTurnEnd } = makeSession();
  let starts = 0;
  const origStart = fake.start.bind(fake);
  fake.start = async (cb) => {
    starts += 1;
    return origStart(cb);
  };
  fake.cfgModel = undefined; // first prompt fails the pin gate AFTER start
  session.pushPrompt("first");
  await waitFor(() => msgs.some((m) => m.type === "error"), "pin refusal");
  await awaitTurnEnd();
  fake.cfgModel = "fake/fake-model"; // user fixed their config
  session.pushPrompt("second");
  await waitFor(() => fake.prompts.length === 1, "prompt after fix");
  feed(idle());
  await awaitTurnEnd(2);
  assert.equal(starts, 1, "a policy retry must never respawn the engine");
  session.close();
});

test("BUGFIX: an interrupt during startup cancels the send — no ghost turn", async () => {
  const { session, fake, feed, awaitTurnEnd } = makeSession();
  let releaseStart: () => void = () => {};
  const origStart = fake.start.bind(fake);
  fake.start = async (cb) => {
    await new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    return origStart(cb);
  };
  session.pushPrompt("doomed");
  // Interrupt while the engine is still cold-starting: the turn ends now…
  await waitFor(() => (session as unknown as { turnActive: boolean }).turnActive, "turn active");
  session.interrupt();
  await awaitTurnEnd();
  releaseStart();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake.prompts.length, 0, "the cancelled prompt must never reach the engine");
  // …and the NEXT prompt still carries the first-turn guidance (not burned).
  session.pushPrompt("real first");
  await waitFor(() => fake.prompts.length === 1, "the real first prompt");
  const text = (fake.prompts[0]?.["parts"] as { text: string }[])[0]?.text ?? "";
  assert.ok(text.startsWith(RENDER_GUIDANCE), "guidance survives the cancelled ghost");
  feed(idle());
  await awaitTurnEnd(2);
  session.close();
});

test("BUGFIX: a FAILED abort leaves the turn open for the engine's own idle", async () => {
  const { session, fake, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  fake.abort = async () => {
    throw new Error("HTTP 500");
  };
  await prompt("hi");
  session.interrupt();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    msgs.filter((m) => m.type === "turn_end").length,
    0,
    "a failed abort means the engine is STILL RUNNING — ending now interleaves streams",
  );
  feed(idle()); // the engine eventually finishes on its own
  await awaitTurnEnd();
  session.close();
});

test("BUGFIX3: an abort request that never settles still reaches the interrupt deadline", async () => {
  const { session, fake, msgs, prompt, feed, awaitTurnEnd } = makeSession({
    interruptGraceMs: 20,
  });
  fake.abort = async () => {
    fake.aborts++;
    await new Promise<void>(() => {});
  };
  await prompt("turn A");
  session.interrupt();
  await awaitTurnEnd();
  assert.equal(fake.aborts, 1);
  assert.deepEqual(fake.forks, [SES], "the missed idle retires A's ambiguous session id");

  session.pushPrompt("turn B");
  await waitFor(() => fake.prompts.length === 2, "B sent on recovered session");
  const recoveredID = fake.promptSessionIDs[1];
  assert.notEqual(recoveredID, SES);
  feed(idle(SES)); // A's eventual idle is now unambiguously stale.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(msgs.filter((m) => m.type === "turn_end").length, 1);
  feed(idle(recoveredID));
  await awaitTurnEnd(2);
  session.close();
});

test("BUGFIX3: abort success without an idle forks context before the next turn", async () => {
  const { session, fake, msgs, prompt, feed, awaitTurnEnd } = makeSession({
    interruptGraceMs: 20,
  });
  await prompt("turn A");
  session.interrupt(); // fake abort resolves, but the engine emits no idle
  await awaitTurnEnd();
  assert.deepEqual(fake.forks, [SES]);

  session.pushPrompt("turn B");
  await waitFor(() => fake.prompts.length === 2, "B sent on fork");
  const recoveredID = fake.promptSessionIDs[1];
  feed(idle(recoveredID));
  await awaitTurnEnd(2);
  assert.equal(msgs.filter((m) => m.type === "turn_end").length, 2);
  session.close();
});

test("BUGFIX3: an unavailable fork falls back to a disclosed fresh session", async () => {
  const { session, fake, msgs, prompt, feed, awaitTurnEnd } = makeSession({
    interruptGraceMs: 20,
  });
  fake.forkSession = async (id) => {
    fake.forks.push(id);
    throw new Error("HTTP 404");
  };
  fake.uniqueSessionIDs = true;
  await prompt("turn A");
  session.interrupt();
  await awaitTurnEnd();

  session.pushPrompt("turn B");
  await waitFor(() => fake.prompts.length === 2, "B sent on fresh session");
  assert.equal(fake.promptSessionIDs[1], `${SES}_2`);
  assert.ok(
    msgs.some(
      (m) =>
        m.type === "notice" &&
        /fresh engine context/.test(m.text),
    ),
  );
  const text = (fake.prompts[1]?.["parts"] as { text: string }[])[0]?.text ?? "";
  assert.ok(text.startsWith(RENDER_GUIDANCE), "a fresh engine session receives fresh guidance");
  assert.ok(text.includes(MIRAFOLD_CONTEXT), "the environment fact rides the guidance");
  feed(idle(`${SES}_2`));
  await awaitTurnEnd(2);
  session.close();
});

test("BUGFIX: a turn's end denies its pending ask — no stale resolution later", async () => {
  const { session, fake, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(asked(), ev("session.error", { sessionID: SES, error: { name: "boom" } }));
  await awaitTurnEnd();
  const resolved = msgs.find((m) => m.type === "permission_resolved");
  assert.deepEqual({ id: resolved?.id, allow: resolved?.allow }, { id: "per1", allow: false });
  assert.equal(fake.replies.length, 0, "the engine moved on — no pointless reject reply");
  session.close();
});

test("BUGFIX2: a stale idle from an errored turn never ends the NEXT turn", async () => {
  const { session, fake, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("turn A");
  // A ends via session.error — but the engine still owes A's idle.
  feed(ev("session.error", { sessionID: SES, error: { name: "boom" } }));
  await awaitTurnEnd();
  session.pushPrompt("turn B");
  await waitFor(() => fake.prompts.length === 2, "B sent");
  feed(idle()); // A's LATE idle — must pay the debt, not end B
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(msgs.filter((m) => m.type === "turn_end").length, 1, "B must still be open");
  feed(snap({ type: "text", text: "B's reply", id: "pb" }), idle()); // B's own idle
  await awaitTurnEnd(2);
  assert.ok(
    msgs.findIndex((m) => m.type === "text_delta" && m.text === "B's reply") <
      msgs.map((m) => m.type).lastIndexOf("turn_end"),
    "B's output lands inside B's envelope",
  );
  session.close();
});

test("BUGFIX2: error→idle keeps usage INSIDE the turn envelope", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    assistant("a1", { input: 9, output: 4 }),
    ev("session.error", { sessionID: SES, error: { name: "ProviderError", data: { message: "no key" } } }),
  );
  await awaitTurnEnd();
  feed(idle()); // the engine's late idle after the error
  await new Promise((resolve) => setTimeout(resolve, 50));
  const kinds = msgs.map((m) => m.type);
  const usageAt = kinds.indexOf("usage");
  assert.ok(usageAt >= 0, "partial tokens are still honest usage");
  assert.ok(usageAt < kinds.indexOf("turn_end"), "usage rides before turn_end, never after");
  assert.equal(kinds.filter((k) => k === "usage").length, 1, "and never re-fires between turns");
  session.close();
});

test("BUGFIX2: tool ERROR output is capped with honest truncation", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    snap({
      type: "tool",
      id: "t1",
      tool: "bash",
      state: { status: "error", input: {}, error: "E".repeat(200_000) },
    }),
    idle(),
  );
  await awaitTurnEnd();
  const result = msgs.find((m) => m.type === "tool_result");
  assert.equal(result?.isError, true);
  assert.ok(result!.output.length < 200_000, "error text passes the byte cap");
  assert.ok((result?.truncatedBytes ?? 0) > 0, "the elision is reported, never silent");
  session.close();
});

test("BUGFIX2: engine death mid-turn surfaces, ends the turn, and the next prompt respawns", async () => {
  const { session, fake, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  let starts = 0;
  let died: ((detail: string) => void) | undefined;
  const origStart = fake.start.bind(fake);
  fake.start = async (cb: (ev: OpenCodeEvent) => void, onDied?: (detail: string) => void) => {
    starts += 1;
    died = onDied;
    return origStart(cb);
  };
  await prompt("hi");
  died?.("opencode serve exited unexpectedly (SIGKILL)");
  await awaitTurnEnd();
  assert.match(msgs.find((m) => m.type === "error")?.message ?? "", /exited unexpectedly/);
  session.pushPrompt("after the crash");
  await waitFor(() => fake.prompts.length === 2, "post-crash prompt");
  assert.equal(starts, 2, "the crash resets the latch — a fresh engine spawns");
  feed(idle());
  await awaitTurnEnd(2);
  session.close();
});

test("BUGFIX2: a slash input waits for the catalog — a restored /init never goes as prose", async () => {
  const { session, fake, feed, awaitTurnEnd } = makeSession();
  // First-ever input IS the advertised engine command (the restored-session
  // shape: checkpointed prompt options replayed before the engine started).
  session.pushPrompt("/init focus");
  await waitFor(() => fake.commands.length === 1, "engine dispatch");
  assert.deepEqual(fake.commands[0].name, "init");
  assert.equal(fake.prompts.length, 0, "never sent to the model as prose");
  feed(idle());
  await awaitTurnEnd();
  session.close();
});

test("BUGFIX2: a reasoning part whose delta beat its snapshot recovers the lane", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    delta("r9", "early "), // no snapshot yet — defaults to the text lane
    ev("message.part.updated", {
      sessionID: SES,
      part: { sessionID: SES, messageID: "m1", id: "r9", type: "reasoning", text: "early thoughts" },
    }),
    idle(),
  );
  await awaitTurnEnd();
  assert.ok(
    msgs.some((m) => m.type === "thinking_delta" && m.text === "thoughts"),
    "the authoritative snapshot corrects the stream's lane",
  );
  session.close();
});

test("AUDIT: the minted server password is redacted from a stderr tail (pure)", async () => {
  // The redactor is a pure exported helper — test it on real inputs, no
  // reaching into a live transport's private state.
  const { redactSecret } = await import("./opencode-client");
  const secret = "deadbeefdeadbeefdeadbeefdeadbeef";
  const out = redactSecret(`panic: OPENCODE_SERVER_PASSWORD=${secret} in a log line`, secret);
  assert.ok(!out.includes(secret), "the minted password never rides an error string");
  assert.ok(out.includes("[redacted]"));
  // Two occurrences both go; an empty secret is a no-op (pre-mint path).
  assert.equal(redactSecret(`${secret} and ${secret}`, secret), "[redacted] and [redacted]");
  assert.equal(redactSecret("nothing to redact", ""), "nothing to redact");
});

test("a fragmented oversized SSE frame is rejected promptly", async () => {
  const transport = new OpenCodeServerProcess({
    bin: "unused",
    cwd: tmp,
    configContent: {},
  });
  const internals = transport as unknown as {
    base: string;
    auth: string;
    generation: number;
    stderrTail: string;
    pumpEvents(
      onEvent: (event: OpenCodeEvent) => void,
      generation: number,
      maxFrameChars?: number,
    ): Promise<void>;
  };
  internals.base = "http://opencode.test";
  internals.auth = "Basic test";
  internals.generation = 1;
  const seen: OpenCodeEvent[] = [];
  const realFetch = globalThis.fetch;
  const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
  let sent = 0;
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(sent++ < 512 ? chunk : new Uint8Array([120]));
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof fetch;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      internals.pumpEvents((event) => seen.push(event), 1),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("fragmented frame rejection timed out")), 2_000);
      }),
    ]);
    assert.deepEqual(seen, []);
    assert.match(internals.stderrTail, /size limit/);
  } finally {
    if (timeout) clearTimeout(timeout);
    globalThis.fetch = realFetch;
    transport.close();
  }
});

test("SSE frames parse across a split boundary and line-dense metadata", async () => {
  const transport = new OpenCodeServerProcess({
    bin: "unused",
    cwd: tmp,
    configContent: {},
  });
  const internals = transport as unknown as {
    base: string;
    auth: string;
    generation: number;
    pumpEvents(
      onEvent: (event: OpenCodeEvent) => void,
      generation: number,
      maxFrameChars?: number,
    ): Promise<void>;
  };
  internals.base = "http://opencode.test";
  internals.auth = "Basic test";
  internals.generation = 1;
  const encoder = new TextEncoder();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('\ndata: {"type":"one","properties":{}}\n'));
        controller.enqueue(
          encoder.encode(
            `\nevent: message\n${"x\n".repeat(512 * 1024)}data: {"type":"two","properties":{}}\n\n`,
          ),
        );
        controller.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const seen: OpenCodeEvent[] = [];
  try {
    await internals.pumpEvents((event) => {
      seen.push(event);
      if (seen.length === 2) transport.close();
    }, 1);
    assert.deepEqual(
      seen.map((event) => event.type),
      ["one", "two"],
    );
  } finally {
    globalThis.fetch = realFetch;
    transport.close();
  }
});

test("an oversized SSE frame kills the child before cancelling the stream", async () => {
  const transport = new OpenCodeServerProcess({
    bin: "unused",
    cwd: tmp,
    configContent: {},
  });
  const internals = transport as unknown as {
    base: string;
    auth: string;
    child: { kill(signal?: NodeJS.Signals): boolean };
    generation: number;
    pumpEvents(
      onEvent: (event: OpenCodeEvent) => void,
      generation: number,
      maxFrameChars?: number,
    ): Promise<void>;
  };
  internals.base = "http://opencode.test";
  internals.auth = "Basic test";
  internals.generation = 1;
  let killed = false;
  let killSignal: NodeJS.Signals | undefined;
  let killedBeforeCancel = false;
  internals.child = {
    kill(signal) {
      killed = true;
      killSignal ??= signal;
      return true;
    },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(65)));
      },
      cancel() {
        killedBeforeCancel = killed;
        return new Promise<void>(() => {});
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      internals.pumpEvents(() => {}, 1, 64),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("event pump awaited cancellation")), 500);
      }),
    ]);
    assert.equal(killed, true);
    assert.equal(killSignal, "SIGKILL");
    assert.equal(killedBeforeCancel, true);
  } finally {
    if (timeout) clearTimeout(timeout);
    globalThis.fetch = realFetch;
    transport.close();
  }
});

test("an explicit failure of the injected renderer aborts OpenCode startup", async () => {
  const transport = new OpenCodeServerProcess({
    bin: "unused",
    cwd: tmp,
    configContent: { mcp: { [MIRAFOLD_MCP]: { type: "local", command: ["unused"] } } },
  });
  const internals = transport as unknown as {
    base: string;
    auth: string;
    waitForInjectedMcp(deadline: number): Promise<void>;
  };
  internals.base = "http://opencode.test";
  internals.auth = "Basic test";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        [MIRAFOLD_MCP]: {
          status: "failed",
          error: "handshaking with MCP server failed: connection closed",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    await assert.rejects(
      internals.waitForInjectedMcp(Date.now() + 1_000),
      /Mirafold render tools failed to start.*connection closed/,
    );
  } finally {
    globalThis.fetch = realFetch;
    transport.close();
  }
});

test("an injected renderer that never connects fails OpenCode startup at the deadline", async () => {
  const transport = new OpenCodeServerProcess({
    bin: "unused",
    cwd: tmp,
    configContent: { mcp: { [MIRAFOLD_MCP]: { type: "local", command: ["unused"] } } },
  });
  const internals = transport as unknown as {
    base: string;
    auth: string;
    waitForInjectedMcp(deadline: number): Promise<void>;
  };
  internals.base = "http://opencode.test";
  internals.auth = "Basic test";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ [MIRAFOLD_MCP]: { status: "connecting" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    await assert.rejects(
      internals.waitForInjectedMcp(Date.now() + 10),
      /Mirafold render tools did not connect/,
    );
  } finally {
    globalThis.fetch = realFetch;
    transport.close();
  }
});

test("AUDIT: a permission-ask flood auto-denies past the cap — observable at the wire", async () => {
  const { session, fake, msgs, prompt } = makeSession({ permissionTimeoutMs: 60_000 });
  await prompt("hi");
  for (let i = 0; i < 200; i++) fake.onEvent(asked(`per-flood-${i}`));
  await waitFor(() => fake.replies.length > 0, "the cap starts auto-denying");
  // Observable signal of the cap: at most 64 asks ever surface to the browser
  // as a permission_request; the rest are rejected at the engine, never shown.
  const shown = msgs.filter((m) => m.type === "permission_request").length;
  assert.ok(shown <= 64, `permission_requests bounded at the cap, saw ${shown}`);
  assert.equal(shown + fake.replies.length, 200, "every ask is either shown or engine-rejected");
  assert.ok(fake.replies.every((r) => r.response === "reject"), "overflow asks reject at the engine");
  session.close();
});

test("AUDIT: a part-id flood is bounded within one turn — observable at the wire", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  for (let i = 0; i < 5_000; i++) {
    feed(snap({ type: "text", text: "x", id: `flood-${i}` }));
  }
  // Observable signal: a dropped part relays no text, so the count of
  // text_delta messages is bounded by the per-turn part cap.
  const emitted = msgs.filter((m) => m.type === "text_delta").length;
  assert.ok(emitted <= 2_000, `relayed parts bounded at the cap, saw ${emitted}`);
  assert.ok(emitted > 0, "parts under the cap still stream");
  feed(idle());
  await awaitTurnEnd();
  session.close();
});

test("AUDIT: an oversized engine command catalog is capped to what a checkpoint can hold", async () => {
  const { session, fake, prompt, feed, awaitTurnEnd } = makeSession();
  fake.engineCommands = Array.from({ length: 900 }, (_, i) => ({ name: `cmd${i}` }));
  await prompt("hi"); // ensureStarted loads (and now caps) the catalog
  feed(idle());
  await awaitTurnEnd();
  const cmds = (session as unknown as { engineCommands: unknown[] }).engineCommands;
  assert.ok(cmds.length <= 500, `advertised commands capped, saw ${cmds.length}`);
  session.close();
});

test("RC: verifyBackendKind resolves only after the truthful kind published", async () => {
  const { session } = makeSession({ model: "fake/fake-model" });
  const published: { kind: string }[] = [];
  session.onBackendKind?.((u) => published.push(u));
  await session.verifyBackendKind?.();
  assert.deepEqual(published, [{ kind: "local", provider: "fake" }]);
  session.close();
});

test("RC: verifyBackendKind rejects with the honest reason and stays retryable", async () => {
  const { session, fake } = makeSession({ model: "missing/nope" });
  await assert.rejects(session.verifyBackendKind!(), /isn't connected in opencode/);
  // The same honest failure repeats (latch reset), and a fixed catalog recovers.
  await assert.rejects(session.verifyBackendKind!(), /isn't connected in opencode/);
  fake.catalog = [{ id: "missing", source: "config" }];
  await session.verifyBackendKind!();
  assert.equal(fake.sessionsCreated, 1, "recovered into a real engine session");
  session.close();
});

// ── The folder-trust gate (audit 2026-08-26): `opencode serve` applies the
// folder's own opencode.json — any MCP command it names — the moment it
// starts (probed: it ran at session create). No spawn before the ask.
test("an untrusted folder asks before `opencode serve` starts; a no spawns nothing, a yes starts it", async () => {
  const ws = mkdtempSync(path.join(os.tmpdir(), "mcp-opencode-untrusted-"));
  const fake = new FakeTransport();
  let starts = 0;
  const originalStart = fake.start.bind(fake);
  fake.start = async (cb) => {
    starts++;
    await originalStart(cb);
  };
  const session = new OpenCodeSession({ workspaceDir: ws, makeTransport: () => fake });
  const msgs: Any[] = [];
  session.onMessage((m) => msgs.push(m as Any));
  try {
    session.refreshPromptOptions(); // what the registry does at create — must not spawn
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(starts, 0, "the catalog refresh spawns nothing in an untrusted folder");
    session.pushPrompt("hello");
    await waitFor(() => msgs.some((m) => m.type === "permission_request"), "the trust ask");
    const ask = msgs.find((m) => m.type === "permission_request")!;
    assert.equal(ask.tool, "OpenCode");
    assert.match(ask.detail, /trust this folder/);
    assert.match(ask.detail, /opencode\.json/);
    assert.equal(starts, 0, "nothing spawned while the ask is open");
    session.resolvePermission(ask.id, false);
    await waitFor(() => msgs.some((m) => m.type === "turn_end"), "turn_end after the no");
    assert.ok(msgs.some((m) => m.type === "notice" && /haven't trusted/.test(m.text)));
    assert.ok(!msgs.some((m) => m.type === "error"), "a no is a notice, never a red error");
    assert.equal(starts, 0);

    msgs.length = 0;
    session.pushPrompt("again");
    await waitFor(() => msgs.some((m) => m.type === "permission_request"), "asked again");
    session.resolvePermission(msgs.find((m) => m.type === "permission_request")!.id, true);
    await waitFor(() => starts === 1, "the engine starts on the yes");
    await waitFor(() => fake.prompts.length === 1, "the prompt reaches the engine");
  } finally {
    session.close();
    rmSync(ws, { recursive: true, force: true });
  }
});

test("TS.7: an event or part kind the mapper cannot place is reported once per session, never dropped silently", async () => {
  const { session, msgs, prompt, feed, awaitTurnEnd } = makeSession();
  await prompt("hi");
  feed(
    ev("question.v3.asked", { sessionID: SES }),
    ev("question.v3.asked", { sessionID: SES }), // once per kind
    ev("server.heartbeat", {}), // deliberately ignored: no notice
    snap({ type: "hologram", data: 1 }), // unknown message part
    snap({ type: "text", text: "hi" }),
    idle(),
  );
  await awaitTurnEnd();
  const notices = () => msgs.filter((m) => m.type === "notice").map((m) => [m.text, m.source]);
  assert.deepEqual(notices(), [
    ["Mirafold doesn't display this OpenCode event yet: question.v3.asked", undefined],
    ["Mirafold doesn't display this OpenCode message part yet: hologram", undefined],
  ]);
  // The dedup is session-lifetime, not per turn: the same kind in a LATER
  // turn stays silent (cold review 2026-08-31: a per-turn reporter reset
  // survived every prior test).
  await prompt("again");
  feed(ev("question.v3.asked", { sessionID: SES }), idle());
  await awaitTurnEnd(2);
  assert.equal(notices().length, 2, "a later turn re-reports nothing");
  session.close();
});
