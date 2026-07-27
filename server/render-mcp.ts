// Standalone stdio MCP server exposing Mirafold's generative-UI vocabulary
// (render_* + emit_artifact) to agents that load MCP servers as subprocesses —
// Codex today (Gemini CLI next). The Claude adapter injects the same tools
// IN-PROCESS via makeRenderServer (render-tools.ts); this is the out-of-process
// twin for engines that only speak stdio MCP.
//
// Key design (P.3): this process is a THIN STUB. It can't reach into a session
// to emit a `render` WireMsg — it's a grandchild subprocess of the daemon. So it
// only (a) advertises the tool schemas so the agent knows the vocabulary and the
// agent's engine validates args, and (b) returns the component's id. The adapter
// (codex.ts) watches the agent's own `mcp_tool_call` event stream, reads the
// arguments, and synthesizes the render/artifact WireMsg into the right session —
// same event-normalization path it uses for every other Codex item. The id is
// returned here (structuredContent + parseable text) so the agent can re-use it
// for update-in-place and the adapter paints the same id the agent will re-send.
//
// Schemas ARE the registry spec (registryShapes), so there is one source of
// truth across the in-process and stdio servers. No secrets, no session state.

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { renderToolEntries, type RenderToolName } from "./adapters/render-mcp-cmd";
import { registryShapes } from "./registry-spec";

const idParam = {
  id: z
    .string()
    .optional()
    .describe(
      "Omit for a new component. To UPDATE a component you rendered earlier " +
        "(e.g. live progress), pass the id you were given for it — its props " +
        "are replaced in place instead of stacking a duplicate.",
    ),
};

const server = new McpServer({ name: "mirafold", version: "1.0.0" });

// Returned to the agent AND read back by the adapter (codex.ts) off the
// mcp_tool_call result. structuredContent is the primary channel; the text is a
// parseable fallback in case an engine drops structured content.
function ack(kind: string, id: string | undefined) {
  const renderId = id ?? randomUUID();
  return {
    content: [{ type: "text" as const, text: `Rendered ${kind} (id: ${renderId})` }],
    structuredContent: { renderId },
  };
}

// This server's voice for each tool in the shared vocabulary
// (RENDER_TOOL_COMPONENT). The strings are model-visible prompt surface —
// change them deliberately, never as a side effect.
const TOOL_DESCRIPTIONS: Record<RenderToolName, string> = {
  render_card:
    "Show a card: a single highlight, summary, or verdict set off from the prose. " +
    "Prefer this to a bold paragraph when one point deserves a frame.",
  render_list: "Show a list component instead of a markdown bullet/numbered list.",
  render_table: "Show a table component instead of a markdown table.",
  render_chart:
    "Show a chart for ANY plot/graph: line for trends over an ordered axis, bar " +
    "for category comparisons, pie for one part-of-whole split (exactly 1 series, " +
    "≤6 slices read best). Bar options: stacked=true for part-to-whole columns; " +
    "horizontal=true for long/many category names. Pre-bin distributions into bar " +
    "buckets yourself. Never hand-write SVG or ASCII charts — use this.",
  render_links: "Show a group of links instead of a bare pile of URLs.",
  render_keyvalue:
    "Show a two-column key/value fact sheet: config, environment, any name→value facts.",
  render_progress:
    "Show a progress bar for long-running work. Re-call with the same id to advance it in place.",
  render_timeline:
    "Show an ordered timeline of events or stages — use when the sequence itself is the point.",
  render_filetree: "Show a file/directory tree. Never hand-draw ASCII trees — use this.",
  render_question:
    "Ask a structured question with 2–6 clickable options; a click sends that option as the user's next turn. Not for open-ended questions.",
  render_diff:
    "Show a red/green line diff of a code change. Per file, pass the relevant before and after lines verbatim (no +/- prefixes); the client computes the diff.",
  render_stat:
    "Show a single-number KPI tile (coverage %, p95, cost, a count) with an optional " +
    "up/down change. Re-call with the same id to update the number in place.",
  render_code:
    "Show a block of code with a filename/language header and copy button. For a change " +
    "to an existing file prefer render_diff (before/after); use this for code that is " +
    "not a before/after — a new file's contents, a snippet you're explaining, an " +
    "example, a config block.",
  render_statuslist:
    "Show labeled rows each with a pass/fail/warn/pending/skip status pill — test " +
    "suites, CI checks, lint rules, health probes.",
  render_console:
    "Show terminal output you're quoting (build log excerpt, failing test output, " +
    "stack trace): optional command header, ANSI colors rendered, exit-code badge. " +
    "Quote the relevant excerpt, not a whole log. For code itself use render_code.",
  render_image:
    "Show a raster image from the workspace inline: pass the FILE PATH " +
    "(png/jpeg/gif/webp, ≤2 MB), e.g. a screenshot you just saved — the daemon " +
    "inlines the bytes; never encode them yourself. Use for anything visual you " +
    "produce or verify: app screenshots, rendered pages, plots saved to disk.",
};

for (const [name, component] of renderToolEntries) {
  server.registerTool(
    name,
    { description: TOOL_DESCRIPTIONS[name], inputSchema: { ...registryShapes[component], ...idParam } },
    // arg types collapse to a union across components; the id is all we read
    // here, and the engine already validated props against the schema.
    (async (args: { id?: string }) => ack(component, args.id)) as never,
  );
}

server.registerTool(
  "emit_artifact",
  {
    description:
      "Render self-contained HTML/CSS/JS in a locked-down sandboxed iframe. LAST " +
      "RESORT — use only when no render_* component fits (custom visuals, " +
      "simulations, bespoke interactivity). A strict CSP blocks ALL network and " +
      "there is no storage; style for a dark background (#141a26).",
    inputSchema: {
      html: z
        .string()
        .describe("Body markup only (host supplies <html>/<head>); inline <style>/<script> ok."),
      title: z.string().optional().describe("Short label for the artifact's chrome bar."),
      id: z.string().optional().describe("Pass a prior artifact's id to replace it in place."),
    },
  },
  async ({ id }) => ack("artifact", id),
);

await server.connect(new StdioServerTransport());
