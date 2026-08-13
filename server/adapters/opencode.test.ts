import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync } from "node:fs";
import type { WireMsg } from "../protocol";
import { RENDER_GUIDANCE } from "../render-tools";
import { OpenCodeSession } from "./opencode";
import type { OpenCodeEvent, OpenCodeTransport } from "./opencode-client";

// OC.1: the OpenCode event→WireMsg mapping and the turn grammar, on synthetic
// events whose shapes are the OC.0 live capture (opencode.spike.md) — no
// engine, no network. The session is real; only the transport is a fake, so
// the whole worker → runTurn → mapper path runs as shipped.

type Any = WireMsg & Record<string, any>;

const tmp = mkdtempSync(path.join(os.tmpdir(), "mcp-opencode-test-"));
const SES = "ses_test";

const waitFor = (cond: () => boolean, what: string, timeoutMs = 5_000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (cond()) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, 5);
  });

class FakeTransport implements OpenCodeTransport {
  onEvent: (ev: OpenCodeEvent) => void = () => {};
  prompts: Record<string, unknown>[] = [];
  aborts = 0;
  replies: { permissionID: string; response: string }[] = [];
  closed = false;
  existing = new Set<string>();
  failPrompt?: Error;
  configContent?: Record<string, unknown>;
  // OC.3 classification inputs — defaults let a pinless session resolve the
  // user's config default onto an allowed BYO provider.
  catalog: Awaited<ReturnType<OpenCodeTransport["providerCatalog"]>> = [
    { id: "fake", source: "config" },
  ];
  cfgModel: string | undefined = "fake/fake-model";
  sessionsCreated = 0;
  async start(cb: (ev: OpenCodeEvent) => void) {
    this.onEvent = cb;
  }
  async providerCatalog() {
    return this.catalog;
  }
  async configModel() {
    return this.cfgModel;
  }
  async createSession() {
    this.sessionsCreated++;
    return { id: SES };
  }
  async sessionExists(id: string) {
    return this.existing.has(id);
  }
  async prompt(_sessionID: string, body: Record<string, unknown>) {
    if (this.failPrompt) throw this.failPrompt;
    this.prompts.push(body);
  }
  async abort(_sessionID: string) {
    this.aborts++;
  }
  async replyPermission(_sessionID: string, permissionID: string, response: "once" | "reject") {
    this.replies.push({ permissionID, response });
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
const idle = () => ev("session.idle", { sessionID: SES });
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

test("subagent child-session events are skipped whole", async () => {
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
  assert.equal(session.modelName, "laguna-s-2.1", "modelName refined from the engine");
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
  assert.equal(pinned.session.modelName, "laguna-s-2.1-free");
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
    // the openai gray area: allowed by policy, refused until OC.4 wires kind
    {
      model: "openai/gpt-5.5",
      catalog: [{ id: "openai", source: "custom", apiKeyOption: "opencode-oauth-dummy-key" }],
      expect: /ChatGPT login .* isn't wired up/,
    },
    // the built-in Zen gateway — terms unread, fail-closed
    {
      model: "opencode/big-pickle",
      catalog: [{ id: "opencode", source: "custom", apiKeyOption: "public" }],
      expect: /Zen/,
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
  session.close();
});
