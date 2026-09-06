// A real spawned child at each production engine seam. It reads only its
// own launch metadata and its fresh fixture configuration, drives the actual
// bundled render-MCP child, then exercises the engine-failure path.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { observe } from "./desktop-observer.mjs";

const mode = process.argv[2];
const args = process.argv.slice(3);
const isCatalog = mode === "gemini" && args.includes("--acp") || mode === "codex" && !args.some((arg) => arg.startsWith("mcp_servers."));
observe(`${mode}${isCatalog ? "-catalog" : "-engine"}`);

if (mode === "pty") {
  process.stdout.write("Desktop child probe ");
  setTimeout(() => { process.stdout.write("completed\n"); process.exit(0); }, 5);
} else if (isCatalog) {
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += String(chunk);
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1);
      if (msg.id === undefined) continue;
      const result = msg.method === "session/new"
        ? { models: { availableModels: [{ modelId: "fixture", name: "fixture" }], currentModelId: "fixture" }
        } : msg.method === "model/list"
          ? { data: [{ id: "fixture", displayName: "fixture", isDefault: true }] } : {};
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
    }
  });
} else {
  let launch;
  if (mode === "codex") {
    const config = {};
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] !== "-c") continue;
      const split = args[++i].indexOf("=");
      if (split < 0) continue;
      config[args[i].slice(0, split)] = JSON.parse(args[i].slice(split + 1));
    }
    const key = Object.keys(config).find((key) => /^mcp_servers\..*\.command$/.test(key));
    if (key) launch = { command: config[key], args: config[key.replace(/command$/, "args")] };
  } else if (mode === "gemini") {
    const settings = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".gemini/settings.json"), "utf8"));
    launch = Object.values(settings.mcpServers)[0];
  } else if (mode === "opencode") {
    const settings = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT);
    const mcp = Object.values(settings.mcp)[0];
    launch = { command: mcp.command[0], args: mcp.command.slice(1), env: mcp.environment };
  }
  if (launch) {
    const client = new Client({ name: "desktop-child-probe", version: "0.0.0" });
    const transport = new StdioClientTransport({
      command: launch.command,
      args: ["--import", fileURLToPath(new URL("./desktop-observer.mjs", import.meta.url)), ...launch.args],
      cwd: process.cwd(),
      env: { ...process.env, ...launch.env, MIRAFOLD_TEST_MCP_OBSERVER: "1" },
      stderr: "pipe",
    });
    await client.connect(transport);
    const reply = await client.callTool({ name: "render_card", arguments: { title: "child probe", body: "boundary checked" } });
    if (reply.isError) throw new Error("real render-MCP rejected the probe");
    fs.writeFileSync(path.join(process.env.MIRAFOLD_TEST_CAPTURE, `mcp-ack-${mode}-${process.pid}.json`), JSON.stringify({ mode, acknowledged: true }));
    await client.close();
  }
  // The production adapters assemble this split stderr into their own error
  // report, then broadcast and checkpoint it. No provider is ever contacted.
  process.stderr.write("Desktop child ");
  setTimeout(() => { process.stderr.write("probe failure\n"); process.exit(17); }, 5);
}
