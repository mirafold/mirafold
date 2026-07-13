// genui-relay capacity + policy limits — the DoS posture, mirroring the
// daemon's (bounded everything, refuse rather than degrade). Every value is
// env-overridable for tuning without a redeploy; startRelay() options win
// over env (the tests pass options directly).

export type Limits = {
  /** Hard ceiling on live sockets across all pairs. */
  maxConnections: number;
  /** Live sockets one source IP may hold — stops one host eating the global
   * budget or squatting every pair slot. 0 disables the per-IP gate. */
  maxConnectionsPerIp: number;
  /** Distinct daemons (pairs) at once. */
  maxPairs: number;
  /** Browser viewports per pair — independent of the daemon's own cap. */
  maxViewportsPerPair: number;
  /** Single-frame byte ceiling (daemon frames carry whole WireMsgs). */
  maxPayloadBytes: number;
  /** Frames one connection may send per window before it's dropped. */
  rateMaxFrames: number;
  rateWindowMs: number;
  /** ws-level ping interval; a socket that missed the last ping is reaped. 0 disables. */
  heartbeatMs: number;
};

const num = (name: string, fallback: number): number => {
  // Number("") === 0, so a set-but-empty var (an easy .env/CI accident) would
  // silently become 0 — refuse-everything or cap-disabled, depending on the
  // knob — instead of the default. Empty/whitespace means unset; "0" is honored.
  const v = process.env[name]?.trim();
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const LIMITS: Limits = {
  maxConnections: num("RELAY_MAX_CONNECTIONS", 2_000),
  maxConnectionsPerIp: num("RELAY_MAX_CONNECTIONS_PER_IP", 64),
  maxPairs: num("RELAY_MAX_PAIRS", 1_000),
  maxViewportsPerPair: num("RELAY_MAX_VIEWPORTS_PER_PAIR", 8),
  maxPayloadBytes: num("RELAY_MAX_PAYLOAD_BYTES", 8_000_000),
  rateMaxFrames: num("RELAY_RATE_MAX_FRAMES", 480),
  rateWindowMs: num("RELAY_RATE_WINDOW_MS", 1_000),
  heartbeatMs: num("RELAY_HEARTBEAT_MS", 30_000),
};
