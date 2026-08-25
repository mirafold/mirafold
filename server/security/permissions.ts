import path from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";

// Tools allowed without a prompt — same as the terminal: local reads, plus the
// two bookkeeping tools whose only side effects are the agent's own task list
// and subagent spawn (a subagent's consequential calls still prompt on their
// own). No network egress. WebFetch/WebSearch are deliberately NOT here:
// the terminal prompts on undecided network fetches, and auto-allowing them
// would (a) diverge from that fidelity and (b) hand a prompt injection a
// zero-click exfil egress. They fall through to `ask` like any consequential
// call; a user's own settings.json allowlist still short-circuits them first.
const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
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
// read-only one — because the API key lives in .env and any file-reading tool
// would be an exfil source. Covers every auto-allowed reader that takes a path:
// Read/NotebookRead (file_path) AND Grep/Glob (path) — the latter two also
// return file contents / paths and would otherwise sidestep the Read guard.
// Defense-in-depth: still string-based (a symlink or `Bash cat .env` isn't
// caught — but Bash asks), so it closes the obvious routes, not every one.
// One source for WHICH filenames are secret: the tool guard below derives its
// daemon-cwd absolute pair from it, and `isSecretFile` (consumed by
// fs-folder-tree, fs-handlers, render-image) applies it by basename to any file
// under a session root — stricter there on purpose (a browsing UI invites
// wandering in a way a typed command doesn't), and derived from the same set
// so the guards can't drift.
const SECRET_FILE_BASENAMES = new Set([".env", ".env.local"]);
const SECRET_PATHS = new Set([...SECRET_FILE_BASENAMES].map((n) => path.resolve(n)));

// macOS and Windows resolve `.Env` and `.ENV` to the SAME file as `.env`, but a
// case-sensitive string compare treats them as different names — so a purely
// lexical guard misses `Read(".Env")` on those platforms and reads the secret
// back through an auto-allowed tool with no prompt, exactly the zero-click route
// this guard exists to close. Compare the way the host filesystem does. Linux is
// case-sensitive, so `.ENV` there is a genuinely different file and stays out of
// scope. Derived once from the platform; injectable so a case-sensitive CI host
// can still pin the case-insensitive behavior.
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

/** True when `p` names a secret env file (by basename) — the folder tree's
 *  content-read denial. Listing may still SHOW the file (honesty over
 *  hiding); only reading its contents is refused. On a case-insensitive
 *  filesystem `.Env`/`.ENV` name the same file as `.env`, so they match too. */
export const isSecretFile = (p: string, caseInsensitiveFs = CASE_INSENSITIVE_FS): boolean => {
  const base = path.basename(p);
  if (SECRET_FILE_BASENAMES.has(base)) return true;
  return caseInsensitiveFs && SECRET_FILE_BASENAMES.has(base.toLowerCase());
};

/** Does an auto-allowed reader's resolved target land on one of the daemon's
 *  own secret files? Case-folds on a case-insensitive filesystem so a
 *  case-variant spelling can't slip past the exact-string set. Exported for
 *  the guard's regression pin. */
export const resolvesToSecretFile = (
  resolvedTarget: string,
  caseInsensitiveFs = CASE_INSENSITIVE_FS,
): boolean => {
  if (SECRET_PATHS.has(resolvedTarget)) return true;
  if (!caseInsensitiveFs) return false;
  const lowered = resolvedTarget.toLowerCase();
  for (const secret of SECRET_PATHS) {
    if (secret.toLowerCase() === lowered) return true;
  }
  return false;
};
const READ_PATH_FIELD: Record<string, string> = {
  Read: "file_path",
  NotebookRead: "notebook_path",
  Grep: "path",
  Glob: "path",
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
 *   - local read-only tools and our side-effect-free UI tools (mcp__ui__*) pass;
 *   - network tools (WebFetch/WebSearch) and everything else consequential
 *     (Write/Edit/Bash/unknown) ASK — the terminal prompts on undecided fetches
 *     too, and asking denies a prompt injection a silent exfil egress. There is
 *     deliberately no blanket "auto-allow inside the workspace" — the terminal
 *     doesn't do that, so neither do we; a user allowlists the commands they
 *     want promptless in their settings.json exactly as in the terminal.
 */
export function makeCanUseTool(
  workspaceDir: string,
  ask: PermissionAsker,
  caseInsensitiveFs = CASE_INSENSITIVE_FS,
): CanUseTool {
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
      if (typeof target === "string" && resolvesToSecretFile(path.resolve(root, target), caseInsensitiveFs)) {
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
