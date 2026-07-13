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
  /** Raw TCP sockets the HTTP server accepts at once — a floor for the
   * self-host path (Fly's edge already bounds concurrency). Every cap above is
   * checked AFTER the WebSocket handshake, so half-open / never-upgraded sockets
   * escape them; this bounds them. Keep ≥ maxConnections so it never bites
   * before the app cap does. 0 = Node's default (unbounded). */
  maxSockets: number;
  /** ms to receive the complete request headers; a slowloris dribbling headers
   * is cut here. Handshake-only — the timer clears on upgrade, so a live
   * WebSocket is never cut by it. 0 disables. */
  headersTimeoutMs: number;
  /** ms to receive the entire request; bounds a handshake that stalls after the
   * headers. Handshake-only, like headersTimeoutMs. 0 disables. */
  requestTimeoutMs: number;
  /** How often Node sweeps live connections to enforce the two handshake
   * timeouts above. It is a poll, not a precise deadline: a stalled handshake
   * lives up to headersTimeout/requestTimeout PLUS one of these intervals. We
   * default tighter than Node's 30s so "15s" means roughly that. 0 disables the
   * sweep entirely — which also disables both timeouts above. */
  connectionCheckMs: number;
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
  maxSockets: num("RELAY_MAX_SOCKETS", 2_400),
  headersTimeoutMs: num("RELAY_HEADERS_TIMEOUT_MS", 15_000),
  requestTimeoutMs: num("RELAY_REQUEST_TIMEOUT_MS", 20_000),
  connectionCheckMs: num("RELAY_CONNECTION_CHECK_MS", 5_000),
};
