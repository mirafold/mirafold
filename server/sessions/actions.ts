// Action mediation (Step 2.3). `tool` actions from components run HERE,
import { createLogger } from "../log";

const log = createLogger("action");
// against an explicit allowlist with validated args — the client never
// calls anything directly, and off-list names are rejected and logged.
// Results are broadcast as tool_use/tool_result records, so an action's
// effect is visible in every viewport's transcript.

import { readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { errText } from "../adapters/types";

type ActionTool = {
  description: string;
  args: z.ZodType<Record<string, unknown> | undefined>;
  run: (args: Record<string, unknown>, cwd: string) => string;
};

// Resolve `candidate` under `root` and confirm it stays inside — following
// symlinks, so a link planted in the workspace can't point the listing out of
// it. realpathSync throws on a missing path (nothing to list anyway → treat as
// outside). `root` is realpath'd too, so the prefix compare is against the
// canonical base. Exported since E.1: fs-explorer.ts jails every Explorer
// path through this same guard — one containment rule, no drift.
export const inside = (root: string, candidate: string): string | null => {
  let real: string;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(path.resolve(realRoot, candidate));
  } catch {
    return null;
  }
  return real === realRoot || real.startsWith(realRoot + path.sep) ? real : null;
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
    log.warn(`REJECTED off-allowlist tool "${name}"`);
    return { output: `Action tool "${name}" is not allowlisted.`, isError: true };
  }
  const parsed = spec.args.safeParse(args);
  if (!parsed.success) {
    log.warn(`REJECTED bad args for "${name}": ${parsed.error.message}`);
    return { output: `Invalid arguments for "${name}".`, isError: true };
  }
  log.info(`run "${name}" in ${cwd}`);
  try {
    return { output: spec.run(parsed.data ?? {}, cwd), isError: false };
  } catch (err) {
    const message = errText(err);
    log.warn(`"${name}" failed: ${message}`);
    return { output: message, isError: true };
  }
}
