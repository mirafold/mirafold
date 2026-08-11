// Phase R.1 — the relay envelope. The daemon serves remote viewports through
// ONE outbound connection to the relay; every remote viewport is multiplexed
// over it by viewport id. `WireMsg` and `ClientMsg` ride inside `p` as opaque
// strings (plain JSON today, ciphertext once R.3 lands) — the relay routes on
// `t`/`v` only and must never parse `p`, and the wire protocol itself is
// untouched by this layer.

import { randomBytes } from "node:crypto";

/** Relay → daemon, over the daemon's dial-out socket. */
export type RelayToDaemon =
  | { t: "open"; v: string } // a remote viewport connected
  | { t: "frame"; v: string; p: string } // one client frame from that viewport
  | { t: "close"; v: string } // that viewport is gone
  | { t: "ping" }; // relay-side liveness

/** Runtime boundary for the untrusted relay socket. JSON.parse only proves
 * syntax: scalars, null, arrays, and wrong-shaped objects are all valid JSON
 * but none may reach the multiplexer's property reads or session actions. */
export function isRelayToDaemon(value: unknown): value is RelayToDaemon {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const env = value as Record<string, unknown>;
  switch (env.t) {
    case "ping":
      return true;
    case "open":
    case "close":
      return typeof env.v === "string";
    case "frame":
      return typeof env.v === "string" && typeof env.p === "string";
    default:
      return false;
  }
}

/** Daemon → relay. */
export type DaemonToRelay =
  | { t: "frame"; v: string; p: string } // one WireMsg for that viewport
  | { t: "close"; v: string } // daemon dropped the viewport
  | { t: "pong" };

// URL contract with the relay (the in-repo stub now, the deployed R.2 service
// later). Viewports use the same /ws path a local browser uses against the
// daemon, so the web client connects to either end unchanged. R.3: both ends
// identify the pair by `?pair=<pairId>` — the SHA-256-derived id from
// relay-crypto.ts — and the pairing code itself never travels to the relay.
export const DAEMON_PATH = "/daemon";
export const VIEWPORT_PATH = "/ws";
export const PAIR_PARAM = "pair";

// Application close codes (4xxx range is ours to define).
export const CLOSE_CODE_TAKEN = 4002; // a daemon already holds that pair id
export const CLOSE_BAD_CODE = 4003; // no daemon paired under that id
// Dial-out REFUSAL codes the relay sends the daemon (mirrors the relay's
// contract). The daemon only INTERPRETS these — to tell the user WHY a dial-out
// was refused, not treat it as a routine drop. (CLOSE_FORBIDDEN_ORIGIN 4006 is
// viewport-only; a daemon carries no Origin and never receives it.)
export const CLOSE_OVERLOADED = 4004; // relay at a capacity cap
export const CLOSE_UNENTITLED = 4007; // dial-in without a valid entitlement token

// Request header the daemon presents its entitlement token on when dialing in
// (the paid-tier gate, R.5). Shared contract with the relay's contract.ts —
// the sibling itest's parity guard pins them equal.
export const ENTITLEMENT_HEADER = "mirafold-entitlement";

// A pair id shorter than this is refused outright — a guessable dev value
// must never silently work against a relay. (Real ids are 22 chars.)
export const MIN_PAIR_ID_LENGTH = 8;

// An announced viewport must complete the E2E handshake within this window
// or the daemon drops it — half-open channels don't accumulate.
export const HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * High-entropy pairing code (~128 bits, URL-safe). It is the root of trust
 * for the remote path: printed by the daemon, shown to the user (QR in R.4),
 * and the input to every key in relay-crypto.ts. It is NEVER sent to the
 * relay — only its derived pairId is.
 */
export const mintPairingCode = () => randomBytes(16).toString("base64url");

// A pinned code (MIRAFOLD_RELAY_CODE) below this length is refused: the code is
// the ONLY credential on the remote path — whoever knows it drives a shell on
// this machine — and a short one falls to an offline dictionary run against
// its pairId (which the relay logs by design), where relay-side rate limits
// can't help. Minted codes are 22 chars.
export const MIN_PAIRING_CODE_LENGTH = 16;

// The one alphabet every surface the code crosses agrees on: the QR/copy
// link interpolates it into a URL fragment raw, and the phone's fragment
// parser reads `code=([A-Za-z0-9_-]+)` — a space or `&` in a pinned code
// pairs the DAEMON fine but truncates on the phone, deriving a different
// pairId and yielding an eternal "Desktop not reachable" with no warning
// anywhere (2026-07-29 bughunt). Minted codes are base64url and always fit;
// a pin outside the alphabet is refused at the source — refusing beats
// honoring, as with the short-pin rule above.
export const PAIRING_CODE_RE = /^[A-Za-z0-9_-]+$/;

/** The launch's pairing code: the pin if it's strong enough, else minted.
 *  `weakPin` reports a pin that was refused so the caller can warn loudly;
 *  `pinProblem` says why (length vs. characters the pairing link can't carry). */
export function resolvePairingCode(pinned?: string): {
  code: string;
  weakPin: boolean;
  pinProblem?: "short" | "charset";
} {
  if (pinned) {
    if (pinned.length < MIN_PAIRING_CODE_LENGTH) {
      return { code: mintPairingCode(), weakPin: true, pinProblem: "short" };
    }
    if (!PAIRING_CODE_RE.test(pinned)) {
      return { code: mintPairingCode(), weakPin: true, pinProblem: "charset" };
    }
    return { code: pinned, weakPin: false };
  }
  return { code: mintPairingCode(), weakPin: false };
}
