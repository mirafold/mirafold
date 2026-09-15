import type { AgentCapabilities, AgentName } from "../protocol";

/**
 * What each adapter can put on the wire (Phase TF R8), declared here so the
 * shell can state a capability difference instead of guessing from silence.
 * A `false` is a verified absence at the adapter's interface (recorded in
 * docs/ADAPTERS.md with the probe that established it), never a default.
 *
 * - Claude Code (Agent SDK 0.3.201): the SDK streams no stdout for a running
 *   tool — `tool_progress` carries elapsed time only — so live output is
 *   absent; reasoning streams; subagent/background task lifecycle rides
 *   task_started/progress/notification with child calls and prose.
 * - Codex (app-server, 0.153.4): command output streams
 *   (`item/commandExecution/outputDelta`); reasoning streams; a spawned
 *   child is announced by `subAgentActivity` and its own items (reasoning,
 *   prose, commands) arrive on the parent connection under the child's
 *   thread id — verified live 2026-09-15 — so the deck carries them.
 * - Gemini CLI (0.58 headless stream-json): `init | message | tool_use |
 *   tool_result | error | result` only — no live output, no thinking, no
 *   task lane.
 * - OpenCode (1.18): a running tool republishes `metadata.output`;
 *   reasoning parts stream; child sessions ride the shared event feed.
 */
export const AGENT_CAPABILITIES: Record<AgentName, Required<AgentCapabilities>> = {
  "claude-code": { liveOutput: false, thinking: true, tasks: true, childActivity: true },
  codex: { liveOutput: true, thinking: true, tasks: true, childActivity: true },
  "gemini-cli": { liveOutput: false, thinking: false, tasks: false, childActivity: false },
  opencode: { liveOutput: true, thinking: true, tasks: true, childActivity: true },
};

export function agentCapabilities(agent: AgentName): AgentCapabilities {
  return AGENT_CAPABILITIES[agent];
}
