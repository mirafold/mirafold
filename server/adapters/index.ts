import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { ClaudeCodeSession } from "./claude-code";
import { CodexSession } from "./codex";
import { GeminiCliSession } from "./gemini-cli";
import { OpenCodeSession, parseModelPin } from "./opencode";
import { MockSession } from "./mock";
import { installedAgentBin } from "./types";
import type { AgentName, AgentSession, Backend } from "./types";
import type { AgentBackend, AgentInfo } from "../protocol";
import { allowedLocally, type CredentialKind } from "../provider-policy";
import { cachedLocalServers, hostKey, type LocalDialect, type LocalServer } from "../local-models";
import { codexConfigProvider, codexProviders, type CodexProviderEntry } from "./codex-config";
import { wasLoadedFromProjectEnv } from "../project-env";

export type { AgentName, AgentSession, Backend } from "./types";
export { errText } from "./types";
import { envInt } from "../env";

// Credential probes ride onboarding's open-picker poll, several per pass —
// each path's answer is held briefly so a pass costs one stat per file. The
// TTL must stay short: a fresh login (or logout) still shows within a couple
// of seconds, which is the poll's whole point.
const CRED_PROBE_TTL_MS = envInt("CRED_PROBE_TTL_MS", 2_000);
const credProbeCache = new Map<string, { at: number; value: boolean }>();

// Configured endpoint URLs are server-side configuration and may themselves
// carry URL auth or signed query parameters. The browser gets only a stable
// per-daemon handle. Bounded because tests and unusual process.env mutation
// can cycle configuration even though production loads it once at startup.
const configuredBackendIds = new Map<string, string>();

function opaqueConfiguredBackendId(
  agent: AgentName,
  endpoint: string,
  auth: NonNullable<Backend["endpointAuth"]>,
): string {
  const key = `${agent}\0${auth}\0${endpoint}`;
  const existing = configuredBackendIds.get(key);
  if (existing) return existing;
  if (configuredBackendIds.size >= 128) configuredBackendIds.clear();
  const id = randomUUID();
  configuredBackendIds.set(key, id);
  return id;
}

/** Which credential, if any, is allowed to accompany the configured Claude
 * endpoint. A checkout-supplied endpoint may use only a credential supplied
 * by that same constrained project configuration; it can never redirect a
 * parent-only daemon secret. */
function configuredClaudeEndpointAuth(): NonNullable<Backend["endpointAuth"]> {
  const endpointFromProject = wasLoadedFromProjectEnv("ANTHROPIC_BASE_URL");
  const apiKeyAllowed =
    Boolean(process.env.ANTHROPIC_API_KEY) &&
    (!endpointFromProject || wasLoadedFromProjectEnv("ANTHROPIC_API_KEY"));
  const authTokenAllowed =
    Boolean(process.env.ANTHROPIC_AUTH_TOKEN) &&
    (!endpointFromProject || wasLoadedFromProjectEnv("ANTHROPIC_AUTH_TOKEN"));
  if (apiKeyAllowed) return "api-key";
  if (authTokenAllowed) return "auth-token";
  return "none";
}

/** Does `<$envDir | ~/subdir>/file` exist — the shape a terminal login writes
 *  (Claude's `.credentials.json`, Codex's `auth.json`)? `envDir` is each agent's
 *  own override for its config dir (the itest harness points it at an empty
 *  dir to force the mock). */
function loginFileExists(envDir: string | undefined, subdir: string, file: string): boolean {
  const p = path.join(envDir ?? path.join(os.homedir(), subdir), file);
  const hit = credProbeCache.get(p);
  if (hit && Date.now() - hit.at < CRED_PROBE_TTL_MS) return hit.value;
  // Keys are a handful of real config paths; the guard only caps the
  // pathological case (a long-lived process cycling override dirs).
  if (credProbeCache.size > 64) credProbeCache.clear();
  const value = existsSync(p);
  credProbeCache.set(p, { at: Date.now(), value });
  return value;
}

