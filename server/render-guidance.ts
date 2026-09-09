import { RENDER_ID_GRAMMAR } from "./adapters/render-mcp-cmd";
import { actionToolNames } from "./sessions/actions";

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
