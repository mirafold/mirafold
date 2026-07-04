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

/**
 * Phase 0 permission policy: read-only tools pass, file mutations must
 * target the workspace dir, Bash is heuristically confined (the session's
 * cwd is the workspace; commands referencing parent/absolute/home paths
 * are rejected — coarse on purpose, hardened in later phases).
 */
export function makeCanUseTool(workspaceDir: string): CanUseTool {
  const root = path.resolve(workspaceDir);

  return async (toolName, input) => {
    if (READ_ONLY_TOOLS.has(toolName)) {
      return { behavior: "allow", updatedInput: input };
    }

    const field = PATH_FIELD[toolName];
    if (field) {
      const target = input[field];
      if (typeof target === "string" && isInside(root, target)) {
        return { behavior: "allow", updatedInput: input };
      }
      return {
        behavior: "deny",
        message: `File writes are only allowed inside ${root}`,
      };
    }

    if (toolName === "Bash") {
      const command = String(input["command"] ?? "");
      // The regex can false-positive on legitimate commands (e.g. a path
      // inside a quoted string) — acceptable for a personal-first Phase 0.
      if (/(^|[\s;|&'"=(])(\.\.\/|\.\.$|~\/|\/(?!$))/.test(command)) {
        return {
          behavior: "deny",
          message: `Bash commands must stay inside the workspace (${root}); use relative paths without "..", "~", or absolute paths.`,
        };
      }
      return { behavior: "allow", updatedInput: input };
    }

    return { behavior: "deny", message: `Tool ${toolName} is not allowed in Phase 0` };
  };
}
