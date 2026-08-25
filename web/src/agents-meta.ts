import type { AgentName } from "@protocol";

// Shared display metadata for the offerable agents. LABEL is the human
// name; CONNECT_HINT is the one concrete action that makes that agent live —
// shown on the onboarding picker's credential-less rows and in the in-session
// demo banner, so "no credentials" is never a dead end.

export const LABEL: Record<AgentName, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  opencode: "OpenCode",
};

// The hint for a NO-credentials agent — the one action that makes it
// live, naming WHERE to get the credential. Claude/Gemini never suggest a
// subscription login (prohibited in writing). Codex suggests `codex login`
// under the disclosed-uncertainty rule (provider-policy.ts): the wording must
// state UNCERTAINTY, never permission — a phrasing like "OpenAI permits it"
// overclaims and must not appear. Every
// closed agent also names the local/BYO route so "run your own model" reads
// as supported, not absent.
export const CONNECT_HINT: Record<AgentName, string> = {
  "claude-code":
    "set ANTHROPIC_API_KEY (get one at console.anthropic.com) — or point ANTHROPIC_BASE_URL at a local model (Ollama) or a hosted open-model API (DeepSeek, Kimi) with that provider's key",
  codex:
    "run `codex login` (ChatGPT subscription — not clearly permitted by OpenAI's terms, tolerated in practice; your account, your call) or set OPENAI_API_KEY (platform.openai.com/api-keys) — or point Codex at a local model (Ollama/LM Studio/vLLM) or any OpenAI-compatible provider (e.g. OpenRouter) via ~/.codex/config.toml (recipe: docs/local-models.md)",
  "gemini-cli":
    "set GEMINI_API_KEY (get one at aistudio.google.com/apikey) — Gemini has no local path",
  opencode:
    "install opencode (opencode.ai) — its built-in free Zen models then work out of the box (set OPENCODE_MODEL=<provider>/<model>, e.g. opencode/big-pickle; free-period prompts may train the models). Or connect a provider API key via `opencode auth login`, or declare a local/BYO provider (Ollama, OpenRouter, …) in your opencode config. A ChatGPT login works too — not clearly permitted by OpenAI's terms, tolerated in practice; your account, your call. Other subscription logins (Copilot, …) aren't usable",
};

// The hint for a BLOCKED agent — a prohibited subscription credential is
// present. Distinct from CONNECT_HINT because the honest message names WHY it
// won't run, not just how to fix it. Claude/Gemini land here today; the codex
// entry is the disclosed-uncertainty rule's graceful-degradation half — it
// shows the moment provider-policy flips codex off (one line, if OpenAI ever
// enforces), so keep it current even while unused.
export const BLOCKED_HINT: Partial<Record<AgentName, string>> = {
  "claude-code":
    "a Claude subscription can't be used in third-party apps (Anthropic's terms) — set ANTHROPIC_API_KEY to use Claude here",
  codex:
    "a ChatGPT subscription can no longer be used in third-party apps (OpenAI's call, not ours) — set OPENAI_API_KEY to use Codex here",
  "gemini-cli":
    "a Gemini subscription can't be used in third-party apps (Google's terms) — set GEMINI_API_KEY to use Gemini here",
};

// Look up through these, never index the records directly. The records
// are exhaustive over TODAY'S closed AgentName union, but the wire is
// additive-only: a newer daemon can announce an agent this bundle has never
// heard of, and it must display as its raw name — not `undefined`.

function tolerantLookup(record: Partial<Record<AgentName, string>>, agent: string): string | undefined {
  return (record as Record<string, string | undefined>)[agent];
}

export function agentLabel(agent: string): string {
  return tolerantLookup(LABEL, agent) ?? agent;
}

export function connectHint(agent: string): string | undefined {
  return tolerantLookup(CONNECT_HINT, agent);
}

export function blockedHint(agent: string): string | undefined {
  return tolerantLookup(BLOCKED_HINT, agent);
}

// ── The second-step backend picker's copy ────────────────────────────────

/** Row label for a backend kind. Credentials carry the provider's own name —
 *  the bare kind doesn't tell a multi-credential user WHICH one it means.
 *  True of subscriptions ("Claude subscription" vs "ChatGPT subscription")
 *  and of API keys, since a config-declared provider row can be key-based
 *  too — an OpenRouter row is every bit as much "an API key" as the
 *  first-party one.
 *
 *  Each name is the VENDOR'S own name for the thing you buy, not our
 *  paraphrase: Google sells the Gemini Developer API and titles
 *  its docs "Get a Gemini API key" — "Google API key" is the generic Cloud
 *  term for hundreds of APIs, and we only ever said it because GOOGLE_API_KEY
 *  is an accepted env var (that one is the Vertex path, a different product).
 *  Anthropic's is the Claude API, renamed from "Anthropic API". OpenAI's stays
 *  "OpenAI API key" — ChatGPT is their SUBSCRIPTION brand and they keep the
 *  two apart, which is why the subscription labels below don't match these
 *  one-for-one. That asymmetry is theirs, and inheriting it is the point. */