/**
 * What KIND of credential the named agent has configured — the input to the
 * per-provider policy (R.4i). We detect the kind so the policy can decide
 * whether it's usable at all: an Anthropic/Gemini subscription is DETECTED here
 * (so onboarding can say why it won't run) but treated as prohibited by
 * `provider-policy.ts`. A local/BYO endpoint (claude's ANTHROPIC_BASE_URL,
 * codex's config.toml default provider) is its own kind — the user pointed
 * elsewhere, so first-party terms don't apply and anything goes.
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
      // BYO provider first, symmetric with claude's BASE_URL rule above: a
      // default `model_provider` in ~/.codex/config.toml (Ollama, OpenRouter —
      // docs/local-models.md) means the user pointed Codex elsewhere, and the
      // terminal `codex` would use it regardless of any OPENAI_API_KEY — the
      // env key only authenticates the first-party provider it's not using.
      // Detecting it here is what retires the dummy-key recipe.
      if (codexConfigProvider()) return "local";
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
    case "opencode": {
      // Hello-time detection is deliberately SHALLOW (OC.3): the truthful,
      // provider-resolved classification needs the engine's own catalog,
      // which only a running `opencode serve` can give — so it's enforced at
      // session start (opencode.ts enforceProviderPolicy), the same
      // never-trust-the-pick posture as resolveChosenBackend. Here: the
      // binary plus a stored-credential file (existence only, the
      // claude/codex precedent — its CONTENTS stay unread) reads as
      // "api-key", and a session whose pinned provider turns out to be a
      // subscription OAuth or unclassified is refused at start with the
      // reason. A config-only setup (e.g. Ollama declared in opencode.json,
      // no auth.json) detects as none until OC.4's picker probes the engine.
      if (!installedAgentBin("OPENCODE_BIN", "opencode")) return "none";
      const dataDir = process.env.XDG_DATA_HOME
        ? path.join(process.env.XDG_DATA_HOME, "opencode")
        : undefined;
      // No stored credential ⇒ the built-in free Zen gateway still backs the
      // engine out of the box — "gateway", the Zen-opened kind (2026-08-13):
      // usable locally with its disclosure, never over the relay.
      return loginFileExists(dataDir, path.join(".local", "share", "opencode"), "auth.json")
        ? "api-key"
        : "gateway";
    }
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
  return requested === "codex" || requested === "gemini-cli" || requested === "opencode"
    ? requested
    : "claude-code";
}

/** Resolve one named agent's backend (kind + live + model), per-session (P.4). */
export function resolveBackendFor(agent: AgentName): Backend {
  const kind = credentialKind(agent);
  // `live` ⇒ the REAL agent runs. A prohibited subscription (claude/gemini —
  // written bans; codex only if provider-policy ever flips it) is NOT live —
  // it falls back to the mock, so we never actually drive it — and onboarding
  // shows it as `blocked` with the API-key fix (R.4i).
  const backend: Backend = {
    agent,
    kind,
    live: allowedLocally(agent, kind),
    model: modelFor(agent),
  };
  if (kind === "local" && agent === "claude-code") {
    const endpoint = validEndpointUrl(process.env.ANTHROPIC_BASE_URL);
    if (endpoint) {
      backend.endpoint = endpoint;
      backend.endpointSource = "configured";
      backend.endpointAuth = configuredClaudeEndpointAuth();
    } else {
      // Malformed configured input still reaches the adapter's honest error
      // path, but it never inherits either real credential while doing so.
      backend.endpointAuth = "none";
    }
  } else if (kind === "local" && agent === "codex") {
    const provider = codexConfigProvider()?.provider;
    if (provider) backend.provider = provider;
  } else if (agent === "opencode") {
    // The pinned provider (OPENCODE_MODEL's provider half) — the input the
    // relay gate and the OC.3 session-start classification both judge.
    const provider = parseModelPin(backend.model)?.providerID;
    if (provider) backend.provider = provider;
  }
  return backend;
}

// Agents with a landed adapter — the onboarding picker's universe.
export const ADAPTER_AGENTS: AgentName[] = ["claude-code", "codex", "gemini-cli", "opencode"];

/** One way an agent could run on this machine. `usable` is provider-policy's
 *  verdict; a present-but-prohibited subscription rides as `blocked` —
 *  listed visible, never hidden (Kyle's requirement (c), Phase N charter).
 *  `provider`/`hint` ride to the wire (a config-declared provider row and
 *  why it's unusable); `endpointUrl` and its auth/source are internal-only.
 *  A Claude configured row exposes `backendId`, an opaque daemon handle. */
