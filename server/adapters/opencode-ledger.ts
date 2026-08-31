// OpenCode event kinds and part kinds the mapper deliberately does not show;
// anything else it does not handle is reported once per session (TS.7).
export const OPENCODE_IGNORED_EVENTS: Record<string, string> = {
  "server.connected": "transport bookkeeping",
  "server.heartbeat": "transport bookkeeping",
  "installation.updated": "OpenCode self-update bookkeeping",
  "installation.update-available": "OpenCode self-update bookkeeping",
  "session.updated": "metadata the registry derives itself",
  "session.deleted": "lifecycle the session owns",
  "session.diff": "the Changes panel watches the tree itself",
  "session.compacted": "TS.12: surface as the compaction notice",
  "message.removed": "editing bookkeeping",
  "message.part.removed": "editing bookkeeping",
  "file.edited": "the Changes panel watches the tree itself",
  "file.watcher.updated": "the Changes panel watches the tree itself",
  "storage.write": "OpenCode's own persistence",
  "lsp.client.diagnostics": "editor diagnostics not shown in the terminal transcript either",
  "ide.installed": "IDE plumbing",
  "pty.created": "OpenCode's own terminal panes",
  "pty.updated": "OpenCode's own terminal panes",
  "pty.exited": "OpenCode's own terminal panes",
  "pty.deleted": "OpenCode's own terminal panes",
  "vcs.branch.updated": "the status bar reads git itself",
  "command.executed": "slash-command bookkeeping",
  "todo.updated": "handled",
  // OpenCode 1.18's own TUI, catalog, integration, and workspace plumbing —
  // nothing the terminal transcript shows either.
  "tui.prompt.append": "OpenCode's own TUI",
  "tui.command.execute": "OpenCode's own TUI",
  "tui.toast.show": "OpenCode's own TUI",
  "tui.session.select": "OpenCode's own TUI",
  "server.instance.disposed": "transport bookkeeping",
  "global.disposed": "transport bookkeeping",
  "models-dev.refreshed": "model catalog bookkeeping; the picker re-reads the catalog",
  "catalog.updated": "model catalog bookkeeping; the picker re-reads the catalog",
  "integration.updated": "integrations administration",
  "integration.connection.updated": "integrations administration",
  "reference.updated": "reference bookkeeping for OpenCode's own UI",
  "plugin.added": "plugin administration",
  "project.updated": "project bookkeeping",
  "project.directories.updated": "project bookkeeping",
  "lsp.updated": "editor diagnostics not shown in the terminal transcript either",
  "mcp.tools.changed": "MCP administration; the render server is the only MCP Mirafold adds",
  "mcp.browser.open.failed": "MCP administration",
  "workspace.ready": "workspace/worktree plumbing for OpenCode's own UI",
  "workspace.failed": "workspace/worktree plumbing for OpenCode's own UI",
  "workspace.status": "workspace/worktree plumbing for OpenCode's own UI",
  "worktree.ready": "workspace/worktree plumbing for OpenCode's own UI",
  "worktree.failed": "workspace/worktree plumbing for OpenCode's own UI",
};
// OpenCode 1.18's newer per-session stream. The legacy `message.*` events
// the adapter consumes still carry the same content on the same /event
// feed; PLAN TS.13 decides whether to migrate. Ignored as a family so a
// session does not raise thirty notices for one turn.
export const OPENCODE_IGNORED_EVENT_PREFIXES = ["session.next."] as const;
export const opencodeEventIgnored = (type: string): boolean =>
  type in OPENCODE_IGNORED_EVENTS || OPENCODE_IGNORED_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix));
export const OPENCODE_HANDLED_EVENTS = [
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "session.status",
  "todo.updated",
  "session.created",
  "permission.asked",
  "permission.replied",
  "session.error",
  "session.idle",
] as const;
export const OPENCODE_HANDLED_PARTS = ["step-start", "text", "reasoning", "tool"] as const;
export const OPENCODE_IGNORED_PARTS: Record<string, string> = {
  "step-finish": "a step boundary; usage arrives on session.idle",
  snapshot: "OpenCode's own undo snapshots",
  "step-start": "handled",
};
