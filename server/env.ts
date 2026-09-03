// Numeric env knobs, parsed strictly. A malformed value must NARROW the
// policy, never widen it (the same posture the Origin guard states): a typo'd
// MAX_WS_PAYLOAD="1MB" would parse to NaN, which ws treats as UNLIMITED,
// and WS_HEARTBEAT_MS="30s" would become a 1 ms setInterval that terminates
// every viewport before its pong can arrive. Garbage falls back to the
// default, loudly.

import { createLogger } from "./log";

// scripts/watch-server.ts owns the other end of this private process contract.
// 75 is EX_TEMPFAIL: the daemon itself is sound, but the requested development
// port is temporarily unavailable. Keeping this distinct from ordinary code
// failures lets the watcher retain edit-and-retry behavior for those failures
// while still stopping Vite for the one failure that makes its proxy invalid.
export const DEV_PORT_CONFLICT_EXIT_CODE = 75;

/** A non-negative INTEGER env var, or `fallback` when unset/blank/garbage.
 *  Every consumer is a count, a byte size, a port, or a millisecond delay,
 *  none of which mean anything fractional (PORT=3000.5 reached listen()).
 *  (The logger is created at call time, not module time — log.ts imports
 *  envFlag from here, and a top-level createLogger would trip that cycle.) */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    createLogger("env").warn(
      `${name}="${raw}" is not a non-negative integer — using the default (${fallback})`,
    );
    return fallback;
  }
  return n;
}

/** The documented opt-out spellings for a feature knob: off / none /
 *  disabled / false / 0 (any case). One grammar for every "turn this off"
 *  setting, so `=false` never silently does nothing where `=off` works. */
export function envOff(raw: string | undefined): boolean {
  return /^(off|none|disabled|false|0)$/i.test((raw ?? "").trim());
}

/** A boolean env flag: set and not "0"/"false" (any case) means ON — so
 *  MIRAFOLD_DEBUG=0 actually turns debug OFF. */
export function envFlag(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}