export function backendLabel(
  agent: string,
  kind: "api-key" | "subscription" | "local" | "gateway",
): string {
  // OpenCode Zen: the engine's built-in free gateway — no user
  // account behind it, so neither "API key" nor "subscription" is honest.
  if (kind === "gateway") return "OpenCode Zen (free models)";
  if (kind === "api-key") {
    if (agent === "codex") return "OpenAI API key";
    if (agent === "claude-code") return "Claude API key";
    if (agent === "gemini-cli") return "Gemini API key";
    // OpenCode's row backs onto whichever provider credential its own auth
    // store holds — no single vendor name exists until the session resolves
    // the pinned provider, so the row names the mechanism.
    if (agent === "opencode") return "API key (via opencode)";
    return "API key";
  }
  if (kind === "local") return "local endpoint";
  if (agent === "codex") return "ChatGPT subscription";
  if (agent === "claude-code") return "Claude subscription";
  if (agent === "gemini-cli") return "Gemini subscription";
  return "subscription";
}

/** A `local` row's label. Its `detail` is already a full, opaque label of its
 * own ("local endpoint", "custom endpoint", or a configured provider name),
 * so it REPLACES the generic name rather than being appended to it. */
export function localBackendLabel(agent: string, detail: string | undefined): string {
  return detail ?? backendLabel(agent, "local");
}

/** What a LIVE picker row runs on, as one line: the backing named first, the
 *  server's `detail` after it. A single usable backend starts on one click and
 *  never shows the second step — so without this the row would read "Gemini
 *  CLI · ready" and nothing else, and the user would never learn an API key
 *  was the thing being used. Same vocabulary as the second step, so both
 *  routes name the backing identically. */
export function backingLine(
  agent: string,
  kind: "api-key" | "subscription" | "local" | "gateway" | undefined,
  detail: string | undefined,
): string | undefined {
  if (!kind) return detail;
  if (kind === "local") return localBackendLabel(agent, detail);
  const label = backendLabel(agent, kind);
  return detail ? `${label} · ${detail}` : label;
}

/** The disclosed-uncertainty caveat riding the codex subscription OPTION
 *  (provider-policy.ts rule: state UNCERTAINTY, never permission — same bound as the
 *  CONNECT_HINT wording above). Other agents' subscriptions are blocked
 *  outright and carry BLOCKED_HINT instead. */
export function subscriptionCaveat(agent: string): string | undefined {
  return agent === "codex"
    ? "not clearly permitted by OpenAI's terms, tolerated in practice — your account, your call"
    : undefined;
}

/** Display-side mirror of the server's dialect map: which agents can run on
 *  a local model server at all (the hint below shows only for these). Gemini
 *  has no BYO-endpoint path. */
export function localCapable(agent: string): boolean {
  return agent === "claude-code" || agent === "codex";
}

/** The live local-model promise (kept literal: the picker re-probes
 *  while open), plus the hosted-open-model route — same BYO mechanism, but
 *  per-agent because the knob differs: Claude Code's endpoint is env-level
 *  (ANTHROPIC_BASE_URL), Codex's is a config.toml default provider — and BOTH
 *  appear in this menu as endpoint rows (the daemon reads config.toml;
 *  codex-config.ts), so both hints may promise it. Worded so an Ollama
 *  user — whose server idles perpetually as a background service — isn't
 *  told to do a step they don't have. */
export function localLiveHint(agent?: string): string {
  const base =
    "Running a local/open model? Anything your server (Ollama, LM Studio, vLLM) is " +
    "serving shows up here automatically — start it if it isn't running.";
  if (agent === "claude-code")
    return (
      base +
      " Bought API access to a hosted open model (DeepSeek, Kimi, …)? Point " +
      "ANTHROPIC_BASE_URL at its Anthropic-compatible API with that provider's " +
      "key, and it appears here as a custom endpoint."
    );
  if (agent === "codex")
    return (
      base +
      " Bought API access to a hosted open model (e.g. OpenRouter)? Add it as an " +
      "OpenAI-compatible provider in ~/.codex/config.toml — recipe in " +
      "docs/local-models.md — and it appears here as a custom endpoint."
    );
  // No agent picked yet (the step-one footer), or an agent this bundle doesn't
  // know: the promise stays generic — no agent-specific knobs.
  return (
    base +
    " Hosted open models you've bought API access to (DeepSeek, Kimi, …) work " +
    "the same way — point the agent at the provider's endpoint with your key."
  );
}
