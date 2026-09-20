// Model-free engine seam: the render acknowledgment comes from the actual
// compiled MCP child; the production Codex adapter consumes these events.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const config = {};
const args = process.argv.slice(2);
for (let i = 0; i < args.length - 1; i++) {
  if (args[i] !== "-c") continue;
  const argument = args[++i];
  const split = argument.indexOf("=");
  if (split > 0) config[argument.slice(0, split)] = JSON.parse(argument.slice(split + 1));
}
const commandKey = Object.keys(config).find((key) => /^mcp_servers\..*\.command$/.test(key));
let client;
let nextTurn = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const notify = (method, params) => send({ method, params });

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === "turn/start") {
    if (!client) {
      if (!commandKey) throw new Error("fixture did not receive the production MCP launch");
      client = new Client({ name: "component-chart-fixture", version: "1" });
      await client.connect(new StdioClientTransport({
        command: config[commandKey], args: config[commandKey.replace(/command$/, "args")], stderr: "pipe",
      }));
    }
    const id = `chart-turn-${++nextTurn}`;
    send({ id: request.id, result: { turn: { id } } });
    notify("turn/started", { threadId: "chart-fixture", turn: { id } });
    const stage = request.params.input[0].text;
    const props = {
      id: "retained-chart", title: stage === "corrected" ? "Corrected totals" : "Original totals",
      kind: "bar", stacked: true, x: ["A", "B"],
      series: [{ name: "Requests", values: stage === "invalid" ? [3, -2] : stage === "corrected" ? [4, 2] : [3, 2] }],
    };
    const item = { type: "mcpToolCall", id: `chart-call-${nextTurn}`, server: "mirafold", tool: "render_chart", arguments: props };
    notify("item/started", { threadId: "chart-fixture", turnId: id, item: { ...item, status: "inProgress" } });
    const result = await client.callTool({ name: "render_chart", arguments: props });
    appendFileSync(process.env.CU_CHART_RESULTS, JSON.stringify({ stage, result }) + "\n");
    notify("item/completed", { threadId: "chart-fixture", turnId: id, item: { ...item, status: result.isError ? "failed" : "completed", result } });
    notify("turn/completed", { threadId: "chart-fixture", turn: { id, status: "completed" } });
  } else {
    const result = request.method === "model/list" ? { data: [{ id: "fixture", displayName: "fixture", isDefault: true }] }
      : request.method === "thread/start" || request.method === "thread/resume" ? { thread: { id: "chart-fixture" }, model: "fixture" } : {};
    send({ id: request.id, result });
  }
}
await client?.close();