export type BackendOption = {
  kind: Exclude<CredentialKind, "none">;
  usable: boolean;
  blocked?: boolean;
  detail?: string;
  model?: string;
  provider?: string;
  hint?: string;
  endpointUrl?: string;
  backendId?: string;
  endpointSource?: Backend["endpointSource"];
  endpointAuth?: Backend["endpointAuth"];
};

/**
 * EVERY way the named agent could run — one entry per detected credential,
 * no precedence collapse (N.1). `credentialKind()` stays the single-answer
 * view (its precedence order remains the default until N.5 lets a session
 * carry an explicit choice); this is the full menu the N.4 picker offers.
 * Order is the picker's display order: local endpoint, API key, subscription.
 * Every row carries the `model` it would run when config/env determines it —
 * a row must never commit the user to a model it didn't name.
 */
export function backendOptions(agent: AgentName): BackendOption[] {
  const options: BackendOption[] = [];
  // A credential row's model is the agent's own env override; with none set
  // the agent resolves its own default and the row stays silent rather than
  // guess. (Codex's config `model` is deliberately NOT it: a pick that forces
  // the first-party provider neutralizes that model — codex.ts.)
  const addCredentialRow = (
    kind: Exclude<CredentialKind, "none">,
    detail?: string,
    endpointUrl?: string,
    endpointAuth?: Backend["endpointAuth"],
  ) => {
    const usable = allowedLocally(agent, kind);
    const model = modelFor(agent);
    options.push({
      kind,
      usable,
      ...(kind === "subscription" && !usable ? { blocked: true } : {}),
      ...(detail ? { detail } : {}),
      ...(model ? { model } : {}),
      ...(endpointUrl ? { endpointUrl } : {}),
      ...(endpointUrl && kind === "local" && agent === "claude-code"
        ? {
            backendId: opaqueConfiguredBackendId(agent, endpointUrl, endpointAuth ?? "none"),
            endpointSource: "configured" as const,
            endpointAuth: endpointAuth ?? "none",
          }
        : {}),
    });
  };
  switch (agent) {
    case "claude-code": {
      if (process.env.ANTHROPIC_BASE_URL) {
        addCredentialRow(
          "local",
          endpointDetail(agent),
          validEndpointUrl(process.env.ANTHROPIC_BASE_URL),
          configuredClaudeEndpointAuth(),
        );
      }
      if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) addCredentialRow("api-key");
      if (loginFileExists(process.env.CLAUDE_CONFIG_DIR, ".claude", ".credentials.json"))
        addCredentialRow("subscription");
      break;
    }
    case "codex": {
      // Full optionality, terminal-default first: one row per provider the
      // user's own config.toml declares, ordered so the first row is what
      // terminal codex itself would run — the custom default provider when
      // one is set, else the first-party rows.
      const { defaultRow, otherRows } = codexProviderRows();
      if (defaultRow) options.push(defaultRow);
      if (process.env.OPENAI_API_KEY) addCredentialRow("api-key");
      if (loginFileExists(process.env.CODEX_HOME, ".codex", "auth.json")) addCredentialRow("subscription");
      options.push(...otherRows);
      break;
    }
    case "gemini-cli":
      if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) addCredentialRow("api-key");
      break;
    case "opencode": {
      // One shallow row: a stored credential (or the built-in Zen gateway) —
      // existence only; the provider-resolved truth is enforced at session
      // start (OC.3). Richer per-provider rows need a running engine; that
      // probe is a post-OC.5 idea, not a hello-time cost.
      const kind = credentialKind("opencode");
      if (kind === "api-key" || kind === "gateway") addCredentialRow(kind);
      break;
    }
  }
  return options;
}

/**
 * One picker row per provider the user declared in `~/.codex/config.toml`,
 * plus an undeclared custom default (e.g. the built-in `oss` made default
 * without its own table). The first-party `openai` id never rows here — the
 * api-key/subscription rows own that world. A row is usable only when the
 * provider's `env_key` variable is actually present (or it declares none —
 * a keyless local server); a missing key shows the row with the exact fix,
 * never a session that dies on its first turn.
 *
 * Each row also names the model it will run: a provider pick forces the
 * provider id and passes NO model, so Codex resolves the config's own
 * top-level `model` — which is what the user would get in a terminal, and
 * what the row was hiding before (2026-07-20).
 */
