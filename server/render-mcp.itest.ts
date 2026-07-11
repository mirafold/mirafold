import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { RENDER_TOOL_COMPONENT } from "./adapters/render-mcp-cmd";
import { parseRenderId } from "./adapters/gemini-cli";

// L.2e: the stdio render-MCP stub (render-mcp.ts) over a real MCP handshake —
// the process Codex/Gemini engines actually spawn. The adapters never see this
// process's output directly; they read the ack back off their engine's event
// stream, so what matters here is exactly the ack contract: the renderId in
// structuredContent (Codex's primary channel) AND in parseable text (the
// fallback both adapters share). Pinned to the TS source via tsx — the
// compiled twin is the same source, and a stale dist-server must not decide
// what this test observes.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type ToolResult = {
  isError?: boolean;
  structuredContent?: { renderId?: string };
  content?: { type: string; text?: string }[];
};

let client: Client;

before(async () => {
  client = new Client({ name: "mirafold-itest", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "server/render-mcp.ts"],
      cwd: ROOT,
    }),
  );
});
after(async () => {
  await client.close();
});

const ackText = (r: ToolResult) => r.content?.find((c) => c.type === "text")?.text ?? "";

test("advertises exactly the vocabulary the adapters key on, schemas straight from the registry spec", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    [...Object.keys(RENDER_TOOL_COMPONENT), "emit_artifact"].sort(),
  );
  // One source of truth: render_card's engine-side schema still requires body,
  // and the update-in-place id stays optional.
  const card = tools.find((t) => t.name === "render_card")!;
  const required = (card.inputSchema.required ?? []) as string[];
  assert.ok(required.includes("body"));
  assert.ok(!required.includes("id"));
});

test("render_card ack: a fresh id on BOTH adapter channels, and they agree", async () => {
  const r = (await client.callTool({
    name: "render_card",
    arguments: { title: "T", body: "b" },
  })) as ToolResult;
  assert.ok(!r.isError);
  const id = r.structuredContent?.renderId;
  assert.ok(id && id.length >= 8); // Codex's primary channel
  assert.equal(parseRenderId(ackText(r)), id); // Gemini's shipped text parser reads the same id
});

test("a caller-supplied id echoes back unchanged (update-in-place contract)", async () => {
  const r = (await client.callTool({
    name: "render_card",
    arguments: { title: "T", body: "b", id: "keep-me-1234" },
  })) as ToolResult;
  assert.equal(r.structuredContent?.renderId, "keep-me-1234");
});

test("engine-side validation: args that break the registry spec are rejected, never acked", async () => {
  const r = (await client
    .callTool({ name: "render_card", arguments: { title: "no body" } })
    .catch(() => ({ isError: true }))) as ToolResult;
  assert.ok(r.isError);
});

test("emit_artifact acks like the render tools", async () => {
  const r = (await client.callTool({
    name: "emit_artifact",
    arguments: { html: "<b>x</b>", title: "demo" },
  })) as ToolResult;
  assert.ok(!r.isError);
  assert.match(ackText(r), /Rendered artifact \(id: /);
  assert.equal(parseRenderId(ackText(r)), r.structuredContent?.renderId);
});
