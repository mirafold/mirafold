// Numeric env knobs, parsed strictly. A malformed value must NARROW the
// policy, never widen it (the same posture the Origin guard states): a typo'd
// MAX_WS_PAYLOAD="1MB" used to parse to NaN, which ws treats as UNLIMITED,
// and WS_HEARTBEAT_MS="30s" became a 1 ms setInterval that terminated every
// viewport before its pong could arrive (2026-07-29 bughunt). Garbage falls
// back to the default, loudly.

import { createLogger } from "./log";

/** A non-negative numeric env var, or `fallback` when unset/blank/garbage.
 *  (The logger is created at call time, not module time — log.ts imports
 *  envFlag from here, and a top-level createLogger would trip that cycle.) */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    createLogger("env").warn(
      `${name}="${raw}" is not a non-negative number — using the default (${fallback})`,
    );
    return fallback;
  }
  return n;
}

/** A boolean env flag: set and not "0"/"false" (any case) means ON — so
 *  MIRAFOLD_DEBUG=0 actually turns debug OFF (2026-07-29 bughunt). */
export function envFlag(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}
