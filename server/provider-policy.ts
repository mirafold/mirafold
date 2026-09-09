import type { AgentName } from "./protocol";

// Per-provider credential policy — the ONE place the rule lives (R.4i, locked
// 2026-07-10; OpenAI/Google re-checked 2026-09-09, Phase PSC, against current
// primary sources — cited per row below and in docs/provider-subscriptions.md).
// Everything else consumes this;
// changing what a provider permits is a one-file edit here. NOT legal advice —
// this is our reading of published terms as of the dates below, and all three
// providers moved within H1 2026: treat the table as revisit-able, and
// re-check the whole matrix in launch week (an explicit R.7 item).
//
// The matrix, by credential KIND and by layer (free LOCAL use vs the paid RELAY):
//
//   Anthropic (claude-code), closed:
//     - subscription (OAuth login): BLOCKED everywhere. The published sentence
//       (Claude Code docs "Legal and compliance", re-checked 2026-08-17, still
//       live): "Anthropic does not permit third-party developers to offer
//       Claude.ai login or to route requests through Free, Pro, or Max plan
//       credentials on behalf of their users." Read precisely, that names two
//       acts — offering Claude.ai login, and routing requests ON BEHALF OF
//       users — and Mirafold does neither: it spawns the official binary,
//       never touches the credential, and is never in the request path. It is
//       also the SOFTENED successor of a harder February 2026 sentence, since
//       deleted ("Using OAuth tokens obtained through Claude Free, Pro, or Max
//       accounts in any other product, tool, or service … is not permitted").
//       So the citation is narrower than a flat prohibition — and the row stays
//       blocked anyway, for the reason that actually carries it: volatility.
//       Three policy revisions in six months, server-side enforcement that
//       arrived before the docs (Jan 2026 token blocking, with collateral
//       account bans), and a downside that lands on the USER's account, not
//       ours. That fails the disclosed-uncertainty rule's "visibly permissive
//       posture" condition, so this row does not
//       become a gray area even though the terms are now similarly ambiguous.
//       Scope note: Free/Pro/Max fall under the Consumer Terms (§3(7) carries
//       the third-party-client clause); Team/Enterprise fall under the
//       Commercial Terms, which contain no such clause. Verified 2026-08-17.
//     - Timeline correction (2026-08-17; an earlier note here was backwards):
//       the April 2026 announcement extended the block to "all third-party
//       harnesses" (hit OpenClaw), and a June 15 change that would have given
//       paid plans a monthly Agent SDK credit pool spendable on third-party
//       agents was PAUSED that day and never took effect — Anthropic's help
//       center (support.claude.com/en/articles/15036540, June 16, 2026): "For
//       now, nothing has changed: Claude Agent SDK, `claude -p`, and
//       third-party app usage still draw from your subscription's usage
//       limits." There is no sanctioned credit pool to ride; nothing to fold
//       in as an opportunity. A written answer from Anthropic on whether a
//       local UI driving the official binary is covered is the only thing that
//       would move this row (inquiry drafted 2026-08-17, unsent).
//     - API key: allowed locally; relay = API key only.
//   Google Gemini (gemini-cli): API-key-only in Mirafold. Consumer access
//     (free / Google AI Pro / Ultra) ended 2026-06-18; the deprecation page
//     updated 2026-09-02 confirms it:
//     https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals
//     Standard/Enterprise Code Assist access survives, but our adapter has
//     no enterprise-login detection and explicitly selects API-key auth.
//     Do not equate driving the official CLI with extracting OAuth tokens:
//     Google documents ACP editor integrations, and its warning specifically
//     addresses direct backend access using third-party software:
//     https://geminicli.com/docs/ide-integration/
//     https://geminicli.com/docs/resources/tos-privacy/
//     These integrations do not restore retired consumer access. A future
//     enterprise or Antigravity adapter needs its own auth/terms review.
//   OpenAI (codex): ChatGPT login is supported for local use, without a
//     subscription warning (Kyle, 2026-09-09). The official app-server docs
//     explicitly describe embedding Codex in a product and its managed
//     ChatGPT authentication. Mirafold drives that exact app-server surface:
//     https://learn.chatgpt.com/docs/app-server
//     This replaces the July gray-area assessment. The existing paid-relay
//     restriction is a separate Mirafold policy and remains unchanged.
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
// Bounds: a written PROHIBITION is always honored within its actual scope,
// and the PAID relay always fails closed — charging is where our
// own exposure is real, so no gray-area credential ever crosses it.
//
// Why the relay is API-key-only for closed models even though the credential
// never transits it (R.3 makes frames E2E-opaque and the daemon calls the model
// LOCALLY): it's not the token that's the problem, it's that charging for remote
// access to a subscription-backed agent raises a separate reselling question.
// API-key-only = the user pays the provider directly for metered use and we sell
// only transport — the defensible line.

