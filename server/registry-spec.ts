// The component registry spec — the single source of truth for which
// components the agent may render and what props each accepts.
//
// One zod shape per component serves three consumers:
//   1. Step 1.2 — render tools: the SDK's tool() helper takes the raw shape
//      directly, so the agent's tool-input schema IS this spec.
//   2. Step 1.3 — the front end keys its React registry off ComponentName.
//   3. Step 1.4 — client/server prop validation via the derived z.object.
//
// The .describe() strings are what the model reads when deciding how to fill
// props — write them for the agent, not for humans.

import { z } from "zod";

// Body/detail strings render as sanitized markdown client-side, same pipeline
// as ordinary turn text — so the agent can bold, link, and inline-code freely.
const markdown = (what: string) =>
  z.string().describe(`${what} Supports inline markdown (bold, links, \`code\`).`);

// Phase 2: action descriptors components may carry. The agent-facing subset
// is prompt|tool — state actions are shell-internal and not authorable.
export const actionSpec = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("prompt"),
    text: z
      .string()
      .describe(
        "The follow-up sent as a user turn when clicked — it appears in the " +
          "transcript exactly like typed input and you answer it in-session.",
      ),
  }),
  z.object({
    kind: z.literal("tool"),
    name: z.string().describe("A server-allowlisted action tool, e.g. workspace_ls."),
    args: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Arguments for the tool, if it takes any."),
  }),
]);

const actionsProp = z
  .array(
    z.object({
      label: z.string().describe("Button text, 1–3 words."),
      action: actionSpec,
    }),
  )
  .max(3)
  .optional()
  .describe(
    "Up to 3 action buttons rendered at the foot of the component. Use for " +
      "the obvious next steps a reader would want one click away.",
  );

