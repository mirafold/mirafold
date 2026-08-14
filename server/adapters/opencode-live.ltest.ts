import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { WireMsg } from "../protocol";
import { OpenCodeSession } from "./opencode";
import { OpenCodeServerProcess } from "./opencode-client";
import { waitFor } from "../testing/wait-for";

// Tier 4 — the REAL opencode binary, driven end to end (PLAN OC.5).
//
// Tier 1 hand-feeds captured event shapes; this tier proves the actual
// engine still speaks them: `opencode serve` spawned by the production
// transport, the render MCP injected through OPENCODE_CONFIG_CONTENT, a
// permission ask surfacing headless and answered through the production
// bridge, and engine-side session persistence carrying a resume.
//
// The codex-tier bound holds: real binary, yes; real HOSTED model, never.
// The model is a scripted OpenAI-compatible endpoint on loopback (the OC.2
// probe recipe): deterministic turns, zero network, zero spend. HOME and
// XDG are jailed to throwaway dirs so a real engine run never reads or
// writes the developer's own opencode state (config, auth, sessions).
//
// Skips cleanly when opencode isn't installed (OPENCODE_BIN or PATH).

function opencodeBin(): string | undefined {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const found = spawnSync("which", ["opencode"], { encoding: "utf8" });
  const bin = found.status === 0 ? found.stdout.trim() : "";
  return bin || undefined;
}

const BIN = opencodeBin();

type Any = WireMsg & Record<string, any>;

/** The scripted model: keeps requesting the render until its ack is in
 *  history (rides out the engine's cold first call carrying zero tools —
 *  see opencode.spike.md), then a permission-gated bash on the probe turn. */