// "gateway" (added 2026-08-13, OC.4c/Zen): a vendor-hosted gateway the
// harness itself is credentialed for (OpenCode Zen's free models — no user
// account at all). Allowed locally as a disclosed gray area (Kyle's call,
// 2026-08-13 — see the Zen row below); NEVER relay-eligible: the allow-list
// in allowedOverRelay was designed so a new kind defaults to refused, and
// gateway deliberately stays off it.
export type CredentialKind = "api-key" | "subscription" | "local" | "gateway" | "none";

// Whether a SUBSCRIPTION may drive a third-party app for free LOCAL use.
// Anthropic stays blocked. Gemini has no supported subscription path here.
// OpenAI is supported without a caveat; see the dated provider notes above.
const SUBSCRIPTION_LOCAL_OK: Record<AgentName, boolean> = {
  "claude-code": false,
  "gemini-cli": false,
  codex: true,
  // OpenCode is a multi-provider harness: whether a subscription OAuth may
  // drive it locally is a fact about the UNDERLYING provider, not the agent
  // (anthropic/google → blocked; openai → supported; others → unreviewed).
  // The agent-level answer fails closed until the provider is classified.
  opencode: false,
};

// ---------------------------------------------------------------------------
// OpenCode: the provider-keyed half of the matrix (PLAN OC.3, 2026-08-13).
// OpenCode is a multi-provider harness, so the credential question is asked
// per UNDERLYING provider, answered from the RUNNING ENGINE's own catalog
// (`GET /config/providers`) — never by parsing the user's auth.json (their
// file; the server tells us what we need). Verified against opencode 1.18.18
// with stored-credential fixtures (opencode.spike.md, OC.3 probe):
//   - a stored API key surfaces as `source: "api"` (an env-var key as "env");
//   - a ChatGPT OAuth login surfaces as `source: "custom"` with the literal
//     marker `options.apiKey === "opencode-oauth-dummy-key"`;
//   - the built-in free "OpenCode Zen" gateway is `source: "custom"` with
//     `options.apiKey === "public"`;
//   - a user-config provider (Ollama, OpenRouter, …) is `source: "config"`;
//   - a stored ANTHROPIC oauth credential is IGNORED WHOLESALE — the
//     provider never enters the connected set, and /provider/auth offers no
//     Anthropic (or Google) OAuth flow at all. The blocked rows below are
//     belt-and-suspenders for other engine versions, not a live path.
// The oauth marker string is version-specific; classification fails closed
// on anything unrecognized, so engine drift degrades to "refused with a
// reason", never to "waved through" (same posture as allowedOverRelay).

/** One row of the engine's provider catalog, pre-stripped by the transport —
 *  the catalog exposes RAW STORED SECRETS (`key`), which must never travel
 *  past that seam, so this shape deliberately cannot carry them. */
export type OpenCodeProviderEntry = {
  id: string;
  source: "env" | "config" | "custom" | "api";
  /** The catalog's `options.apiKey` — a MARKER, not a secret ("public",
   *  "opencode-oauth-dummy-key"); real keys ride `key`, which is stripped. */
  apiKeyOption?: string;
};

const OPENCODE_OAUTH_MARKER = "opencode-oauth-dummy-key";
const OPENCODE_ZEN_MARKER = "public";

// Which providers' subscription OAuth may drive OpenCode locally. Only
// OpenAI remains allowed, with the ChatGPT warning removed across both
// adapters at Kyle's direction (2026-09-09). Codex's app-server documentation
// establishes that integration; it is not documentation of OpenCode's auth.
// Everything else — GitHub Copilot, GitLab Duo, Poe,
// DigitalOcean, Snowflake, xAI, and whatever a future version adds — stays
// false until its terms have actually been read and cited here.
const OPENCODE_SUBSCRIPTION_LOCAL_OK: Record<string, boolean | undefined> = {
  openai: true,
  anthropic: false, // written prohibition; also not even offered by 1.18.18
  google: false, // direct reuse of Gemini CLI OAuth is prohibited; same
};

/** May THIS provider's subscription OAuth drive OpenCode locally? The
 *  restore path needs the provider-keyed answer directly: a session whose
 *  classified kind was checkpointed as `subscription` must resolve live for
 *  openai and dead for everything else. */
export function opencodeSubscriptionAllowed(provider: string | undefined): boolean {
  return provider !== undefined && (OPENCODE_SUBSCRIPTION_LOCAL_OK[provider] ?? false);
}

export type OpenCodeProviderVerdict = {
  kind: CredentialKind;
  allowed: boolean;
  /** Human copy for a refusal — shown down the create-error path. */
  reason?: string;
  /** The disclosed-uncertainty rule's required disclosure for an ALLOWED
   *  gray-area provider — Mirafold-composed (no source badge), emitted once
   *  at session start. States uncertainty, never permission. */
  disclosure?: string;
};

/** Classify one connected OpenCode provider. Fail-closed: any shape this
 *  version of the matrix doesn't recognize is refused with its reason. */
