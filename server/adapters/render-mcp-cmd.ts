import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WireMsg } from "../protocol";
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

/** Matches the component id inside the render-MCP stub's ack text
 *  ("Rendered card (id: …)") — the fallback channel when an engine drops
 *  structured content. */
export const RENDER_ID_RE = /id:\s*([0-9a-fA-F-]{8,})/;

/**
 * The render/artifact WireMsg a genui MCP tool call stands for (P.3/P.5):
 * the stub only validated the args and returned the id — the adapter watching
 * the agent's own event stream paints the message here. Returns null for an
 * unknown genui tool (ignore rather than paint junk).
 */
export function generativeUIMsg(
  tool: string,
  params: Record<string, unknown>,
  id: string,
): WireMsg | null {
  const props = { ...params };
  delete props["id"];
  if (tool === "emit_artifact") {
    return {
      type: "artifact",
      html: typeof props["html"] === "string" ? (props["html"] as string) : "",
      id,
      title: typeof props["title"] === "string" ? (props["title"] as string) : undefined,
    };
  }
  const component = RENDER_TOOL_COMPONENT[tool];
  return component ? { type: "render", component, props, id } : null;
}

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
