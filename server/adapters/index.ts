import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { ClaudeCodeSession } from "./claude-code";
import { CodexSession } from "./codex";
import { GeminiCliSession } from "./gemini-cli";
import { MockSession } from "./mock";
import type { AgentName, AgentSession, Backend } from "./types";
import type { AgentBackend, AgentInfo } from "../protocol";
import { allowedLocally, type CredentialKind } from "../provider-policy";
import { cachedLocalServers, hostKey, type LocalDialect, type LocalServer } from "../local-models";

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

/** One way an agent could run on this machine. `usable` is provider-policy's
 *  verdict; a present-but-prohibited subscription rides as `blocked` —
 *  listed visible, never hidden (Kyle's requirement (c), Phase N charter). */
export type BackendOption = {
  kind: Exclude<CredentialKind, "none">;
  usable: boolean;
  blocked?: boolean;
  detail?: string;
};

/**
 * EVERY way the named agent could run — one entry per detected credential,
 * no precedence collapse (N.1). `credentialKind()` stays the single-answer
 * view (its precedence order remains the default until N.5 lets a session
 * carry an explicit choice); this is the full menu the N.4 picker offers.
 * Order is the picker's display order: local endpoint, API key, subscription.
 */
export function backendOptions(agent: AgentName): BackendOption[] {
  const options: BackendOption[] = [];
  const add = (kind: Exclude<CredentialKind, "none">, detail?: string) => {
    const usable = allowedLocally(agent, kind);
    options.push({
      kind,
      usable,
      ...(kind === "subscription" && !usable ? { blocked: true } : {}),
      ...(detail ? { detail } : {}),
    });
  };
  switch (agent) {
    case "claude-code": {
      if (process.env.ANTHROPIC_BASE_URL) add("local", endpointDetail(agent));
      if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
        add("api-key", modelFor(agent));
      if (loginFileExists(process.env.CLAUDE_CONFIG_DIR, ".claude", ".credentials.json"))
        add("subscription");
      break;
    }
    case "codex": {
      if (process.env.OPENAI_API_KEY) add("api-key", modelFor(agent));
      if (loginFileExists(process.env.CODEX_HOME, ".codex", "auth.json")) add("subscription");
      break;
    }
    case "gemini-cli":
      if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)
        add("api-key", modelFor(agent));
      break;
  }
  return options;
}

// Which local-server API dialect each agent can drive (N.3): compatibility is
// the DIALECT, never the model — Ollama speaks the Anthropic shape (and the
// OpenAI one), LM Studio/vLLM/llama.cpp only the OpenAI one, and Gemini CLI
// has no BYO-endpoint path at all.
const AGENT_DIALECT: Record<AgentName, LocalDialect | null> = {
  "claude-code": "anthropic",
  codex: "openai",
  "gemini-cli": null,
};

/**
 * The full second-step menu for one agent (N.3): the N.1 credential options
 * plus every discovered local server the agent's dialect can drive. Pure —
 * `advertisedBackends` binds it to the live probe cache. When the
 * env-configured local endpoint (claude's ANTHROPIC_BASE_URL) names the same
 * host:port as a discovered compatible server, the discovered row wins — it
 * carries the model catalog; two rows for one server would be the kind of
 * confusion this phase exists to end.
 */
export function mergeBackends(
  agent: AgentName,
  options: BackendOption[],
  servers: LocalServer[],
): AgentBackend[] {
  const dialect = AGENT_DIALECT[agent];
  const discovered = dialect ? servers.filter((s) => s.dialects.includes(dialect)) : [];
  const discoveredHosts = new Set(
    discovered.map((s) => hostKey(s.endpoint)).filter((h): h is string => h !== undefined),
  );
  const envUrl = agent === "claude-code" ? process.env.ANTHROPIC_BASE_URL : undefined;
  const envHost = envUrl ? hostKey(envUrl) : undefined;
  const creds = options.filter(
    (o) => !(o.kind === "local" && envHost !== undefined && discoveredHosts.has(envHost)),
  );
  return [
    ...creds,
    ...discovered.map((s) => ({
      kind: "local" as const,
      usable: true,
      endpoint: s.endpoint,
      runtime: s.runtime,
      models: s.models,
    })),
  ];
}

/** mergeBackends against the live probe cache — what the hello advertises. */
function advertisedBackends(agent: AgentName): AgentBackend[] {
  return mergeBackends(agent, backendOptions(agent), cachedLocalServers());
}

/**
 * What onboarding advertises: each offerable agent, whether it's `live` (usable
 * locally now), and whether it's `blocked` — a prohibited subscription is
 * present, so the picker shows the API-key fix instead of a demo or a dead badge
 * (R.4i). `blocked` is additive/optional on the wire; old clients see `live:
 * false` and degrade to the demo path. N.3 adds `backends` — the full
 * second-step menu (omitted when empty: the row is a plain demo/credential
 * story and the picker needs no second step).
 */