function codexProviderRows(): { defaultRow?: BackendOption; otherRows: BackendOption[] } {
  const { defaultProvider, model, entries } = codexProviders();
  const all: CodexProviderEntry[] = [...entries];
  if (defaultProvider && defaultProvider !== "openai" && !entries.some((e) => e.id === defaultProvider))
    all.unshift({ id: defaultProvider });
  const rows = new Map<string, BackendOption>();
  for (const e of all) {
    if (e.id === "openai") continue;
    const keyMissing = e.envKey !== undefined && !process.env[e.envKey];
    rows.set(e.id, {
      kind: "local",
      usable: allowedLocally("codex", "local") && !keyMissing,
      provider: e.id,
      detail: providerRowDetail(e),
      ...(model ? { model } : {}),
      ...(e.baseUrl ? { endpointUrl: e.baseUrl } : {}),
      ...(keyMissing ? { hint: `set ${e.envKey} in the daemon environment to use this provider` } : {}),
    });
  }
  const defaultRow =
    defaultProvider && defaultProvider !== "openai" ? rows.get(defaultProvider) : undefined;
  return { defaultRow, otherRows: [...rows.values()].filter((r) => r !== defaultRow) };
}

/** A provider row's browser-safe label: the display name the user gave it
 * (else its id). Its configured base URL remains server-side because even a
 * hostname can disclose private tenant or network identity. */
function providerRowDetail(e: CodexProviderEntry): string {
  return e.name ?? e.id;
}

// Which local-server API dialect each agent can drive (N.3): compatibility is
// the DIALECT, never the model — Ollama speaks the Anthropic shape (and the
// OpenAI one), LM Studio/vLLM/llama.cpp only the OpenAI one, and Gemini CLI
// has no BYO-endpoint path at all.
const AGENT_DIALECT: Record<AgentName, LocalDialect | null> = {
  "claude-code": "anthropic",
  codex: "openai",
  "gemini-cli": null,
  // OpenCode reaches local servers through its own provider config, not a
  // Mirafold-injected endpoint — no discovered-server rows until OC.4 decides.
  opencode: null,
};

/**
 * The full second-step menu for one agent (N.3): the N.1 credential options
 * plus every discovered local server the agent's dialect can drive. Pure —
 * `advertisedBackends` binds it to the live probe cache. When the configured
 * BYO endpoint (claude's ANTHROPIC_BASE_URL, codex's config.toml provider)
 * names the same host:port as a discovered compatible server, the discovered
 * row wins — it carries the model catalog; two rows for one server would be
 * the kind of confusion this phase exists to end.
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
  const creds = options
    .filter((o) => {
      if (o.kind !== "local") return true;
      // A provider row and Claude's env row both know their exact URL. The
      // fallback retains compatibility with callers constructing old-style
      // BackendOption fixtures without endpointUrl.
      const url = o.endpointUrl ?? byoEndpointUrl(agent);
      const host = url ? hostKey(url) : undefined;
      return !(host !== undefined && discoveredHosts.has(host));
    })
    .map(({ endpointUrl, endpointSource: _source, endpointAuth: _auth, ...wire }) => ({
      ...wire,
      ...(endpointUrl && isLoopbackEndpointUrl(endpointUrl) ? { onDevice: true as const } : {}),
    }));
  return [
    ...creds,
    ...discovered.map((s) => ({
      kind: "local" as const,
      usable: true,
      endpoint: s.endpoint,
      ...(isLoopbackEndpointUrl(s.endpoint) ? { onDevice: true as const } : {}),
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
      // Gemini sunset (Kyle, 2026-08-13): Google retired Gemini CLI upstream
      // on 2026-06-18 (provider-policy.ts R.6 note). The adapter keeps
      // working while API keys do — deprecated, visible, never hidden.
      ...(agent === "gemini-cli" ? { deprecated: "retired upstream" } : {}),
      ...(kind === "subscription" && !live ? { blocked: true } : {}),
      // The KIND rides as a fact; the client owns its wording (agents-meta's
      // backendLabel), so the one-click row and the second step say the same
      // words about the same backing.
      ...(live && kind !== "none" ? { kind } : {}),
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

/** The agent's configured BYO endpoint URL, when it carries one: claude-code's
 *  is env-level (`ANTHROPIC_BASE_URL`); codex's is the default provider's
 *  `base_url` in `~/.codex/config.toml` (read by codex-config.ts — a provider
 *  declared without one, e.g. the built-in `oss`, yields no URL and just the
 *  plain label below). */
