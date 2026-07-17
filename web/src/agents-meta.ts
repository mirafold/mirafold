import type { AgentName } from "@protocol";

// Shared display metadata for the offerable agents. LABEL is the human
// name; CONNECT_HINT is the one concrete action that makes that agent live —
// shown on the onboarding picker's credential-less rows and in the in-session
// demo banner, so "no credentials" is never a dead end (R.4b).

export const LABEL: Record<AgentName, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

// R.4i/R.4k: the hint for a NO-credentials agent — the one action that makes it
// live, now naming WHERE to get the credential. Claude/Gemini never suggest a
// subscription login (prohibited in writing). Codex suggests `codex login`
// under the disclosed-uncertainty rule (provider-policy.ts, K.3 amendment
// 2026-07-15): the wording must state UNCERTAINTY, never permission — the
// earlier "OpenAI permits it today" overclaimed and must not return. Every
// closed agent also names the local/BYO route so "run your own model" reads
// as supported, not absent.
export const CONNECT_HINT: Record<AgentName, string> = {
  "claude-code":
    "set ANTHROPIC_API_KEY (get one at console.anthropic.com) — or point ANTHROPIC_BASE_URL at a local model (Ollama)",
  codex:
    "run `codex login` (ChatGPT subscription — not clearly permitted by OpenAI's terms, tolerated in practice; your account, your call) or set OPENAI_API_KEY (platform.openai.com/api-keys) — or point Codex at a local model (Ollama/LM Studio/vLLM)",
  "gemini-cli":
    "set GEMINI_API_KEY (free key at aistudio.google.com/apikey) — Gemini has no local path",
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
// heard of, and it must display as its raw name — not `undefined` (R.4h).

export function agentLabel(agent: string): string {
  return (LABEL as Record<string, string | undefined>)[agent] ?? agent;
}

export function connectHint(agent: string): string | undefined {
  return (CONNECT_HINT as Record<string, string | undefined>)[agent];
}

export function blockedHint(agent: string): string | undefined {
  return (BLOCKED_HINT as Record<string, string | undefined>)[agent];
}

// ── The second-step backend picker's copy (N.4) ──────────────────────────

/** Row label for a backend kind. Subscriptions carry the provider's own
 *  product name — "subscription" alone doesn't tell a two-credential user
 *  which login it means. */
export function backendLabel(agent: string, kind: "api-key" | "subscription" | "local"): string {
  if (kind === "api-key") return "API key";
  if (kind === "local") return "local endpoint";
  if (agent === "codex") return "ChatGPT subscription";
  if (agent === "claude-code") return "Claude subscription";
  if (agent === "gemini-cli") return "Gemini subscription";
  return "subscription";
}

/** The disclosed-uncertainty caveat riding the codex subscription OPTION
 *  (K.3 rule: state UNCERTAINTY, never permission — same bound as the
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

/** The live local-model promise (N.3 keeps it literal: the picker re-probes
 *  while open). Worded so an Ollama user — whose server idles perpetually as
 *  a background service — isn't told to do a step they don't have. */
export const LOCAL_LIVE_HINT =
  "Running a local/open model? Anything your server (Ollama, LM Studio, vLLM) is " +
  "serving shows up here automatically — start it if it isn't running.";
