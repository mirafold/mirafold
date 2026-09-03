import { MIRAFOLD_MCP } from "../render-mcp-cmd";

/**
 * Codex reaches MCP tools three different ways depending on its version and
 * provider, and a model that cannot see a tool will not paint with it:
 *  - listed directly in the tool list (custom/local providers);
 *  - deferred behind `tool_search` (OpenAI provider, Codex ≤0.149 —
 *    openai/codex#29486 made that unconditional and removed the opt-out);
 *  - reachable only inside the `exec` JavaScript runtime as
 *    `tools.mcp__<server>__<tool>(args)`, discovered through `ALL_TOOLS`
 *    (OpenAI provider, Codex ≥0.147; read from the rollouts 2026-08-30).
 * Measured on Kyle's August rollouts (Codex 0.147–0.151, ~1,400 work
 * prompts): 15 paintings — the model almost never went looking. So this
 * note rides at the TOP of the developer instructions, names all three
 * paths with the exact call shapes, and makes loading a render tool the
 * first step of any reply with a structured core. It also states the failure
 * boundary literally: discovery is one pass, and resource-list APIs are not
 * tool discovery. The note rides only on thread start.
 */
export const CODEX_DEFERRED_TOOLS_ADDENDUM = `
## Mirafold's render tools: where they are, and load them first (important)

The render_* tools and emit_artifact described below live on the
\`${MIRAFOLD_MCP}\` MCP server. They are available only after the
\`${MIRAFOLD_MCP}\` MCP server starts. Mirafold requires that server before
this thread can run, but Codex may expose its tools through different surfaces.
Check the surfaces relevant to this session once, in this order:
1. If they appear in your tool list, call them directly.
2. If your tool list has \`tool_search\`, they are DEFERRED behind it: call
   tool_search with the tool's name (for example {"query": "render_table"}),
   then call the loaded tool.
3. If your tools are exposed through the \`exec\` JavaScript runtime, they are
   in it as \`tools.mcp__${MIRAFOLD_MCP}__<name>\`. Find them with
   \`ALL_TOOLS.filter(t => t.name.startsWith("mcp__${MIRAFOLD_MCP}__"))\`, then
   call one like
   \`const r = await tools.mcp__${MIRAFOLD_MCP}__render_table({ columns, rows });\`
   and pass the returned \`r.content\` text to \`text(...)\`.
Never use \`list_mcp_resources\` or \`list_mcp_resource_templates\` to discover
tools: those APIs list MCP resources, not callable tools. If the render tools
are absent from every relevant surface above, stop; do not retry discovery.
Report that the Mirafold renderer is unavailable for this turn.

Do this in EVERY reply whose content has a structured core — a list, a table,
a comparison, key→value facts, code, a diff, command output, test results, a
chart, a file tree, a timeline, or a choice for the user to make: load the
matching render tool FIRST and paint with it; prose is only the connective
text around the painting. For ANY chart/plot/graph you MUST call
render_chart — hand-written mermaid, ASCII, or SVG charts render as plain
code here, never as visuals.`;
