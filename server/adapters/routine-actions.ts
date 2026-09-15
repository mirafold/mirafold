import type { AgentName, ToolAction } from "../protocol";
import { inertToken } from "./wire-helpers";

/**
 * The explicit, per-engine table of built-in tools whose purpose is KNOWN by
 * exact name (Phase TF R2): a read, a listing, or a search — nothing else.
 * Shell commands are never classified here; Codex's own parsed
 * `commandActions` are the only source for those. `target` names the input
 * key whose value is the display target (a path, a pattern), clamped.
 * Anything not listed carries no classification and stays a plain call.
 */
type Entry = { kind: ToolAction["kind"]; target: readonly string[] };

const CLAUDE: Record<string, Entry> = {
  Read: { kind: "read", target: ["file_path"] },
  NotebookRead: { kind: "read", target: ["notebook_path"] },
  Glob: { kind: "list", target: ["pattern", "path"] },
  LS: { kind: "list", target: ["path"] },
  Grep: { kind: "search", target: ["pattern"] },
};

// OpenCode 1.18 built-ins (opencode.spike.md): lowercase names, camelCase
// input fields.
const OPENCODE: Record<string, Entry> = {
  read: { kind: "read", target: ["filePath"] },
  glob: { kind: "list", target: ["pattern", "path"] },
  list: { kind: "list", target: ["path"] },
  grep: { kind: "search", target: ["pattern"] },
};

// Gemini CLI 0.58 built-ins, names verified against the installed bundle
// (TF0.3): read_file / read_many_files / glob / list_directory / grep_search.
const GEMINI: Record<string, Entry> = {
  read_file: { kind: "read", target: ["file_path", "absolute_path", "path"] },
  read_many_files: { kind: "read", target: ["paths"] },
  glob: { kind: "list", target: ["pattern", "path"] },
  list_directory: { kind: "list", target: ["path", "dir_path"] },
  grep_search: { kind: "search", target: ["pattern"] },
};

const TABLES: Record<AgentName, Record<string, Entry>> = {
  "claude-code": CLAUDE,
  codex: {}, // Codex commands classify from commandActions only
  "gemini-cli": GEMINI,
  opencode: OPENCODE,
};

export function routineActions(
  agent: AgentName,
  tool: string,
  input: unknown,
): ToolAction[] | undefined {
  // Own entries only: an engine-chosen name like `constructor` or
  // `__proto__` must resolve to nothing, never to an inherited property
  // (PR #120 review).
  const table = TABLES[agent];
  const entry = Object.hasOwn(table, tool) ? table[tool] : undefined;
  if (!entry) return undefined;
  const rec = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  let target: string | undefined;
  for (const key of entry.target) {
    const value = rec[key];
    if (typeof value === "string" && value) {
      target = value;
      break;
    }
    if (Array.isArray(value) && value.length && typeof value[0] === "string") {
      target = value.length === 1 ? value[0] : `${value[0]} (+${value.length - 1})`;
      break;
    }
  }
  return [{ kind: entry.kind, ...(target ? { target: inertToken(target, 200) } : {}) }];
}
