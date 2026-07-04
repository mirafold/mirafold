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
  numbered list, render_links to a bare pile of links, and render_card for a
  single highlight, verdict, or summary worth setting off from the prose.
- Plain markdown remains right for code blocks, long-form prose, and anything
  with no fitting component.
- Every render_* result includes the component's id. Calling the same tool
  again with that id replaces that component's props in place — use it to keep
  one widget live (progress, updated stats) instead of stacking duplicates.
- Text inside component props supports inline markdown only where the prop
  description says so; keep it terse — components are for scanning, prose is
  for reading.`;

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
        "render_links",
        "Show a group of links in the output zone. Use for any collection of URLs worth clicking.",
        { ...registryShapes["link-group"], ...idParam },
        async ({ id, ...props }) => emitRender("link-group", id, props),
      ),
    ],
  });
}
