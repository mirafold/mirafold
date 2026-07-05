// Render tools — the agent's vocabulary for painting registry components.
// Each tool has NO side effects: calling it just emits a `render` WireMsg
// into the session's output stream, interleaved with the text deltas at the
// point of the call. The input schemas ARE the registry spec (Step 1.1),
// plus an optional `id` for update-in-place.

import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { WireMsg } from "./protocol";
import { registryShapes, type ComponentName } from "./registry-spec";
import { actionToolNames } from "./actions";

const idParam = {
  id: z
    .string()
    .optional()
    .describe(
      "Omit to render a new component. Pass an id returned by a previous " +
        "render_* call to update that component in place instead.",
    ),
};

/** Appended to the claude_code system-prompt preset (Session options). */
export const RENDER_GUIDANCE = `
## Generative UI

Your output renders in a web app whose output zone can mount real UI
components, not just markdown. The render_* tools paint a component inline at
the exact point in your reply where you call them, so you can mix prose and
components freely.

- Prefer render_table to a markdown table, render_list to a markdown bullet or
  numbered list, render_links to a bare pile of links, render_card for a
  single highlight, verdict, or summary worth setting off from the prose, and
  render_chart for ANY plot or graph (line for trends, bar for comparisons).
- You cannot emit raw HTML or SVG — the UI renders it as literal code, never
  as visuals. Never hand-write markup for something a render tool covers; if
  no component fits, say so in prose instead of improvising markup.
- Plain markdown remains right for code blocks, long-form prose, and anything
  with no fitting component.
- Every render_* result includes the component's id. Calling the same tool
  again with that id replaces that component's props in place — use it to keep
  one widget live (progress, updated stats) instead of stacking duplicates.
- Text inside component props supports inline markdown only where the prop
  description says so; keep it terse — components are for scanning, prose is
  for reading.
- render_card can carry up to 3 \`actions\` buttons. kind "prompt" sends its
  text as the user's next turn when clicked (offer these for the obvious
  drill-down asks — you will answer them in this same session); kind "tool"
  runs a server-side helper — allowlisted names: ${actionToolNames.join(", ")}.
  Never promise a button behavior outside these two kinds.`;

export function makeRenderServer(emit: (msg: WireMsg) => void) {
  const emitRender = (component: ComponentName, id: string | undefined, props: object) => {
    const renderId = id ?? randomUUID();
    emit({ type: "render", component, props: props as Record<string, unknown>, id: renderId });
    return {
      content: [{ type: "text" as const, text: `Rendered ${component} (id: ${renderId})` }],
    };
  };

  return createSdkMcpServer({
    name: "ui",
    version: "1.0.0",
    tools: [
      tool(
        "render_card",
        "Show a card in the output zone: a single highlight, summary, or verdict set off from the prose.",
        { ...registryShapes.card, ...idParam },
        async ({ id, ...props }) => emitRender("card", id, props),
      ),
      tool(
        "render_list",
        "Show a list component in the output zone. Use instead of a markdown bullet/numbered list.",
        { ...registryShapes.list, ...idParam },
        async ({ id, ...props }) => emitRender("list", id, props),
      ),
      tool(
        "render_table",
        "Show a table component in the output zone. Use instead of a markdown table.",
        { ...registryShapes.table, ...idParam },
        async ({ id, ...props }) => emitRender("table", id, props),
      ),
      tool(
        "render_chart",
        "Show a chart in the output zone: line for trends over an ordered axis, bar for category comparisons. Use for ANY plot/graph — never hand-write SVG or ASCII charts.",
        { ...registryShapes.chart, ...idParam },
        async ({ id, ...props }) => emitRender("chart", id, props),
      ),
      tool(
        "render_links",
        "Show a group of links in the output zone. Use for any collection of URLs worth clicking.",
        { ...registryShapes["link-group"], ...idParam },
        async ({ id, ...props }) => emitRender("link-group", id, props),
      ),
    ],
  });
}
