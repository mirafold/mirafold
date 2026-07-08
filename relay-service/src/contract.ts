// The relay routing contract — VENDORED.
//
// This directory is the seed of the standalone, closed-source `genui-relay`
// repo (the open-core split, PLAN decision 2026-07-07). A separate repo can't
// import from genui-shell, so the tiny, stable routing contract is duplicated
// here. The daemon/browser copy is genui-shell's `server/relay-protocol.ts`;
// the shared constants below MUST stay byte-identical to it, and
// `server/relay-service.itest.ts` has a guard test that fails if they drift.
//
// The relay routes on `t`/`v`/`pair` ONLY. It never parses `p` — that is the
// end-to-end-encrypted WireMsg/ClientMsg payload, opaque ciphertext to us.

/** Relay → daemon, over the daemon's dial-out socket. */
export type RelayToDaemon =
  | { t: "open"; v: string } // a remote viewport connected
  | { t: "frame"; v: string; p: string } // one client frame from that viewport
  | { t: "close"; v: string } // that viewport is gone
  | { t: "ping" }; // relay-side liveness (app-level, distinct from ws ping)

/** Daemon → relay. */
export type DaemonToRelay =
  | { t: "frame"; v: string; p: string } // one WireMsg for that viewport
  | { t: "close"; v: string } // daemon dropped the viewport
  | { t: "pong" };

// URL contract — MUST match server/relay-protocol.ts.
export const DAEMON_PATH = "/daemon";
export const VIEWPORT_PATH = "/ws";
export const PAIR_PARAM = "pair";

// Application close codes (4xxx is ours). The first two MUST match
// server/relay-protocol.ts; the rest are relay-only capacity/policy signals
// (the client treats any close as "reconnect", so they're informational).
export const CLOSE_CODE_TAKEN = 4002; // a daemon already holds that pair id
export const CLOSE_BAD_CODE = 4003; // no daemon paired under that id
export const CLOSE_OVERLOADED = 4004; // relay at a capacity cap
export const CLOSE_RATE_LIMITED = 4008; // a connection exceeded its frame rate

// The shared subset the sync-guard test checks against server/relay-protocol.ts.
export const SHARED_CONTRACT = {
  DAEMON_PATH,
  VIEWPORT_PATH,
  PAIR_PARAM,
  CLOSE_CODE_TAKEN,
  CLOSE_BAD_CODE,
} as const;

// A pair id shorter than this is refused outright (guessable dev values must
// never work against the deployed relay). Real ids are 22 chars. MUST match
// MIN_PAIR_ID_LENGTH in server/relay-protocol.ts.
export const MIN_PAIR_ID_LENGTH = 8;
