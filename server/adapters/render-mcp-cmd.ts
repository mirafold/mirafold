import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ComponentName } from "../registry-spec";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The server name the adapters register the render MCP under — it's how
 *  their event streams recognize our tool calls among the agent's own. */
export const GENUI_MCP = "genui";

/** render_* tool name → the registry component a call to it paints. */
export const RENDER_TOOL_COMPONENT: Record<string, ComponentName> = {
  render_card: "card",
  render_list: "list",
  render_table: "table",
  render_chart: "chart",
  render_links: "link-group",
};

/**
 * How to spawn the stdio render-MCP server (server/render-mcp.ts) for engines
 * that load MCP servers as subprocesses (Codex, Gemini CLI). Two homes:
 * - Packaged install (4.10): the esbuild bundle emits render-mcp.js BESIDE
 *   this code (dist-server/) — run it with the daemon's own node binary.
 * - Dev checkout: no compiled twin exists — run the TS source under the
 *   repo's tsx, exactly as before.
 */
export function renderMcpCommand(): { command: string; args: string[] } {
  const compiled = path.join(HERE, "render-mcp.js");
  if (existsSync(compiled)) return { command: process.execPath, args: [compiled] };
  return {
    command: path.resolve(HERE, "..", "..", "node_modules", ".bin", "tsx"),
    args: [path.resolve(HERE, "..", "render-mcp.ts")],
  };
}
