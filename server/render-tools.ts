// Render tools — the agent's vocabulary for painting registry components.
// Each tool has NO side effects: calling it just emits a `render` WireMsg
// into the session's output stream, interleaved with the text deltas at the
// point of the call. The input schemas ARE the registry spec,
// plus an optional `id` for update-in-place.

import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { RENDER_ID_GRAMMAR, acceptableRenderId, renderToolEntries, type RenderToolName } from "./adapters/render-mcp-cmd";
import type { SessionMsg } from "./protocol";
import { resolveImageProps } from "./render-image";
import { registryShapes, type ComponentName } from "./registry-spec";
import { actionToolNames } from "./sessions/actions";

const idParam = {
  id: z
    .string()
    .optional()
    .describe(
      "Omit to render a new component. Pass an id returned by a previous " +
        `render_* call to update that component in place instead (your own ids: ${RENDER_ID_GRAMMAR}).`,
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
    "Show a chart in the output zone: line for trends over an ordered axis, bar for category comparisons, pie for a single part-of-whole split (exactly one series; ≤6 slices read best). On bar, stacked=true stacks the series into part-to-whole columns, and horizontal=true lays the category labels down the left — use it when names are long or categories many. For a distribution, pre-bin the values into labeled bar buckets yourself. Use for ANY plot/graph — never hand-write SVG or ASCII charts.",
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
    "Ask the user a structured question with 2–6 clickable options. Clicking one sends its text as the user's next turn. Use when the next step is the user's call between concrete alternatives; never for open-ended questions.",
  render_diff:
    "Show a red/green line diff of a code change, made or proposed. Per file, pass the relevant lines as they were (before) and as they are/would be (after) — verbatim code, no +/- prefixes; the client computes the diff. Use instead of hand-written diff code fences.",
  render_stat:
    "Show a single-number stat tile: coverage %, p95, cost, a count — one glanceable KPI with an optional up/down change. Re-call with the returned id to update the number in place as it changes.",
  render_code:
    "Show a block of code with a filename/language header and a copy button. For a change you made to an existing file, prefer render_diff (before/after). Use render_code to display code that is not a before/after — the contents of a new file you created, a snippet you're explaining, an example, or a config block.",
  render_statuslist:
    "Show labeled rows each with a pass/fail/warn/pending/skip status pill. Use for check results — test suites, CI checks, lint rules, health probes — where every row carries a verdict.",
  render_console:
    "Show terminal output you're quoting — a build log excerpt, a failing test's output, a stack trace — as a console block: optional command header, monospace body with ANSI colors rendered, exit-code badge. Quote the RELEVANT excerpt, not a whole log. For code itself use render_code.",
  render_image:
    "Show a raster image from the workspace inline: pass the FILE PATH (png/jpeg/gif/webp, ≤2 MB) — e.g. a screenshot you just saved — and the daemon inlines the bytes; never encode them yourself. Use whenever you produce or verify something visual: app screenshots, rendered pages, plots saved to disk.",
  render_diagram:
    "Render a mermaid diagram (flowchart, sequenceDiagram, stateDiagram-v2, classDiagram, erDiagram) from its source text. Use for ANY architecture/flow/relationship picture — never ASCII-art diagrams, and never a raw ```mermaid fence (that renders as literal code here). Data plots stay render_chart.",
};

// `workspaceDir` is REQUIRED: it is what jails the image
// tool's file read to the session's directory. Optional, a future adapter
// could omit it and silently ship the agent's own `src` to the client,
// skipping containment and the byte cap. Required, that's a compile error.
export function makeRenderServer(emit: (msg: SessionMsg) => void, workspaceDir: string) {
  const emitRender = (component: ComponentName, id: string | undefined, props: object) => {
    const renderId = acceptableRenderId(id) ?? randomUUID();
    // image authors a PATH; the daemon inlines the bytes at the synthesis
    // point (same contract as generativeUIMsg on the stdio adapters).
    if (component === "image") {
      props = resolveImageProps(workspaceDir, props as Record<string, unknown>);
    }
    emit({ type: "render", component, props: props as Record<string, unknown>, id: renderId });
    return {
      content: [{ type: "text" as const, text: `Rendered ${component} (id: ${renderId})` }],
    };
  };

  return createSdkMcpServer({
    name: "ui",
    version: "1.0.0",
    // Claude Code defers MCP tool definitions behind ToolSearch by default
    // (Agent SDK tool search), so the model has to go looking for render_*
    // before it can paint — and it mostly answers in prose instead. This
    // marks only Mirafold's own server always-loaded (`_meta
    // anthropic/alwaysLoad` on each tool); the user's other MCP servers keep
    // the deferral their terminal Claude Code applies (faithful skin).
    alwaysLoad: true,
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
                "a strict CSP blocks HTTP and WebSocket (fetch/XHR/WebSocket, external " +
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
          const artifactId = acceptableRenderId(id) ?? randomUUID();
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