function startFakeModel(): Promise<{ port: number; close: () => void }> {
  let n = 0;
  const sse = (res: http.ServerResponse, obj: unknown) =>
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      n++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: `c${n}`, object: "chat.completion.chunk", created: 1, model: "fake-model" };
      const messages: { role: string; content?: unknown }[] = JSON.parse(body || "{}").messages ?? [];
      const flat = JSON.stringify(messages);
      const toolCall = (name: string, args: unknown) => {
        sse(res, {
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  { index: 0, id: `call_${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      };
      const text = (content: string) => {
        sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] });
        sse(res, {
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        });
      };
      // Routing is by the LAST user message — the turn's actual prompt —
      // because with the SA.3 subagent turn in the transcript, whole-history
      // matching would misroute the resume turn.
      const lastUser = JSON.stringify(
        [...messages].reverse().find((m) => m.role === "user")?.content ?? "",
      );
      const renderDone = flat.includes("Rendered card");
      const probeTurn = flat.includes("probe command");
      const bashDone = messages.some(
        (m) => m.role === "tool" && /oc5-live/.test(JSON.stringify(m.content ?? "")),
      );
      if (/CHILD_TASK/.test(lastUser)) {
        // The CHILD conversation (SA.3): a permission-gated bash, then its
        // report — narration the lane must carry.
        const childBashDone = messages.some(
          (m) => m.role === "tool" && /oc5-child/.test(JSON.stringify(m.content ?? "")),
        );
        if (!childBashDone) toolCall("bash", { command: "echo oc5-child", description: "child probe" });
        else text("CHILD DONE — reporting back from inside the subagent.");
      } else if (/spawn the subagent/.test(lastUser)) {
        if (!flat.includes("CHILD DONE"))
          toolCall("task", {
            description: "live probe child",
            prompt: "CHILD_TASK: run the child probe exactly once, then stop.",
            subagent_type: "general",
          });
        else text("FANOUT DONE");
      } else if (!renderDone) toolCall("mirafold_render_card", { title: "Live Probe", body: "OC.5 end to end" });
      else if (!probeTurn) text("CARD DONE");
      else if (!bashDone) toolCall("bash", { command: "echo oc5-live", description: "probe" });
      else text("BASH DONE");
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        close: () => server.close(),
      });
    });
  });
}

test("OC.5: real engine — render, permission, usage, resume, all through the shipped code", {
  skip: BIN ? false : "opencode is not installed (set OPENCODE_BIN or install it)",
  timeout: 180_000,
}, async () => {
  const model = await startFakeModel();
  const home = mkdtempSync(path.join(os.tmpdir(), "mirafold-oc5-home-"));
  const work = mkdtempSync(path.join(os.tmpdir(), "mirafold-oc5-work-"));
  mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  writeFileSync(
    path.join(home, ".config", "opencode", "opencode.json"),
    JSON.stringify({
      provider: {
        fake: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fake Local",
          options: { baseURL: `http://127.0.0.1:${model.port}/v1` },
          models: { "fake-model": { name: "Fake Model", tool_call: true } },
        },
      },
      permission: { bash: "ask" },
    }),
  );
  const jailedEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".state"),
  };
  const makeSession = (resumeId?: string) => {
    const session = new OpenCodeSession({
      workspaceDir: work,
      model: "fake/fake-model",
      resumeId,
      makeTransport: (config) =>
        new OpenCodeServerProcess({ bin: BIN as string, cwd: work, configContent: config, env: jailedEnv }),
    });
    const msgs: Any[] = [];
    session.onMessage((m) => msgs.push(m as Any));
    const turnEnds = () => msgs.filter((m) => m.type === "turn_end").length;
    return { session, msgs, turnEnds };
  };

  const first = makeSession();
  // On a live-tier timeout, dump the WireMsg types actually seen so a rare
  // timing wobble is diagnosable at a glance rather than a bare timeout
  // (test-audit 2026-08-13).
  const seenTypes = (s: { msgs: { type: string }[] }) =>
    "saw: " + (s.msgs.map((m) => m.type).join(",") || "nothing");
  try {
    const published: { kind: string; provider?: string }[] = [];
    first.session.onBackendKind?.((u) => published.push(u));

    // Turn 1: the render paints through the real MCP stub.
    first.session.pushPrompt("paint a card please");
    await waitFor(() => first.turnEnds() >= 1, "turn 1 (render)", 120_000, () => seenTypes(first));
    const render = first.msgs.find((m) => m.type === "render" && m.component === "card");
    assert.ok(render, "card rendered through the real engine");
    assert.equal(render?.props?.["title"], "Live Probe");
    assert.ok(first.msgs.some((m) => m.type === "text_delta" && /CARD DONE/.test(m.text)));
    const usage = first.msgs.find((m) => m.type === "usage");
    assert.ok((usage?.inputTokens ?? 0) > 0, "usage rode the turn");
    assert.deepEqual(published, [{ kind: "local", provider: "fake" }], "kind published (config → local)");

    // Turn 2: the permission round-trip, answered through the bridge.
    first.session.pushPrompt("now run the probe command");
    await waitFor(
      () => first.msgs.some((m) => m.type === "permission_request"),
      "the ask",
      60_000,
      () => seenTypes(first),
    );
    const ask = first.msgs.find((m) => m.type === "permission_request");
    assert.equal(ask?.tool, "bash");
    first.session.resolvePermission(ask!.id, true);
    await waitFor(() => first.turnEnds() >= 2, "turn 2 (bash)", 120_000, () => seenTypes(first));
    assert.ok(first.msgs.some((m) => m.type === "permission_resolved" && m.allow === true));
    assert.ok(
      first.msgs.some((m) => m.type === "tool_result" && /oc5-live/.test(m.output)),
      "the engine really ran the command",
    );
    // The fake provider is the user's own config — no gray disclosure rides.
    assert.equal(first.msgs.filter((m) => m.type === "notice").length, 0);

    // Turn 3 (SA.3): a REAL subagent — the engine's task tool spawns a child
    // session on the same server; its permission ask, calls, and prose all
    // ride the lane, attributed to the spawn card.
    first.session.pushPrompt("now spawn the subagent");
    await waitFor(
      () => first.msgs.some((m) => m.type === "permission_request" && m.parentId),
      "the child's attributed ask",
      60_000,
      () => seenTypes(first),
    );
    const childAsk = first.msgs.find((m) => m.type === "permission_request" && m.parentId)!;
    first.session.resolvePermission(childAsk.id, true);
    await waitFor(() => first.turnEnds() >= 3, "turn 3 (fan-out)", 120_000, () => seenTypes(first));
    const spawnRow = first.msgs.find((m) => m.type === "tool_use" && m.name === "task")!;
    assert.equal(spawnRow.parentId, undefined, "the spawn is the card anchor, un-nested");
    assert.equal(childAsk.parentId, spawnRow.id, "the ask is attributed to the spawn card");
    assert.ok(
      first.msgs.some((m) => m.type === "tool_use" && m.parentId === spawnRow.id && m.name === "bash"),
      "the child's bash rode the lane",
    );
    assert.ok(
      first.msgs.some(
        (m) => m.type === "text_delta" && m.parentId === spawnRow.id && /CHILD DONE/.test(m.text),
      ),
      "the child's narration rode the lane",
    );
    assert.ok(
      first.msgs.some((m) => m.type === "text_delta" && !m.parentId && /FANOUT DONE/.test(m.text)),
      "the parent's own reply stayed top-level",
    );

    // Resume: engine-side persistence across a full server restart.
    const resumeId = first.session.resumeId;
    assert.ok(resumeId, "the engine session id was published");
    first.session.close();

    const second = makeSession(resumeId);
    try {
      second.session.pushPrompt("still with me?");
      await waitFor(() => second.turnEnds() >= 1, "resumed turn", 120_000, () => seenTypes(second));
      assert.equal(second.session.resumeId, resumeId, "reattached, not recreated");
      assert.ok(second.msgs.some((m) => m.type === "text_delta" && /BASH DONE/.test(m.text)));
    } finally {
      second.session.close();
    }
  } finally {
    first.session.close();
    model.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