function byoEndpointUrl(agent: AgentName): string | undefined {
  if (agent === "claude-code") return process.env.ANTHROPIC_BASE_URL;
  if (agent === "codex") return codexConfigProvider()?.baseUrl;
  return undefined;
}

/** A configured endpoint is safe to advertise only when it is a real URL.
 * Malformed operator input still gets the existing generic local row and
 * adapter error path; its raw bytes never become browser-visible metadata. */
function validEndpointUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** Exact, DNS-independent loopback classification for UI privacy claims.
 * Hostname prefixes are never enough: `127.attacker.test` is an ordinary
 * remote DNS name. URL parsing canonicalizes numeric IPv4 spellings first. */
export function isLoopbackEndpointUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (hostname === "localhost" || hostname === "::1") return true;
    if (isIP(hostname) === 4) return Number(hostname.split(".", 1)[0]) === 127;
    if (isIP(hostname) !== 6) return false;
    // Node canonicalizes IPv4-mapped addresses to ::ffff:7f00:1 form. They
    // still route to the IPv4 loopback and deserve the same on-device tag.
    const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(hostname);
    return mapped ? (Number.parseInt(mapped[1], 16) >>> 8) === 0x7f : false;
  } catch {
    return false;
  }
}

/** Picker label for the agent's configured BYO endpoint. The browser learns
 * only whether the destination is exact loopback: configured hostnames can
 * disclose tenant or private-network identity even after URL auth/query data
 * is removed. A malformed value falls back to the plain local label. */
