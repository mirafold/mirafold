import { MIRAFOLD_MCP } from "./render-mcp-cmd";

/**
 * OpenAI-provider models can defer MCP tools behind Codex's tool-search
 * mechanism, while custom providers receive those tools directly. This
 * conditional instruction is true in both configurations and rides only on
 * the session's first accepted turn.
 */
export const CODEX_DEFERRED_TOOLS_ADDENDUM = `
## Tool availability note (important)

The render_* tools and emit_artifact above live on the \`${MIRAFOLD_MCP}\` MCP
server. If they appear in your tool list, just call them directly. If they
do NOT appear, they are DEFERRED behind tool search: use tool search to load
them, then call them. Never conclude a render tool is unavailable without
checking your tool list and searching first. For ANY chart/plot/graph
request you MUST call render_chart — hand-written mermaid, ASCII, or SVG
charts render as plain code here, never as visuals.`;
