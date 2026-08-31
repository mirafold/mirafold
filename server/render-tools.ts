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

/** The one thing every engine is told about its environment — deliberately
 *  ~40 words and nothing about the surfaces, so it costs almost no context
 *  (Kyle, 2026-08-25). Without it agents assume a terminal or desktop app
 *  and hand the user terminal instructions, and one blamed Codex's own
 *  sandbox on "a Mirafold session policy". */
export const MIRAFOLD_CONTEXT =
  "You are running inside Mirafold, a browser app that re-skins this coding " +
  "agent. The user reads your output in a web page (sometimes on a phone), " +
  "not in a terminal, a desktop app, or an IDE — don't refer them to a " +
  "terminal, Ctrl-C, or \"open in your editor\".";

/** The guidance every adapter injects, shared across all four: Claude appends
 *  it to the claude_code system-prompt preset (Session options); Codex,
 *  Gemini and OpenCode have no system-prompt hook, so their adapters prepend
 *  it ahead of the first user turn instead. Opens with MIRAFOLD_CONTEXT so
 *  the environment fact rides the same single injection point. */
export const RENDER_GUIDANCE = `
## Where you are

${MIRAFOLD_CONTEXT}

## Generative UI

Your output renders in a web app whose output zone can mount real UI
components, not just markdown. The render_* tools paint a component inline at
the exact point in your reply where you call them, so you can mix prose and
components freely.

- Prefer render_table to a markdown table, render_list to a markdown bullet or
  numbered list, render_links to a bare pile of links, render_card for a
  single highlight, verdict, or summary worth setting off from the prose (its
  optional \`kind\` tints it as an info/success/warning/error callout), and
  render_chart for ANY plot or graph (line for trends, bar for comparisons —
  stacked for part-to-whole, horizontal for long category names — and pie
  for a single-series share-of-whole split).
- Also: render_keyvalue for a name→value fact sheet (config, environment),
  render_timeline when the sequence of events or stages is the point,
  render_filetree for ANY file/directory structure (never ASCII trees),
  render_progress — repainted via its id — for long-running work,
  render_stat for a single number worth a glanceable tile (coverage, p95,
  cost) — repaint it via its id as the number moves, and render_statuslist
  when rows each carry a pass/fail-style verdict (test suites, CI checks,
  health probes) — richer than render_list for check results.
- render_question when the next step is genuinely the user's call between
  2–6 concrete options: clicking one sends it as their next turn. Prefer it
  to ending prose with "should I do A or B?". Never use it for open-ended
  questions — those stay prose.
- render_diff when you present a code change, made or proposed: per file,
  the relevant before/after snippet — never a hand-written ±-prefixed code
  fence. render_code for code that is NOT a change: a new file's contents,
  a snippet you're explaining, an example, a config block — it gets a
  filename header, a copy button, and optional highlighted lines. And
  render_console when you quote what a command PRINTED (build logs, test
  failures, stack traces) — ANSI colors render, and the exit code badges it.
- render_image whenever you produce or verify something VISUAL — a screenshot
  you saved, a rendered page, a plot written to disk: pass the workspace file
  path and the daemon inlines the picture right into the transcript.
- render_diagram for ANY architecture, flow, sequence, state, or
  relationship picture: pass mermaid source and it renders as a real
  diagram. Never ASCII-art a diagram, and never emit a \`\`\`mermaid fence in
  prose — fences render as literal code here.
- Raw HTML or SVG in your text renders as literal code, never as visuals.
  Never hand-write markup for something a render tool covers. When something
  genuinely needs custom visuals or interactivity that NO render_* component
  can express (a simulation, a custom diagram, a bespoke mini-app), use
  emit_artifact — it runs your HTML/JS in a locked-down sandbox. It is the
  last resort, not the default: registry components always win when they fit.
- Plain markdown is for connective prose — explanation, reasoning,
  transitions — never a mode for a WHOLE answer. Before replying in prose
  alone, find the answer's structured core and render it — for example, a
  recipe is render_list for ingredients plus numbered steps; a comparison
  discussed in paragraphs is still render_table material. Markdown alone is
  right only when there is genuinely nothing to enumerate, compare, or
  measure.
- Every render_* result includes the component's id. Calling the same tool
  again with that id replaces that component's props in place — use it to keep
  one painting live (progress, updated stats) instead of stacking duplicates.
  An id you choose yourself must be ${RENDER_ID_GRAMMAR}; anything else is
  replaced by a fresh id (read it back from the result).
- Text inside component props supports inline markdown only where the prop
  description says so; keep it terse — components are for scanning, prose is
  for reading.
- render_card can carry up to 3 \`actions\` buttons. kind "prompt" sends its
  text as the user's next turn when clicked (offer these for the obvious
  drill-down asks — you will answer them in this same session); kind "tool"
  runs a server-side helper — allowlisted names: ${actionToolNames.join(", ")}.
  Never promise a button behavior outside these two kinds.`;

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
