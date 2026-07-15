import type { AgentName } from "./protocol";

// Per-provider credential policy — the ONE place the rule lives (R.4i, locked
// 2026-07-10; re-verified row by row 2026-07-15, Phase K.3, against current
// primary sources — cited per row below). Everything else consumes this;
// changing what a provider permits is a one-file edit here. NOT legal advice —
// this is our reading of published terms as of the dates below, and all three
// providers moved within H1 2026: treat the table as revisit-able, and
// re-check the whole matrix in launch week (an explicit R.7 item).
//
// The matrix, by credential KIND and by layer (free LOCAL use vs the paid RELAY):
//
//   Anthropic (claude-code), closed:
//     - subscription (OAuth login): PROHIBITED everywhere. Verbatim from the
//       Claude Code docs "Legal and compliance" page (checked 2026-07-15):
//       "Anthropic does not permit third-party developers to offer Claude.ai
//       login or to route requests through Free, Pro, or Max plan credentials
//       on behalf of their users." (Feb 2026 docs clarification; server-side
//       token blocking live since Jan 2026.)
//     - API key: allowed locally; relay = API key only.
//   Google Gemini (gemini-cli), closed: subscription/OAuth isn't even a path
//     anymore — Google stopped serving Gemini CLI requests for individual
//     accounts (free / AI Pro / AI Ultra) on 2026-06-18 (official
//     google-gemini/gemini-cli discussion #28017, posted by a maintainer;
//     Antigravity CLI announced as the successor — adapter impact tracked as
//     an R.6 check). API-key use continues under the Gemini API ToS. Already
//     API-key-only in our detection.
//   OpenAI (codex), closed: allowed for free LOCAL use **as a disclosed
//     gray area** (Kyle's call, 2026-07-15, amending the same-day fail-closed
//     flip — see the disclosed-uncertainty rule below). K.3's re-verification
//     found NO written general permission: the Codex auth docs are silent on
//     third-party harnesses, a Codex maintainer deferred to the general Terms
//     of Use when asked directly (openai/codex discussion #8338), and the
//     ChatGPT plan help pages say "Reselling access or using ChatGPT to power
//     third-party services is prohibited." But OpenAI's demonstrated posture
//     is actively permissive — Altman publicly invited ChatGPT-subscription
//     sign-in to OpenClaw (2026-05-02), and press reports no enforcement
//     against third-party routing. Uncertain terms + permissive posture +
//     minimal exposure (free, uncharged, the credential lives inside OpenAI's
//     own CLI which we merely drive) ⇒ allow locally WITH the uncertainty
//     stated to the user (agents-meta.ts codex CONNECT_HINT) and never
//     asserted as permission. The RELAY still refuses it — the reselling line
//     is bright and stays fail-closed. If OpenAI enforces (the Anthropic
//     pattern: server-side blocks first, docs later), the flip to blocked is
//     this one line — the `blocked` UI state and its copy sit ready.
//   Open / local endpoint (BYO, e.g. Ollama via ANTHROPIC_BASE_URL): anything
//     goes, local and relay — the user's own compute, no first-party ToS.
//
// THE DISCLOSED-UNCERTAINTY RULE (Kyle, 2026-07-15 — the standing principle
// for this whole class of question, here because this file is where the rule
// lives): when a provider's written terms are UNCERTAIN — neither clearly
// permitting nor clearly prohibiting our use — and our own exposure is
// minimal (free local use, nothing charged, the credential never touches our
// code, provider posture visibly permissive), we take the PERMISSIVE reading
// and put the uncertainty in front of the user: full disclosure, their
// account, their call. Two hard conditions make it clean:
//   (1) the disclosure states UNCERTAINTY, never permission — we never claim
//       a provider allows something we cannot cite;
//   (2) enforcement must degrade gracefully — the `blocked` state, its copy,
//       and the one-line flip stay ready at all times.
// Bounds: a written PROHIBITION (Anthropic, Google) is always honored
// outright, and the PAID relay always fails closed — charging is where our
// own exposure is real, so no gray-area credential ever crosses it.
//
// Why the relay is API-key-only for closed models even though the credential
// never transits it (R.3 makes frames E2E-opaque and the daemon calls the model
// LOCALLY): it's not the token that's the problem, it's that charging for remote
// access to a subscription-backed agent trips the providers' reselling clauses.
// API-key-only = the user pays the provider directly for metered use and we sell
// only transport — the defensible line.

export type CredentialKind = "api-key" | "subscription" | "local" | "none";

// Whether a SUBSCRIPTION may drive a third-party app for free LOCAL use.
// Anthropic + Google: NO, prohibited in writing. OpenAI: YES as a disclosed
// gray area — the disclosed-uncertainty rule above (uncertain terms,
// permissive posture, minimal exposure ⇒ allow with the caveat shown to the
// user). The codex CONNECT_HINT carries the required disclosure.
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
 * reselling clauses, even where local use is allowed as a disclosed gray area
 * (the disclosed-uncertainty rule's hard bound: the paid relay always fails
 * closed, no gray-area credential crosses it). Payment itself is a
 * SEPARATE gate (R.5 entitlement); this one only keeps subscription use off the
 * relay.
 */
export function allowedOverRelay(kind: CredentialKind): boolean {
  return kind === "api-key" || kind === "local" || kind === "none";
}
