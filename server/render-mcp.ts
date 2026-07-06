// Standalone stdio MCP server exposing genui-shell's generative-UI vocabulary
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
import { registryShapes, type ComponentName } from "./registry-spec";

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

const server = new McpServer({ name: "genui", version: "1.0.0" });

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

function registerRender(tool: string, component: ComponentName, description: string) {
  server.registerTool(
    tool,
    { description, inputSchema: { ...registryShapes[component], ...idParam } },
    // arg types collapse to a union across components via the helper; the id is
    // all we read here, and the engine already validated props against the schema.
    (async (args: { id?: string }) => ack(component, args.id)) as never,
  );
}

registerRender(
  "render_card",
  "card",
  "Show a card: a single highlight, summary, or verdict set off from the prose. " +
    "Prefer this to a bold paragraph when one point deserves a frame.",
);
registerRender(
  "render_list",
  "list",
  "Show a list component instead of a markdown bullet/numbered list.",
);
registerRender(
  "render_table",
  "table",
  "Show a table component instead of a markdown table.",
);
registerRender(
  "render_chart",
  "chart",
  "Show a chart for ANY plot/graph: line for trends over an ordered axis, bar " +
    "for category comparisons. Never hand-write SVG or ASCII charts — use this.",
);
registerRender(
  "render_links",
  "link-group",
  "Show a group of links instead of a bare pile of URLs.",
);

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
