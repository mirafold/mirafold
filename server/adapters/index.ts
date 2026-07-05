import { ClaudeCodeSession } from "./claude-code";
import { MockSession } from "./mock";
import type { AgentName, AgentSession, Backend } from "./types";

export type { AgentName, AgentSession, Backend } from "./types";

/** Does the named agent have credentials configured in the environment? */
function agentHasCredentials(agent: AgentName): boolean {
  switch (agent) {
    case "claude-code":
      // The Agent SDK resolves ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN, and a
      // custom ANTHROPIC_BASE_URL points at a proxy/local endpoint (which may
      // need no key) — so any of the three counts as "live". Keying only on the
      // API key would silently drop those setups into the mock.
      return Boolean(
        process.env.ANTHROPIC_API_KEY ||
          process.env.ANTHROPIC_AUTH_TOKEN ||
          process.env.ANTHROPIC_BASE_URL,
      );
    case "codex": // Phase P.2
    case "gemini-cli": // Phase P.5
      return false;
  }
}

/**
 * Which agent every session runs, resolved once from config — never
 * hardcoded. `GENUI_AGENT` names the terminal agent (default `claude-code`);
 * when it has no credentials we run the `MockSession` stand-in instead
 * (API-free dev). Secrets stay in the environment, read per-adapter.
 */
export function resolveBackend(): Backend {
  const requested = process.env.GENUI_AGENT;
  const agent: AgentName =
    requested === "codex" || requested === "gemini-cli" ? requested : "claude-code";
  return { agent, live: agentHasCredentials(agent), model: process.env.DEFAULT_MODEL };
}

/**
 * Build the session for a backend. The one seam where "which agent" becomes a
 * concrete engine: each real agent drives its own loop and normalizes to
 * `WireMsg`; a backend with no credentials falls back to the mock.
 */
export function createSession(backend: Backend, opts: { cwd: string }): AgentSession {
  if (!backend.live) return new MockSession();
  switch (backend.agent) {
    case "claude-code":
      return new ClaudeCodeSession({ workspaceDir: opts.cwd, model: backend.model });
    default:
      // Reached only if a non-claude agent reports credentials before its
      // adapter lands (P.2+). Fail loud rather than silently mislead.
      throw new Error(`no adapter for agent "${backend.agent}" yet (Phase P.2+)`);
  }
}
