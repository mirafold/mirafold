import path from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

// Read-only tools: no side effects, always allowed.
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

// Mutating tools whose target path we can check directly.
const PATH_FIELD: Record<string, string> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

function isInside(root: string, candidate: string): boolean {
  const resolved = path.resolve(root, candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** Asks the user in the browser; resolves false on deny or timeout. */
export type PermissionAsker = (tool: string, detail: string) => Promise<boolean>;

/**
 * Permission policy (Phase 0 base + T.3 prompts): read-only tools pass,
 * file mutations inside the workspace pass, in-workspace Bash passes.
 * Everything that Phase 0 flatly denied — Bash reaching outside the
 * workspace, writes outside it, unknown tools — now pauses the turn and
 * asks the browser; deny stays the default (timeout, disconnect, Esc).
 */
export function makeCanUseTool(workspaceDir: string, ask: PermissionAsker): CanUseTool {
  const root = path.resolve(workspaceDir);
  const denied = (message: string) => ({ behavior: "deny" as const, message });
  const askOr = async (tool: string, detail: string, input: Record<string, unknown>, denyMsg: string) =>
    (await ask(tool, detail))
      ? { behavior: "allow" as const, updatedInput: input }
      : denied(denyMsg);

  return async (toolName, input) => {
    if (READ_ONLY_TOOLS.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }

    // Our UI server (server/render-tools.ts): render_* and emit_artifact are
    // side-effect-free UI emission — artifacts are contained by the iframe
    // sandbox, not by this gate.
    if (toolName.startsWith("mcp__ui__")) {
      return { behavior: "allow", updatedInput: input };
    }

    const field = PATH_FIELD[toolName];
    if (field) {
      const target = input[field];
      if (typeof target === "string" && isInside(root, target)) {
        return { behavior: "allow", updatedInput: input };
      }
      return askOr(
        toolName,
        String(target ?? "(unknown path)"),
        input,
        "The user declined this file write from the permission prompt.",
      );
    }

    if (toolName === "Bash") {
      const command = String(input["command"] ?? "");
      // The regex can false-positive on legitimate commands (e.g. a path
      // inside a quoted string) — with T.3 a false positive costs one
      // browser prompt instead of a hard deny. ".." and "~" are flagged
      // whenever they end a token, so `cd .. && …` can't slip past.
      if (/(^|[\s;|&'"=(])((\.\.|~)(?=\/|$|[\s;|&'")])|\/(?!$))/.test(command)) {
        return askOr(
          "Bash",
          command,
          input,
          "The user declined this command from the permission prompt.",
        );
      }
      return { behavior: "allow", updatedInput: input };
    }

    return askOr(
      toolName,
      JSON.stringify(input).slice(0, 160),
      input,
      `The user declined the ${toolName} call from the permission prompt.`,
    );
  };
}