export function classifyOpenCodeProvider(entry: OpenCodeProviderEntry): OpenCodeProviderVerdict {
  switch (entry.source) {
    case "api":
    case "env":
      // The user's own metered key (stored via `opencode auth login` or an
      // environment variable) — the fully supported path, relay-eligible.
      return { kind: "api-key", allowed: true };
    case "config":
      // A provider the user declared in their own opencode config (Ollama,
      // OpenRouter, …): they pointed the engine elsewhere — BYO, like a
      // codex config.toml provider.
      return { kind: "local", allowed: true };
    case "custom": {
      if (entry.apiKeyOption === OPENCODE_OAUTH_MARKER) {
        const ok = OPENCODE_SUBSCRIPTION_LOCAL_OK[entry.id] ?? false;
        return {
          kind: "subscription",
          allowed: ok,
          ...(!ok
            ? {
                reason:
                  `the "${entry.id}" login in opencode is a subscription OAuth, which ` +
                  `can't drive a third-party app${entry.id === "anthropic" || entry.id === "google" ? " (provider's written terms)" : " (terms unread — refused until they are)"} — ` +
                  `connect ${entry.id} with an API key in opencode instead`,
              }
            : {}),
        };
      }
      if (entry.id === "opencode" && entry.apiKeyOption === OPENCODE_ZEN_MARKER) {
        // The built-in free Zen gateway — TERMS READ 2026-08-13 (OC.4b,
        // opencode.ai/legal/terms-of-service + opencode.ai/docs/zen):
        // no prohibition on third-party harnesses (the server API we drive
        // is opencode's own documented programmatic surface); "only use the
        // Services for your own internal use, and not on behalf of or for
        // the benefit of any third party" (local personal use reads clean;
        // the paid relay would not); free models "during free periods" may
        // use collected data to improve the models (disclosed below).
        // OPENED by Kyle 2026-08-13 ("open Zen") under the
        // disclosed-uncertainty rule: local-only — kind "gateway" is not
        // relay-eligible (allowedOverRelay's allow-list) — with the
        // uncertainty AND the training-data caveat stated to the user.
        return {
          kind: "gateway",
          allowed: true,
          disclosure:
            "This session runs on OpenCode Zen's free models. opencode's terms don't " +
            "clearly address third-party apps like Mirafold (our reading: fine for your " +
            "own local use — your call), and free-period models may use prompts to " +
            "improve the model. Local only — it will never run over the relay.",
        };
      }
      return {
        kind: "none",
        allowed: false,
        reason: `provider "${entry.id}" has a credential shape Mirafold doesn't recognize — refused rather than guessed`,
      };
    }
  }
}

/** May a session with this credential run for LOCAL (free) use? */
export function allowedLocally(agent: AgentName, kind: CredentialKind): boolean {
  switch (kind) {
    case "none":
      return false;
    case "api-key":
    case "local":
      return true;
    case "gateway":
      // Only OpenCode has a gateway path (Zen, opened 2026-08-13 — the row
      // above carries the citation and disclosure).
      return agent === "opencode";
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
 * no provider, no ToS concern). Subscriptions and free gateways remain excluded
 * by Mirafold's paid-relay policy, independently of supported local use.
 * Payment itself is a
 * SEPARATE gate (R.5 entitlement); this one only keeps subscription use off the
 * relay.
 */
export function allowedOverRelay(kind: CredentialKind): boolean {
  return kind === "api-key" || kind === "local" || kind === "none";
}

/**
 * The relay gate's whole verdict for a session entry, pending-awareness
 * included (OC.4c). An OpenCode session's hello-time kind is OPTIMISTIC —
 * the truthful, provider-resolved kind only arrives once the engine starts
 * and the session publishes it (adapters/opencode/opencode.ts) — so until then a
 * remote viewport is refused outright: without this, a relay prompt racing
 * the first classification could drive a subscription/gateway session under
 * the optimistic "api-key". Returns the human refusal, or undefined when the
 * remote action may proceed.
 */
export function relayGateRefusal(entry: {
  kind: CredentialKind;
  kindPending?: boolean;
}): string | undefined {
  if (entry.kindPending)
    return (
      // Honest about WHEN it clears: verification runs with the session's
      // first local turn, so a remote viewport racing a fresh session would
      // wait forever on "a moment" (bughunt 2026-08-13). Reachable only by
      // ATTACH-to-existing since Phase RC: a remote CREATE classifies inline
      // (connection.ts attachOrReapClassified) and never surfaces this copy.
      "This session hasn't verified which credential backs it yet — run its " +
      "first turn from its own machine; remote viewports can attach after that."
    );
  if (!allowedOverRelay(entry.kind))
    return (
      "This session runs on a " +
      (entry.kind === "gateway" ? "free-gateway backing" : "subscription login") +
      ", which can't be used over the relay. Use an API key to drive an agent remotely."
    );
  return undefined;
}
