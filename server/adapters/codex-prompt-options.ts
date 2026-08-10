import type { PromptOption } from "../protocol";

// Codex 0.147's user-visible TUI order and copy. Codex does not expose this
// client-side command registry through app-server (unlike skills/list), so the
// browser shell carries the installed generation's built-ins while `$` skills
// remain live provider data. Platform-only rows are filtered below.
const COMMANDS: Array<[string, string, string?]> = [
  ["model", "choose what model and reasoning effort to use"],
  ["ide", "include current selection, open files, and other context from your IDE"],
  ["permissions", "choose what Codex is allowed to do"],
  ["keymap", "remap TUI shortcuts"],
  ["vim", "toggle Vim mode for the composer"],
  ["setup-default-sandbox", "set up elevated agent sandbox"],
  ["experimental", "toggle experimental features"],
  ["approve", "approve one retry of a recent auto-review denial"],
  ["memories", "configure memory use and generation"],
  ["skills", "use skills to improve how Codex performs specific tasks"],
  ["import", "import setup, this project, and recent chats from Claude Code"],
  ["hooks", "view and manage lifecycle hooks"],
  ["review", "review my current changes and find issues", "[instructions]"],
  ["rename", "rename the current thread", "<name>"],
  ["new", "start a new chat during a conversation"],
  ["archive", "archive this session and exit"],
  ["delete", "permanently delete this session and exit"],
  ["resume", "resume a saved chat", "[session]"],
  ["fork", "fork the current chat"],
  ["app", "continue this session in the Desktop app"],
  ["init", "create an AGENTS.md file with instructions for Codex"],
  ["compact", "summarize conversation to prevent hitting the context limit"],
  ["plan", "switch to Plan mode"],
  ["goal", "set or view the goal for a long-running task"],
  ["agent", "switch the active agent thread"],
  ["side", "start a side conversation in an ephemeral fork"],
  ["btw", "start a side conversation in an ephemeral fork"],
  ["copy", "copy last response as markdown"],
  ["raw", "toggle raw scrollback mode for copy-friendly terminal selection"],
  ["diff", "show git diff (including untracked files)"],
  ["mention", "mention a file"],
  ["status", "show current session configuration and token usage"],
  ["usage", "view account usage or use a usage limit reset"],
  ["debug-config", "show config layers and requirement sources for debugging"],
  ["title", "configure which items appear in the terminal title"],
  ["statusline", "configure which items appear in the status line"],
  ["theme", "choose a syntax highlighting theme"],
  ["pets", "choose or hide the terminal pet"],
  ["mcp", "list configured MCP tools; use /mcp verbose for details"],
  ["apps", "manage apps"],
  ["plugins", "browse plugins"],
  ["logout", "log out of Codex"],
  ["quit", "exit Codex"],
  ["exit", "exit Codex"],
  ["feedback", "send logs to maintainers"],
  ["ps", "list background terminals"],
  ["stop", "stop all background terminals"],
  ["clear", "clear the terminal and start a new chat"],
  ["personality", "choose a communication style for Codex"],
  ["subagents", "switch the active agent thread"],
];

export function codexSlashOptions(): PromptOption[] {
  return COMMANDS
    .filter(([name]) => name !== "app" || process.platform === "darwin" || process.platform === "win32")
    .map(([name, description, argumentHint]) => ({
      trigger: "/" as const,
      value: `/${name}`,
      label: name,
      description,
      ...(argumentHint ? { argumentHint } : {}),
      kind: "command" as const,
      ...(name === "stop" ? { aliases: ["clean"] } : {}),
      ...(name === "pets" ? { aliases: ["pet"] } : {}),
    }));
}
