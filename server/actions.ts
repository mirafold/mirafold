// Action mediation (Step 2.3). `tool` actions from components run HERE,
// against an explicit allowlist with validated args — the client never
// calls anything directly, and off-list names are rejected and logged.
// Results are broadcast as tool_use/tool_result records, so an action's
// effect is visible in every viewport's transcript.

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

type ActionTool = {
  description: string;
  args: z.ZodType<Record<string, unknown> | undefined>;
  run: (args: Record<string, unknown>, cwd: string) => string;
};

const inside = (root: string, candidate: string): string | null => {
  const resolved = path.resolve(root, candidate);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
};

const ACTION_TOOLS: Record<string, ActionTool> = {
  workspace_ls: {
    description: "List files in the session's workspace (optionally a subpath).",
    args: z.object({ path: z.string().optional() }).optional(),
    run: (args, cwd) => {
      const target = inside(cwd, String(args["path"] ?? "."));
      if (!target) throw new Error("path escapes the session workspace");
      const names = readdirSync(target);
      if (names.length === 0) return "(empty)";
      return names
        .map((n) => {
          const s = statSync(path.join(target, n));
          return `${s.isDirectory() ? "d" : "-"} ${String(s.size).padStart(8)}  ${n}${s.isDirectory() ? "/" : ""}`;
        })
        .join("\n");
    },
  },
};

/** The allowlisted names, for prompt guidance and docs. */
export const actionToolNames = Object.keys(ACTION_TOOLS);

export type ActionResult = { output: string; isError: boolean };

export function runActionTool(
  name: string,
  args: Record<string, unknown> | undefined,
  cwd: string,
): ActionResult {
  const spec = ACTION_TOOLS[name];
  if (!spec) {
    console.warn(`[action] REJECTED off-allowlist tool "${name}"`);
    return { output: `Action tool "${name}" is not allowlisted.`, isError: true };
  }
  const parsed = spec.args.safeParse(args);
  if (!parsed.success) {
    console.warn(`[action] REJECTED bad args for "${name}": ${parsed.error.message}`);
    return { output: `Invalid arguments for "${name}".`, isError: true };
  }
  console.log(`[action] run "${name}" in ${cwd}`);
  try {
    return { output: spec.run(parsed.data ?? {}, cwd), isError: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[action] "${name}" failed: ${message}`);
    return { output: message, isError: true };
  }
}
