// Action mediation. `tool` actions from components run HERE,
// against an explicit allowlist with validated args — the client never
// calls anything directly, and off-list names are rejected and logged.
// Results are broadcast as tool_use/tool_result records, so an action's
// effect is visible in every viewport's transcript.

import { createLogger } from "../log";
import { opendirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { errText } from "../adapters/types";

const log = createLogger("action");
const WORKSPACE_LS_MAX_ENTRIES = 2_000;
const WORKSPACE_LS_MAX_OUTPUT_BYTES = 64_000;
const WORKSPACE_LS_TRUNCATED = "(listing truncated)";

type ActionTool = {
  description: string;
  args: z.ZodType<Record<string, unknown> | undefined>;
  run: (args: Record<string, unknown>, cwd: string) => string;
};

// Resolve `candidate` under `root` and confirm it stays inside — following
// symlinks, so a link planted in the workspace can't point the listing out of
// it. realpathSync throws on a missing path (nothing to list anyway → treat as
// outside). `root` is realpath'd too, so the prefix compare is against the
// canonical base. Exported: fs-folder-tree.ts jails every folder tree
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
      const dir = opendirSync(target);
      const lines: string[] = [];
      let outputBytes = 0;
      let scanned = 0;
      let truncated = false;
      const markerBytes = Buffer.byteLength(WORKSPACE_LS_TRUNCATED, "utf8") + 1;
      try {
        for (;;) {
          const entry = dir.readSync();
          if (!entry) break;
          if (scanned++ >= WORKSPACE_LS_MAX_ENTRIES) {
            truncated = true;
            break;
          }
          const n = entry.name;
          // Per-entry stat failures (a dangling symlink; a file the agent
          // deleted between readdir and stat) mark that ROW, never the whole
          // listing — one broken link must not turn every sibling invisible
          // (fs-folder-tree handles the same case).
          let line: string;
          try {
            const s = statSync(path.join(target, n));
            line = `${s.isDirectory() ? "d" : "-"} ${String(s.size).padStart(8)}  ${n}${s.isDirectory() ? "/" : ""}`;
          } catch {
            line = `- ${"?".padStart(8)}  ${n}`;
          }
          const lineBytes = Buffer.byteLength(line, "utf8") + (lines.length ? 1 : 0);
          if (outputBytes + lineBytes + markerBytes > WORKSPACE_LS_MAX_OUTPUT_BYTES) {
            truncated = true;
            break;
          }
          lines.push(line);
          outputBytes += lineBytes;
        }
      } finally {
        dir.closeSync();
      }
      if (lines.length === 0 && !truncated) return "(empty)";
      return `${lines.join("\n")}${truncated ? `${lines.length ? "\n" : ""}${WORKSPACE_LS_TRUNCATED}` : ""}`;
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
