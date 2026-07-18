// Render tools — the agent's vocabulary for painting registry components.
// Each tool has NO side effects: calling it just emits a `render` WireMsg
// into the session's output stream, interleaved with the text deltas at the
// point of the call. The input schemas ARE the registry spec (Step 1.1),
// plus an optional `id` for update-in-place.

import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { renderToolEntries, type RenderToolName } from "./adapters/render-mcp-cmd";
import type { WireMsg } from "./protocol";
import { registryShapes, type ComponentName } from "./registry-spec";
import { actionToolNames } from "./sessions/actions";

const idParam = {
  id: z
    .string()
    .optional()
    .describe(
      "Omit to render a new component. Pass an id returned by a previous " +
        "render_* call to update that component in place instead.",
    ),
};

// This server's voice for each tool in the shared vocabulary
// (RENDER_TOOL_COMPONENT). The strings are model-visible prompt surface —
// change them deliberately, never as a side effect.
const TOOL_DESCRIPTIONS: Record<RenderToolName, string> = {
  render_card:
    "Show a card in the output zone: a single highlight, summary, or verdict set off from the prose.",
  render_list:
    "Show a list component in the output zone. Use instead of a markdown bullet/numbered list.",
  render_table: "Show a table component in the output zone. Use instead of a markdown table.",
  render_chart:
    "Show a chart in the output zone: line for trends over an ordered axis, bar for category comparisons. Use for ANY plot/graph — never hand-write SVG or ASCII charts.",
  render_links:
    "Show a group of links in the output zone. Use for any collection of URLs worth clicking.",
  render_keyvalue:
    "Show a two-column key/value fact sheet in the output zone. Use for config dumps, environment summaries, or any set of name→value facts.",
  render_progress:
    "Show a progress bar for long-running work. Re-call with the returned id to advance the bar in place instead of stacking bars.",
  render_timeline:
    "Show an ordered timeline in the output zone. Use when the sequence of events or stages is itself the point (chronology, plan, release history).",
  render_filetree:
    "Show a file/directory tree in the output zone. Use for ANY file-structure picture — never hand-draw ASCII trees.",
  render_question:
    "Ask the user a structured question with 2–4 clickable options. Clicking one sends its text as the user's next turn. Use when the next step is the user's call between concrete alternatives; never for open-ended questions.",
  render_diff:
    "Show a red/green line diff of a code change, made or proposed. Per file, pass the relevant lines as they were (before) and as they are/would be (after) — verbatim code, no +/- prefixes; the client computes the diff. Use instead of hand-written diff code fences.",
};

/** The generative-UI tool-preference nudge, shared across all three adapters:
 *  Claude appends it to the claude_code system-prompt preset (Session
 *  options); Codex and Gemini have no system-prompt hook (V.2), so their
 *  adapters prepend it ahead of the first user turn instead. */
export const RENDER_GUIDANCE = `
## Generative UI

Your output renders in a web app whose output zone can mount real UI
components, not just markdown. The render_* tools paint a component inline at
the exact point in your reply where you call them, so you can mix prose and
components freely.

- Prefer render_table to a markdown table, render_list to a markdown bullet or
  numbered list, render_links to a bare pile of links, render_card for a
  single highlight, verdict, or summary worth setting off from the prose (its
  optional \`kind\` tints it as an info/success/warning/error callout), and
  render_chart for ANY plot or graph (line for trends, bar for comparisons).
- Also: render_keyvalue for a name→value fact sheet (config, environment),
  render_timeline when the sequence of events or stages is the point,
  render_filetree for ANY file/directory structure (never ASCII trees), and
  render_progress — repainted via its id — for long-running work.
- render_question when the next step is genuinely the user's call between
  2–4 concrete options: clicking one sends it as their next turn. Prefer it
  to ending prose with "should I do A or B?". Never use it for open-ended
  questions — those stay prose.
- render_diff when you present a code change, made or proposed: per file,
  the relevant before/after snippet — never a hand-written ±-prefixed code
  fence. Plain code blocks stay right for showing code that isn't a change.
- Raw HTML or SVG in your text renders as literal code, never as visuals.
  Never hand-write markup for something a render tool covers. When something
  genuinely needs custom visuals or interactivity that NO render_* component
  can express (a simulation, a custom diagram, a bespoke mini-app), use
  emit_artifact — it runs your HTML/JS in a locked-down sandbox. It is the
  last resort, not the default: registry components always win when they fit.
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
      // Handler args collapse to a union across shapes; the id is all the
      // shared handler reads, and the engine validates props per schema.
      ...renderToolEntries.map(([name, component]) =>
        tool(
          name,
          TOOL_DESCRIPTIONS[name],
          { ...registryShapes[component], ...idParam },
          (async ({ id, ...props }: { id?: string }) =>
            emitRender(component, id, props)) as never,
        ),
      ),
      tool(
        "emit_artifact",
        "Render self-contained HTML/CSS/JS in a sandboxed iframe. LAST RESORT: " +
          "use only when no render_* component can express what's needed " +
          "(custom visuals, simulations, bespoke interactivity). The sandbox " +
          "exposes exactly two outward calls: mirafold.prompt(text) sends text " +
          "as the user's next turn; mirafold.tool(name, args) runs an " +
          "allowlisted server helper (names: " +
          actionToolNames.join(", ") +
          "). Anything else stays inside the sandbox.",
        {
          html: z
            .string()
            .describe(
              "Body markup only (the host supplies <html>/<head>); inline " +
                "<style> and <script> are fine. Must be fully self-contained: " +
                "a strict CSP blocks ALL network (fetch/XHR/WebSocket, external " +
                "scripts/images/fonts) and the sandbox has no cookies or " +
                "storage. Dark background (#141a26) — style for it.",
            ),
          title: z
            .string()
            .optional()
            .describe("Short label shown in the artifact's chrome bar."),
          id: z
            .string()
            .optional()
            .describe(
              "Omit to render a new artifact. Pass an id returned by a " +
                "previous emit_artifact call to replace that artifact in place.",
            ),
        },
        async ({ html, title, id }) => {
          const artifactId = id ?? randomUUID();
          emit({ type: "artifact", html, id: artifactId, title });
          return {
            content: [
              { type: "text" as const, text: `Rendered artifact (id: ${artifactId})` },
            ],
          };
        },
      ),
    ],
  });
}
