// genui-relay capacity + policy limits — the DoS posture, mirroring the
// daemon's (bounded everything, refuse rather than degrade). Every value is
// env-overridable for tuning without a redeploy; startRelay() options win
// over env (the tests pass options directly).

export type Limits = {
  /** Hard ceiling on live sockets across all pairs. */
  maxConnections: number;
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
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const LIMITS: Limits = {
  maxConnections: num("RELAY_MAX_CONNECTIONS", 2_000),
  maxPairs: num("RELAY_MAX_PAIRS", 1_000),
  maxViewportsPerPair: num("RELAY_MAX_VIEWPORTS_PER_PAIR", 8),
  maxPayloadBytes: num("RELAY_MAX_PAYLOAD_BYTES", 8_000_000),
  rateMaxFrames: num("RELAY_RATE_MAX_FRAMES", 480),
  rateWindowMs: num("RELAY_RATE_WINDOW_MS", 1_000),
  heartbeatMs: num("RELAY_HEARTBEAT_MS", 30_000),
};
