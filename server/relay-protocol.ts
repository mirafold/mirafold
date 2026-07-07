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

/** Daemon → relay. */
export type DaemonToRelay =
  | { t: "frame"; v: string; p: string } // one WireMsg for that viewport
  | { t: "close"; v: string } // daemon dropped the viewport
  | { t: "pong" };

// URL contract with the relay (the in-repo stub now, the deployed R.2 service
// later). Viewports use the same /ws path a local browser uses against the
// daemon, so the web client connects to either end unchanged.
export const DAEMON_PATH = "/daemon";
export const VIEWPORT_PATH = "/ws";

// Application close codes (4xxx range is ours to define).
export const CLOSE_CODE_TAKEN = 4002; // a daemon already holds that pairing code
export const CLOSE_BAD_CODE = 4003; // no daemon paired under that code

// A pairing code shorter than this is refused outright — a guessable dev
// code must never silently work against a relay.
export const MIN_CODE_LENGTH = 8;

/**
 * High-entropy pairing code (~128 bits, URL-safe). It is the root of trust
 * for the remote path: printed by the daemon, carried only inside the dial
 * URL, and (R.3) the input to the per-pair E2E key derivation.
 */
export const mintPairingCode = () => randomBytes(16).toString("base64url");