export const registryShapes = {
  card: {
    title: z.string().describe("Card heading, a few words."),
    body: markdown("Main card content, one short paragraph."),
    footer: z
      .string()
      .optional()
      .describe("Small muted footer line, e.g. a source, timestamp, or caveat."),
    kind: z
      .enum(["info", "success", "warning", "error"])
      .optional()
      .describe(
        "Optional callout tint: success for good verdicts, warning for " +
          "cautions, error for failures, info for neutral notices. Omit for a plain card.",
      ),
    actions: actionsProp,
  },

  list: {
    title: z.string().optional().describe("Optional heading above the list."),
    ordered: z
      .boolean()
      .optional()
      .describe("True for a numbered list (steps, rankings); false/omit for bullets."),
    items: z
      .array(
        z.object({
          text: markdown("The item itself, one line."),
          detail: markdown("Optional second line, smaller and muted.").optional(),
        }),
      )
      .min(1)
      .describe("The list entries, in display order."),
  },

  table: {
    title: z.string().optional().describe("Optional heading above the table."),
    columns: z.array(z.string()).min(1).describe("Column headers, in display order."),
    rows: z
      .array(z.array(z.union([z.string(), z.number()])))
      .describe(
        "Table body: one array per row, cells aligned to `columns` by index. " +
          "Cell strings support inline markdown.",
      ),
  },

  chart: {
    title: z.string().optional().describe("Optional heading above the chart."),
    kind: z
      .enum(["line", "bar"])
      .describe("line for change/trends over an ordered axis; bar for comparing categories."),
    x: z
      .array(z.string())
      .min(1)
      .describe("X-axis labels (time points or categories), in display order."),
    series: z
      .array(
        z.object({
          name: z.string().describe("Series name, shown in the legend."),
          values: z
            .array(z.number())
            .describe("One numeric value per x label, aligned by index."),
        }),
      )
      .min(1)
      .max(6)
      .describe("1–6 data series sharing the same x axis."),
    yLabel: z.string().optional().describe("Optional y-axis unit/label, e.g. 'ms' or '$k'."),
  },

  "link-group": {
    title: z.string().optional().describe("Optional heading above the links."),
    links: z
      .array(
        z.object({
          label: z.string().describe("Link text, a few words."),
          // http(s) only: z.url() alone accepts javascript:/data:/vbscript:,
          // and LinkGroup renders href into a real anchor in the TRUSTED shell
          // origin (outside the markdown sanitizer), so a bad scheme would be
          // agent-controlled script one click from the shell's scope.
          href: z
            .url()
            .refine((u) => /^https?:$/.test(new URL(u).protocol), {
              message: "href must be an http(s) URL",
            })
            .describe("Absolute http(s) URL."),
          description: z.string().optional().describe("One-line description, muted."),
        }),
      )
      .min(1)
      .describe("The links, in display order."),
  },

  "key-value": {
    title: z.string().optional().describe("Optional heading above the facts."),
    pairs: z
      .array(
        z.object({
          key: z.string().describe("The fact's name, 1–4 words."),
          value: markdown("The fact's value, one short line."),
        }),
      )
      .min(1)
      .describe(
        "The facts, in display order — a two-column name→value sheet " +
          "(config, environment details, detected settings).",
      ),
  },

  progress: {
    label: z.string().describe("What's in progress, a few words, e.g. 'Running test suite'."),
    percent: z
      .number()
      .min(0)
      .max(100)
      .describe("Completion, 0–100. Re-call with the same id to move the bar."),
    detail: markdown("Optional status line under the bar, e.g. current step or ETA.").optional(),
  },

  timeline: {
    title: z.string().optional().describe("Optional heading above the timeline."),
    items: z
      .array(
        z.object({
          label: markdown("The event or step, one line."),
          detail: markdown("Optional second line, smaller and muted.").optional(),
          time: z
            .string()
            .optional()
            .describe(
              "Optional short marker shown beside the entry: a timestamp, version, or stage.",
            ),
        }),
      )
      .min(1)
      .describe("The entries in sequence order (chronology, plan stages, release history)."),
  },

  "file-tree": {
    title: z.string().optional().describe("Optional heading above the tree."),
    paths: z
      .array(
        z.object({
          path: z
            .string()
            .describe(
              "Slash-separated relative path, e.g. 'src/registry/Card.tsx'. " +
                "End with '/' to show a directory with no listed children.",
            ),
          note: z
            .string()
            .optional()
            .describe("Optional short annotation shown muted beside the entry."),
        }),
      )
      .min(1)
      .describe(
        "Flat list of paths; the client nests them into a tree. Include only " +
          "paths worth showing — an editorial picture, not a full listing.",
      ),
  },

  question: {
    question: markdown("The question itself, one line."),
    options: z
      .array(
        z.object({
          label: z.string().describe("Button text, 1–5 words."),
          text: z
            .string()
            .optional()
            .describe("The full user turn sent when this option is clicked. Defaults to the label."),
          detail: markdown("Optional one-line explanation shown muted under the label.").optional(),
        }),
      )
      .min(2)
      .max(6)
      .describe(
        "2–6 mutually exclusive choices. Clicking one sends its text as the " +
          "user's next turn — you answer it in this same session.",
      ),
  },

  // before/after snippets, NOT unified-patch text: models routinely get @@
  // line math wrong, while both sides of a snippet need no bookkeeping and
  // the client diffs them precisely (same differ as ToolBlock's Edit view).
  diff: {
    title: z.string().optional().describe("Optional heading above the diff."),
    files: z
      .array(
        z.object({
          path: z
            .string()
            .describe("File path shown as this block's header, e.g. 'src/api/router.ts'."),
          before: z
            .string()
            .describe(
              "The relevant lines as they were. Empty string for a new file. " +
                "Verbatim code — no +/- prefixes, no markdown.",
            ),
          after: z
            .string()
            .describe(
              "The same lines as they are now (or as proposed). Empty string " +
                "for a deleted file. Verbatim code — no +/- prefixes, no markdown.",
            ),
          note: z
            .string()
            .optional()
            .describe("Optional short annotation beside the path, e.g. 'new file' or 'proposed'."),
        }),
      )
      .min(1)
      .describe(
        "One entry per file, in display order. Show only the relevant snippet " +
          "per file, not whole files; the client renders a red/green line diff " +
          "of before → after.",
      ),
  },

  stat: {
    label: z.string().describe("What the number is, 1–4 words, e.g. 'Coverage' or 'p95 latency'."),
    value: z
      .string()
      .describe(
        "The number itself, formatted with its unit, e.g. '98%', '212 ms', '$4.10', '1.2 MB'.",
      ),
    delta: z
      .object({
        value: z.string().describe("The change, formatted and signed, e.g. '+2.1%' or '-14 ms'."),
        direction: z
          .enum(["up", "down"])
          .describe("Which way the number moved — drawn as an arrow beside the change."),
        good: z
          .boolean()
          .describe(
            "Whether this move is good news — colors the change. Up isn't always " +
              "good (latency up is bad); say which this is.",
          ),
      })
      .optional()
      .describe("Change since a prior reading. Omit when there's no comparison."),
    footer: z
      .string()
      .optional()
      .describe("Small muted line under the value, e.g. the source, period, or baseline."),
  },

  code: {
    code: z
      .string()
      .describe("The code itself, verbatim plain text. No markdown fences, no HTML."),
    lang: z
      .string()
      .optional()
      .describe("Language for syntax coloring, e.g. 'ts', 'python', 'json'. Omit if unsure."),
    filename: z
      .string()
      .optional()
      .describe("Shown in the block's header, e.g. 'src/api/router.ts'."),
    highlight: z
      .array(
        z.object({
          start: z.number().int().min(1).describe("First emphasized line, 1-based."),
          end: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe("Last emphasized line, inclusive. Omit for a single line."),
        }),
      )
      .optional()
      .describe("Line ranges to emphasize — the lines the reader should look at first."),
  },

  "status-list": {
    title: z.string().optional().describe("Optional heading above the rows."),
    items: z
      .array(
        z.object({
          label: markdown("What was checked, one line."),
          status: z
            .enum(["pass", "fail", "warn", "pending", "skip"])
            .describe("The row's verdict, drawn as a colored status pill."),
          detail: markdown(
            "Optional second line, smaller and muted — the reason or evidence.",
          ).optional(),
        }),
      )
      .min(1)
      .describe(
        "The checks in display order (test suites, CI checks, lint rules, health probes).",
      ),
  },

  // NOT agent-authored — there is no render tool for this. The server
  // synthesizes it from the agent's TodoWrite calls (session.ts) so the
  // terminal's live task list shows up as a real, update-in-place component (T2.5).
  "todo-list": {
    todos: z
      .array(
        z.object({
          content: z.string(),
          status: z.enum(["pending", "in_progress", "completed"]),
        }),
      )
      .describe("The agent's task list, in order."),
  },
} as const;

