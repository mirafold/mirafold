import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { ClaudeCodeSession } from "./claude-code";
import { CodexSession } from "./codex";
import { GeminiCliSession } from "./gemini-cli";
import { MockSession } from "./mock";
import type { AgentName, AgentSession, Backend } from "./types";
import { allowedLocally, type CredentialKind } from "../provider-policy";

export type { AgentName, AgentSession, Backend } from "./types";

/** Does `<$envDir | ~/subdir>/file` exist — the shape a terminal login writes
 *  (Claude's `.credentials.json`, Codex's `auth.json`)? `envDir` is each agent's
 *  own override for its config dir (the itest harness points it at an empty
 *  dir to force the mock). */
function loginFileExists(envDir: string | undefined, subdir: string, file: string): boolean {
  return existsSync(path.join(envDir ?? path.join(os.homedir(), subdir), file));
}

/**
 * What KIND of credential the named agent has configured — the input to the
 * per-provider policy (R.4i). We detect the kind so the policy can decide
 * whether it's usable at all: an Anthropic/Gemini subscription is DETECTED here
 * (so onboarding can say why it won't run) but treated as prohibited by
 * `provider-policy.ts`. A local/BYO endpoint (ANTHROPIC_BASE_URL) is its own
 * kind — the user pointed elsewhere, so first-party terms don't apply and
 * anything goes.
 */
function credentialKind(agent: AgentName): CredentialKind {
  switch (agent) {
    case "claude-code":
      // BYO endpoint (Ollama / proxy) first: the user pointed the SDK elsewhere,
      // so this is `local` (open, anything goes) regardless of any key set for it.
      if (process.env.ANTHROPIC_BASE_URL) return "local";
      // Anthropic first-party API key (or auth token) — the key never reaches
      // the wire.
      if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return "api-key";
      // A subscription login (`claude` in a terminal, no key) writes
      // ~/.claude/.credentials.json. The SDK runs on it, but Anthropic's terms
      // prohibit subscription use in a third-party app — detected so onboarding
      // can name the fix, then blocked by provider-policy.
      if (loginFileExists(process.env.CLAUDE_CONFIG_DIR, ".claude", ".credentials.json"))
        return "subscription";
      return "none";
    case "codex":
      // OpenAI API key → api-key. A `codex login` (ChatGPT subscription) writes
      // ~/.codex/auth.json → subscription: allowed for LOCAL use as a disclosed
      // gray area (provider-policy's disclosed-uncertainty rule, K.3 amendment
      // 2026-07-15) but always refused over the relay. CODEX_HOME overrides
      // the auth dir.
      if (process.env.OPENAI_API_KEY) return "api-key";
      if (loginFileExists(process.env.CODEX_HOME, ".codex", "auth.json")) return "subscription";
      return "none";
    case "gemini-cli":
      // A Google AI Studio API key only. The free "Login with Google" OAuth path
      // was deprecated for the CLI in 2026 (IneligibleTierError) AND Gemini's ToS
      // prohibits subscription use in third-party tools — so there is no
      // subscription kind to detect. GOOGLE_API_KEY is the CLI's other name.
      return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? "api-key" : "none";
  }
}

/**
 * Which agent every session runs, resolved once from config — never
 * hardcoded. `MIRAFOLD_AGENT` names the terminal agent (default `claude-code`);
 * when it has no credentials we run the `MockSession` stand-in instead
 * (API-free dev). Secrets stay in the environment, read per-adapter.
 */
export function resolveBackend(): Backend {
  return resolveBackendFor(defaultAgent());
}

/** The env-configured default agent — a pre-selection hint, never assumed. */
export function defaultAgent(): AgentName {
  const requested = process.env.MIRAFOLD_AGENT;
  return requested === "codex" || requested === "gemini-cli" ? requested : "claude-code";
}

/** Resolve one named agent's backend (kind + live + model), per-session (P.4). */
export function resolveBackendFor(agent: AgentName): Backend {
  const kind = credentialKind(agent);
  // `live` ⇒ the REAL agent runs. A prohibited subscription (claude/gemini —
  // written bans; codex only if provider-policy ever flips it) is NOT live —
  // it falls back to the mock, so we never actually drive it — and onboarding
  // shows it as `blocked` with the API-key fix (R.4i).
  return { agent, kind, live: allowedLocally(agent, kind), model: modelFor(agent) };
}

// Agents with a landed adapter — the onboarding picker's universe.
const ADAPTER_AGENTS: AgentName[] = ["claude-code", "codex", "gemini-cli"];

/**
 * What onboarding advertises: each offerable agent, whether it's `live` (usable
 * locally now), and whether it's `blocked` — a prohibited subscription is
 * present, so the picker shows the API-key fix instead of a demo or a dead badge
 * (R.4i). `blocked` is additive/optional on the wire; old clients see `live:
 * false` and degrade to the demo path.
 */
export function availableAgents(): {
  agent: AgentName;
  live: boolean;
  blocked?: boolean;
  detail?: string;
}[] {
  return ADAPTER_AGENTS.map((agent) => {
    const kind = credentialKind(agent);
    const live = allowedLocally(agent, kind);
    const detail = live ? agentDetail(agent, kind) : undefined;
    return {
      agent,
      live,
      ...(kind === "subscription" && !live ? { blocked: true } : {}),
      ...(detail ? { detail } : {}),
    };
  });
}

/**
 * A short "what's behind this row" label for a LIVE agent, so the picker
 * isn't a bare "ready" — the confusion a local-model user hits ("I don't see my
 * model"). A `local` kind shows the endpoint it was pointed at; otherwise a
 * configured model override, if any. Honest scope: the TRULY resolved model
 * only arrives from the engine's init on the first turn (F.3, the status bar) —
 * this is the CONFIGURED target, which is exactly what was invisible before (R.4k).
 */
function agentDetail(agent: AgentName, kind: CredentialKind): string | undefined {
  if (kind === "local") {
    const host = endpointHost(agent);
    return host ? `local endpoint · ${host}` : "local endpoint";
  }
  return modelFor(agent) || undefined;
}

/** The host of an agent's env-configured local/BYO endpoint, if any. Only
 *  claude-code carries one at the env level (`ANTHROPIC_BASE_URL`); a local
 *  Codex lives in `~/.codex/config.toml`, which we don't parse here. */
function endpointHost(agent: AgentName): string | undefined {
  if (agent !== "claude-code") return undefined;
  const url = process.env.ANTHROPIC_BASE_URL;
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    // Malformed value: don't echo raw env input onto the wire — agentDetail
    // falls back to a plain "local endpoint" label with no host.
    return undefined;
  }
}

/**
 * The model is agent-specific — never shared across agents. `DEFAULT_MODEL` is
 * a Claude model id and must not be forced onto Codex (which would reject it).
 * Each agent reads its own override; when unset the adapter passes no model, so
 * the agent inherits its own config default (faithful skin — inherit, not invent).
 */
function modelFor(agent: AgentName): string | undefined {
  switch (agent) {
    case "claude-code":
      return process.env.DEFAULT_MODEL;
    case "codex":
      return process.env.CODEX_MODEL;
    case "gemini-cli":
      return process.env.GEMINI_MODEL;
  }
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
    case "codex":
      return new CodexSession({ workspaceDir: opts.cwd, model: backend.model });
    case "gemini-cli":
      return new GeminiCliSession({ workspaceDir: opts.cwd, model: backend.model });
  }
}
