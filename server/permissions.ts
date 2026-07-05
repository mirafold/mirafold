import path from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

// Read-only tools: no side effects, allowed without a prompt — same as the terminal.
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "NotebookRead",
]);

// Consequential tools whose salient argument (path / command) is worth showing
// on the permission bar when we ask.
const DETAIL_FIELD: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  Bash: "command",
};

// The daemon's own secrets must never be read back out through a tool — even a
// read-only one — because the API key lives in .env and Read+WebFetch would be
// an exfil path. Defense-in-depth only: it closes the obvious `Read .env`, not
// every route, so it is not a full boundary.
const SECRET_PATHS = new Set([path.resolve(".env"), path.resolve(".env.local")]);
const READ_PATH_FIELD: Record<string, string> = {
  Read: "file_path",
  NotebookRead: "notebook_path",
};

/** Asks the user in the browser; resolves false on deny or timeout. */
export type PermissionAsker = (tool: string, detail: string) => Promise<boolean>;

/**
 * Permission policy — match the terminal. The session inherits the user's
 * Claude Code settings.json (see session.ts `settingSources`), so the SDK's own
 * allow/deny rules resolve FIRST: anything the user allowlisted runs without a
 * prompt, anything they denied is blocked — both before this callback runs.
 * `canUseTool` is only the interactive fallback for undecided calls: the
 * terminal's approval prompt, drawn on the shell's permission bar instead of the
 * TUI. Deny is the default on timeout, disconnect, and Esc.
 *
 *   - the daemon's own .env is never readable (defense-in-depth);
 *   - read-only tools and our side-effect-free UI tools (mcp__ui__*) pass;
 *   - everything else (Write/Edit/Bash/unknown) ASKS. There is deliberately no
 *     blanket "auto-allow inside the workspace" — the terminal doesn't do that,
 *     so neither do we; a user allowlists the commands they want promptless in
 *     their settings.json exactly as in the terminal.
 */
export function makeCanUseTool(workspaceDir: string, ask: PermissionAsker): CanUseTool {
  const root = path.resolve(workspaceDir);
  const denied = (message: string) => ({ behavior: "deny" as const, message });

  const detailFor = (toolName: string, input: Record<string, unknown>): string => {
    const field = DETAIL_FIELD[toolName];
    if (field && typeof input[field] === "string") return input[field] as string;
    return JSON.stringify(input).slice(0, 160);
  };

  return async (toolName, input) => {
    // Guard the daemon's own secrets before the read-only allowlist runs.
    const readField = READ_PATH_FIELD[toolName];
    if (readField) {
      const target = input[readField];
      if (typeof target === "string" && SECRET_PATHS.has(path.resolve(root, target))) {
        return denied("Reading the daemon's environment file is not permitted.");
      }
    }

    if (READ_ONLY_TOOLS.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }

    // Our UI server (server/render-tools.ts): render_* and emit_artifact are
    // side-effect-free UI emission — artifacts are contained by the iframe
    // sandbox, not by this gate.
    if (toolName.startsWith("mcp__ui__")) {
      return { behavior: "allow", updatedInput: input };
    }

    // Everything consequential asks — exactly like the terminal. (The user's
    // inherited allow-rules already short-circuited whatever they allowlisted.)
    return (await ask(toolName, detailFor(toolName, input)))
      ? { behavior: "allow" as const, updatedInput: input }
      : denied(`The user declined the ${toolName} call from the permission prompt.`);
  };
}