export type ComponentName = keyof typeof registryShapes;

/**
 * Derived object schemas, for validating a full `render` props payload at the
 * SOURCE — agent output entering the system (render-mcp / render-tools, and
 * the tests that pin the vocabulary). Strict: an unknown key here is a
 * malformed agent instruction and must be rejected where it's authored.
 */
export const registrySchemas = Object.fromEntries(
  Object.entries(registryShapes).map(([name, shape]) => [name, z.object(shape).strict()]),
) as { [N in ComponentName]: z.ZodObject<(typeof registryShapes)[N]> };

/**
 * Tolerant twins for the CLIENT side (R.4h — the Postel split). The component
 * vocabulary is part of the wire contract in practice, and the wire rule is
 * additive-only: a newer daemon may send props from a newer vocabulary, and a
 * client built yesterday must render the parts it knows, not reject the whole
 * component into the raw-JSON fallback. z.object() (no .strict()) strips
 * unknown keys on parse — new optional props degrade invisibly on old
 * clients. RenderBlock validates with THESE; never tighten them to strict.
 */
export const clientSchemas = Object.fromEntries(
  Object.entries(registryShapes).map(([name, shape]) => [name, z.object(shape)]),
) as { [N in ComponentName]: z.ZodObject<(typeof registryShapes)[N]> };

export type ComponentProps<N extends ComponentName> = z.infer<(typeof registrySchemas)[N]>;