export function availableAgents(): AgentInfo[] {
  return ADAPTER_AGENTS.map((agent) => {
    const kind = credentialKind(agent);
    const live = allowedLocally(agent, kind);
    const detail = live ? agentDetail(agent, kind) : undefined;
    const backends = advertisedBackends(agent);
    return {
      agent,
      live,
      ...(kind === "subscription" && !live ? { blocked: true } : {}),
      ...(detail ? { detail } : {}),
      ...(backends.length ? { backends } : {}),
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
  if (kind === "local") return endpointDetail(agent);
  return modelFor(agent) || undefined;
}

/** Picker label for the agent's env-configured BYO endpoint. Only claude-code
 *  carries one at the env level (`ANTHROPIC_BASE_URL`); a local Codex lives in
 *  `~/.codex/config.toml`, which we don't parse here. The `local` credential
 *  kind covers any BYO endpoint, so the label says where it actually points:
 *  "local endpoint" for a loopback host (Ollama), "custom endpoint" for a
 *  remote one (a hosted open-model API, e.g. DeepSeek). A malformed value
 *  falls back to the plain label — never echo raw env input onto the wire. */
function endpointDetail(agent: AgentName): string {
  const url = agent === "claude-code" ? process.env.ANTHROPIC_BASE_URL : undefined;
  if (url) {
    try {
      const u = new URL(url);
      const loopback =
        u.hostname === "localhost" || u.hostname === "[::1]" || u.hostname.startsWith("127.");
      return `${loopback ? "local" : "custom"} endpoint · ${u.host}`;
    } catch {
      // fall through to the plain label
    }
  }
  return "local endpoint";
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
 * Validate the onboarding picker's backend choice against CURRENT detection +
 * provider policy, and resolve it to a Backend (N.5). The client is NEVER
 * trusted: a forged kind, a prohibited subscription, a server that stopped
 * since the pick, or a model not in its catalog all refuse with a human
 * message down the existing create-error path — the picker shows it and the
 * user re-picks. `servers` defaults to the live probe cache (injectable for
 * tests).
 */
export function resolveChosenBackend(
  agent: AgentName,
  choice: unknown,
  servers: LocalServer[] = cachedLocalServers(),
): Backend | { error: string } {
  const c = (typeof choice === "object" && choice !== null ? choice : {}) as {
    kind?: unknown;
    endpoint?: unknown;
    model?: unknown;
  };
  const kind = c.kind;
  if (kind !== "api-key" && kind !== "subscription" && kind !== "local")
    return { error: "unknown backend choice" };
  const endpoint = typeof c.endpoint === "string" ? c.endpoint : undefined;
  const model = typeof c.model === "string" ? c.model : undefined;
  if (kind === "local" && endpoint) {
    // A discovered server: must still be running, dialect-compatible, and
    // serving the named model — the pick may be stale (picker raced a stop).
    const dialect = AGENT_DIALECT[agent];
    const server = dialect
      ? servers.find((s) => s.endpoint === endpoint && s.dialects.includes(dialect))
      : undefined;
    if (!server)
      return { error: "that local server is no longer running — start it and pick again" };
    if (model && !server.models.includes(model))
      return { error: "that model is no longer served — refresh and pick again" };
    return { agent, kind: "local", live: true, model, endpoint };
  }
  // A credential (or the env-configured endpoint): must be detected right now
  // AND usable under provider policy — a blocked subscription refuses here.
  const usable = backendOptions(agent).some((o) => o.kind === kind && o.usable);
  if (!usable) return { error: `that ${kind} option isn't available for this agent` };
  return { agent, kind, live: true, model: model ?? modelFor(agent) };
}

/**
 * Build the session for a backend. The one seam where "which agent" becomes a
 * concrete engine: each real agent drives its own loop and normalizes to
 * `WireMsg`; a backend with no credentials falls back to the mock. `kind` +
 * `endpoint` carry a chosen backend into the adapter (N.5); a default-resolved
 * backend passes its precedence kind, which the adapters treat exactly as the
 * pre-N behavior.
 */
export function createSession(backend: Backend, opts: { cwd: string }): AgentSession {
  if (!backend.live) return new MockSession();
  const kind = backend.kind === "none" ? undefined : backend.kind;
  switch (backend.agent) {
    case "claude-code":
      return new ClaudeCodeSession({
        workspaceDir: opts.cwd,
        model: backend.model,
        kind,
        endpoint: backend.endpoint,
      });
    case "codex":
      return new CodexSession({
        workspaceDir: opts.cwd,
        model: backend.model,
        kind,
        endpoint: backend.endpoint,
      });
    case "gemini-cli":
      return new GeminiCliSession({ workspaceDir: opts.cwd, model: backend.model });
  }
}
