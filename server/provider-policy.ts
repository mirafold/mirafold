import type { AgentName } from "./protocol";

// Per-provider credential policy — the ONE place the rule lives (R.4i, locked
// 2026-07-10 after a provider-terms review). Everything else consumes this;
// changing what a provider permits is a one-file edit here. NOT legal advice —
// this is our reading of published terms as of 2026-07-10, and all three moved
// in H1 2026, so treat the table as revisit-able.
//
// The matrix, by credential KIND and by layer (free LOCAL use vs the paid RELAY):
//
//   Anthropic (claude-code), closed:
//     - subscription (OAuth login): PROHIBITED everywhere. Anthropic's terms ban
//       using a Free/Pro/Max OAuth token in any third-party tool (Feb 2026,
//       enforced Apr 4 — the OpenClaw change); genui-shell IS another tool.
//     - API key: allowed locally; relay = API key only.
//   Google Gemini (gemini-cli), closed: same as Anthropic — the Gemini CLI ToS
//     third-party clause, and the individual tiers were cut off from the CLI on
//     2026-06-18. (Already API-key-only in our detection; no subscription path.)
//   OpenAI (codex), closed: the lone exception — OpenAI publicly permits ChatGPT
//     accounts in third-party harnesses, so subscription is fine for free LOCAL
//     use. The RELAY is still refused (charging for remote access to a
//     subscription-backed agent is the gray reselling area — refuse for now).
//   Open / local endpoint (BYO, e.g. Ollama via ANTHROPIC_BASE_URL): anything
//     goes, local and relay — the user's own compute, no first-party ToS.
//
// Why the relay is API-key-only for closed models even though the credential
// never transits it (R.3 makes frames E2E-opaque and the daemon calls the model
// LOCALLY): it's not the token that's the problem, it's that charging for remote
// access to a subscription-backed agent trips the providers' reselling clauses.
// API-key-only = the user pays the provider directly for metered use and we sell
// only transport — the defensible line.

export type CredentialKind = "api-key" | "subscription" | "local" | "none";

// Which providers permit a SUBSCRIPTION to drive a third-party app at all (for
// free LOCAL use). Anthropic + Google prohibit it; OpenAI permits it.
const SUBSCRIPTION_LOCAL_OK: Record<AgentName, boolean> = {
  "claude-code": false,
  "gemini-cli": false,
  codex: true,
};

/** May a session with this credential run for LOCAL (free) use? */
export function allowedLocally(agent: AgentName, kind: CredentialKind): boolean {
  switch (kind) {
    case "none":
      return false;
    case "api-key":
    case "local":
      return true;
    case "subscription":
      return SUBSCRIPTION_LOCAL_OK[agent];
  }
}

/**
 * May a session with this credential be driven over the paid RELAY? This is the
 * TERMS gate, and it ALLOW-LISTS the eligible kinds rather than deny-listing
 * `subscription` — so a credential kind added later defaults to REFUSED, not
 * allowed. This gate guards a legal/reselling line, so it must fail closed: a
 * future kind that nobody remembered to classify should be kept off the relay,
 * not waved through. Eligible: an API key (the user pays the provider directly),
 * a local/BYO endpoint (their own compute), and `none` (a credential-less demo —
 * no provider, no ToS concern). `subscription` is the one excluded kind today —
 * charging for remote access to a subscription-backed agent trips the providers'
 * reselling clauses, even OpenAI's (which is fine locally). Payment itself is a
 * SEPARATE gate (R.5 entitlement); this one only keeps subscription use off the
 * relay.
 */
export function allowedOverRelay(kind: CredentialKind): boolean {
  return kind === "api-key" || kind === "local" || kind === "none";
}