function endpointDetail(agent: AgentName): string {
  const url = byoEndpointUrl(agent);
  if (url) {
    try {
      new URL(url);
      return isLoopbackEndpointUrl(url) ? "local endpoint" : "custom endpoint";
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
    case "opencode":
      // `provider/model` (OpenCode's own addressing); a bare model id pins
      // nothing and the engine default runs — opencode.ts parseModelPin.
      return process.env.OPENCODE_MODEL;
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
    backendId?: unknown;
    provider?: unknown;
    model?: unknown;
  };
  const kind = c.kind;
  if (kind !== "api-key" && kind !== "subscription" && kind !== "local" && kind !== "gateway")
    return { error: "unknown backend choice" };
  if (
    (c.endpoint !== undefined && typeof c.endpoint !== "string") ||
    (c.backendId !== undefined && typeof c.backendId !== "string") ||
    (c.provider !== undefined && typeof c.provider !== "string") ||
    (c.model !== undefined && typeof c.model !== "string")
  ) {
    return { error: "unknown backend choice" };
  }
  const endpoint = typeof c.endpoint === "string" ? c.endpoint : undefined;
  const backendId = typeof c.backendId === "string" ? c.backendId : undefined;
  const provider = typeof c.provider === "string" ? c.provider : undefined;
  const model = typeof c.model === "string" ? c.model : undefined;
  const identityCount = [endpoint, backendId, provider].filter((value) => value !== undefined).length;
  if (identityCount > 1 || (kind !== "local" && identityCount > 0)) {
    return { error: "unknown backend choice" };
  }
  if (kind === "local" && backendId) {
    if (agent !== "claude-code") return { error: "unknown backend choice" };
    const configured = backendOptions(agent).find(
      (option) =>
        option.kind === "local" &&
        option.usable &&
        option.backendId === backendId &&
        option.endpointUrl,
    );
    if (!configured?.endpointUrl) {
      return { error: "that configured endpoint is no longer available — pick again" };
    }
    return {
      agent,
      kind: "local",
      live: true,
      model: model ?? configured.model ?? modelFor(agent),
      endpoint: configured.endpointUrl,
      endpointSource: "configured",
      endpointAuth: configured.endpointAuth ?? "none",
    };
  }
  if (kind === "local" && provider) {
    // A config-declared provider: must still be in the user's config.toml
    // (they may have edited it since the hello), and its env key — the pick's
    // whole promise — must actually be present right now.
    if (agent !== "codex") return { error: "unknown backend choice" };
    const { defaultProvider, entries } = codexProviders();
    const entry =
      entries.find((e) => e.id === provider) ??
      (provider === defaultProvider ? { id: provider } : undefined);
    if (!entry || provider === "openai")
      return { error: "that provider is no longer in the codex config — pick again" };
    if (entry.envKey && !process.env[entry.envKey])
      return { error: `that provider needs ${entry.envKey} set in the daemon environment` };
    return { agent, kind: "local", live: true, model, provider };
  }
  if (kind === "local" && endpoint) {
    // Compatibility with a cached pre-UX.8 picker: accept a configured URL
    // only when it still exactly matches this daemon's current internal row.
    // New hellos never reveal this URL and use backendId above.
    const configured =
      agent === "claude-code"
        ? backendOptions(agent).find(
            (option) =>
              option.kind === "local" && option.usable && option.endpointUrl === endpoint,
          )
        : undefined;
    if (configured?.endpointUrl) {
      return {
        agent,
        kind: "local",
        live: true,
        model: model ?? configured.model ?? modelFor(agent),
        endpoint: configured.endpointUrl,
        endpointSource: "configured",
        endpointAuth: configured.endpointAuth ?? "none",
      };
    }
    // A discovered server must still be running, dialect-compatible, and
    // serving the named model — the pick may be stale (picker raced a stop).
    const dialect = AGENT_DIALECT[agent];
    const server = dialect
      ? servers.find((s) => s.endpoint === endpoint && s.dialects.includes(dialect))
      : undefined;
    if (!server)
      return { error: "that local server is no longer running — start it and pick again" };
    if (model && !server.models.includes(model))
      return { error: "that model is no longer served — refresh and pick again" };
    return {
      agent,
      kind: "local",
      live: true,
      model,
      endpoint,
      endpointSource: "discovered",
      ...(agent === "claude-code" ? { endpointAuth: "none" as const } : {}),
    };
  }
  if (kind === "local" && agent === "claude-code") {
    // Old clients represent the daemon's single configured row by kind alone.
    // Resolve that identifier-free choice to the CURRENT internal row; never
    // fall back to inheriting credentials independently from its endpoint.
    const configured = backendOptions(agent).find(
      (option) => option.kind === "local" && option.usable && option.endpointUrl,
    );
    if (configured?.endpointUrl) {
      return {
        agent,
        kind: "local",
        live: true,
        model: model ?? configured.model ?? modelFor(agent),
        endpoint: configured.endpointUrl,
        endpointSource: "configured",
        endpointAuth: configured.endpointAuth ?? "none",
      };
    }
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
export function createSession(
  backend: Backend,
  opts: { cwd: string; resumeId?: string },
): AgentSession {
  if (!backend.live) return new MockSession(backend.agent);
  // "gateway" is OpenCode-only (Zen) and the OpenCode adapter classifies its
  // own backing at start — the per-adapter `kind` option below is for the
  // engines that take one, and none of them can be gateway-backed.
  const kind =
    backend.kind === "none" || backend.kind === "gateway" ? undefined : backend.kind;
  switch (backend.agent) {
    case "claude-code":
      return new ClaudeCodeSession({
        workspaceDir: opts.cwd,
        model: backend.model,
        kind,
        endpoint: backend.endpoint,
        endpointAuth: backend.endpointAuth,
        resumeId: opts.resumeId,
      });
    case "codex":
      return new CodexSession({
        workspaceDir: opts.cwd,
        model: backend.model,
        kind,
        endpoint: backend.endpoint,
        provider: backend.provider,
        resumeId: opts.resumeId,
      });
    case "gemini-cli":
      return new GeminiCliSession({
        workspaceDir: opts.cwd,
        model: backend.model,
        resumeId: opts.resumeId,
      });
    case "opencode":
      return new OpenCodeSession({
        workspaceDir: opts.cwd,
        model: backend.model,
        resumeId: opts.resumeId,
      });
  }
}
