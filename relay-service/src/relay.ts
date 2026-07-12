// genui-relay — the deployable dumb forwarder (PLAN Step R.2).
//
// The stub's shape (genui-shell server/relay-stub.ts) grown up for the world:
// same routing, hardened for a public port. It matches ONE daemon dial-in to
// any number of browser viewports by pair id and shuttles opaque payloads. It
// parses only the envelope's routing fields (`t`/`v`/`pair`), never `p` (the
// E2E ciphertext), logs no frame contents, and stores nothing.
//
// It is a PURE WebSocket forwarder — it serves no application bundle. See
// README.md for why (the trust decision): a relay that served the phone's JS
// could steal the pairing code from the URL fragment, so the phone loads the
// app from a separate static origin and the relay only ever sees ciphertext.
// The only HTTP it answers is GET /health (for the platform's health check).

import { createServer, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import {
  CLOSE_BAD_CODE,
  CLOSE_CODE_TAKEN,
  CLOSE_FORBIDDEN_ORIGIN,
  CLOSE_OVERLOADED,
  CLOSE_RATE_LIMITED,
  DAEMON_PATH,
  MIN_PAIR_ID_LENGTH,
  PAIR_PARAM,
  VIEWPORT_PATH,
  type DaemonToRelay,
  type RelayToDaemon,
} from "./contract.js";
import { LIMITS, type Limits } from "./limits.js";

export type RelayOptions = Partial<Limits> & {
  port?: number;
  host?: string;
  /** Structured, frame-content-free logging. Defaults to timestamped stdout. */
  log?: (line: string) => void;
  /** Request header carrying the true client IP, set by the trusted proxy in
   * front of us (e.g. "fly-client-ip"). The socket address is the proxy's, so
   * without this every connection shares one per-IP bucket. Empty = direct
   * connection, use the socket address. Never trust this header on a port an
   * untrusted client can reach directly — it is spoofable there. */
  clientIpHeader?: string;
  /** Web origins allowed to open a VIEWPORT socket, e.g.
   * ["https://app.mirafold.com"]. The browser same-origin rule does NOT cover
   * WebSockets, so a stray page on any origin can otherwise open one (harmless
   * without the pairing code, but it's DoS surface). Empty/unset = allow any
   * origin (dev, and before the static app origin exists). Daemon dial-ins are
   * never gated — they carry no Origin header. Exact scheme+host(+port) match. */
  allowedViewportOrigins?: string[];
};

export type Relay = {
  port: number;
  host: string;
  /** Live socket count — for the capacity test and future metrics. */
  connections: () => number;
  close: () => Promise<void>;
};

type Pair = { daemon: WebSocket; viewports: Map<string, WebSocket> };

// Per-socket bookkeeping the ws library doesn't give us: liveness for the
// heartbeat reaper, and a sliding frame counter for the rate limit.
type Meta = { alive: boolean; windowStart: number; frames: number };

export function startRelay(opts: RelayOptions = {}): Promise<Relay> {
  const cfg: Limits = { ...LIMITS, ...stripUndefined(opts) };
  const host = opts.host ?? "0.0.0.0";
  const log =
    opts.log ?? ((line: string) => console.log(`[${new Date().toISOString()}] ${line}`));

  const pairs = new Map<string, Pair>();
  const meta = new WeakMap<WebSocket, Meta>();
  const perIp = new Map<string, number>();
  let connections = 0;

  const ipHeader = opts.clientIpHeader?.toLowerCase() ?? "";
  const clientIp = (req: IncomingMessage): string => {
    if (ipHeader) {
      const h = req.headers[ipHeader];
      const first = (Array.isArray(h) ? h[0] : h)?.split(",")[0].trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  // Viewport Origin allowlist. Empty set = allow any (preserves the pre-gate
  // behavior and dev/no-static-origin-yet). When set, only these exact origins
  // may open a viewport socket; anything else (including a missing Origin) is
  // refused. Daemon dial-ins bypass this — they are not browsers.
  const allowedOrigins = new Set(
    (opts.allowedViewportOrigins ?? []).map((o) => o.trim()).filter(Boolean),
  );
  const originAllowed = (req: IncomingMessage): boolean => {
    if (allowedOrigins.size === 0) return true;
    const origin = req.headers.origin;
    return typeof origin === "string" && allowedOrigins.has(origin);
  };

  const server = createServer((req, res) => {
    // The ONLY HTTP surface: a health check. Everything else is 404 — the
    // relay serves no app bundle by design (README, the trust decision).
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("genui-relay: not found");
  });

  // Daemon envelopes carry whole WireMsgs (artifacts, capped tool output), so
  // the frame ceiling sits well above any single client frame.
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxPayloadBytes });

  // ws surfaces protocol violations (oversize frame, bad opcode) as 'error'
  // events; unhandled, one such frame would crash the whole process (an
  // uncaughtException in main.ts) and drop every live pairing. Swallow and
  // log — ws follows up with its own close (e.g. 1009) on that socket only.
  const guard = (ws: WebSocket) =>
    ws.on("error", (err: Error) => log(`socket error: ${err.message}`));

  const track = (ws: WebSocket, ip: string) => {
    connections++;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    meta.set(ws, { alive: true, windowStart: Date.now(), frames: 0 });
    ws.on("pong", () => {
      const m = meta.get(ws);
      if (m) m.alive = true;
    });
    ws.once("close", () => {
      connections--;
      const left = (perIp.get(ip) ?? 1) - 1;
      if (left <= 0) perIp.delete(ip);
      else perIp.set(ip, left);
    });
  };

  // Returns true if this frame is within the per-connection rate budget; on
  // exceed it closes the socket and returns false. A flood must cost the
  // flooder its connection, not the relay's CPU.
  const withinRate = (ws: WebSocket): boolean => {
    const m = meta.get(ws);
    if (!m) return false;
    const now = Date.now();
    if (now - m.windowStart >= cfg.rateWindowMs) {
      m.windowStart = now;
      m.frames = 0;
    }
    if (++m.frames > cfg.rateMaxFrames) {
      log(`rate limit exceeded (${m.frames} frames/${cfg.rateWindowMs}ms) — closing`);
      ws.close(CLOSE_RATE_LIMITED);
      return false;
    }
    return true;
  };

  const acceptDaemon = (ws: WebSocket, pairId: string, ip: string) => {
    // One daemon per pair id, ever; a short/guessable id or a second
    // dial-in is refused, never silently adopted. And no more distinct
    // pairs than the cap — a hostile flood of dial-ins can't exhaust us.
    if (pairId.length < MIN_PAIR_ID_LENGTH || pairs.has(pairId)) {
      ws.close(CLOSE_CODE_TAKEN);
      return;
    }
    if (pairs.size >= cfg.maxPairs) {
      log(`pair cap reached (${cfg.maxPairs}) — refusing daemon`);
      ws.close(CLOSE_OVERLOADED);
      return;
    }
    track(ws, ip);
    const pair: Pair = { daemon: ws, viewports: new Map() };
    pairs.set(pairId, pair);
    log(`daemon paired (${pairs.size} pair(s), ${connections} conn)`);
    ws.on("message", (data: RawData) => {
      if (!withinRate(ws)) return;
      let env: DaemonToRelay;
      try {
        env = JSON.parse(String(data)) as DaemonToRelay;
      } catch {
        return;
      }
      if (env.t === "pong") return;
      const viewport = pair.viewports.get(env.v);
      if (env.t === "frame" && viewport?.readyState === WebSocket.OPEN) {
        viewport.send(env.p); // opaque — routed, never parsed
      } else if (env.t === "close") {
        viewport?.close(CLOSE_BAD_CODE);
      }
    });
    ws.on("close", () => {
      pairs.delete(pairId);
      for (const viewport of pair.viewports.values()) viewport.close(CLOSE_BAD_CODE);
      log(`daemon unpaired (${pairs.size} pair(s) left)`);
    });
  };

  const acceptViewport = (ws: WebSocket, pairId: string, ip: string) => {
    const pair = pairs.get(pairId);
    if (!pair) {
      ws.close(CLOSE_BAD_CODE);
      return;
    }
    // Per-pair viewport cap: independent of the daemon's own remote-viewport
    // cap (defense in depth — a hostile relay-adjacent flood must not force
    // the daemon to fend off unbounded announcements).
    if (pair.viewports.size >= cfg.maxViewportsPerPair) {
      log(`viewport cap reached for a pair (${cfg.maxViewportsPerPair}) — refusing`);
      ws.close(CLOSE_OVERLOADED);
      return;
    }
    track(ws, ip);
    const v = randomUUID().slice(0, 8);
    pair.viewports.set(v, ws);
    pair.daemon.send(JSON.stringify({ t: "open", v } satisfies RelayToDaemon));
    ws.on("message", (data: RawData) => {
      if (!withinRate(ws)) return;
      if (pair.daemon.readyState === WebSocket.OPEN) {
        pair.daemon.send(JSON.stringify({ t: "frame", v, p: String(data) } satisfies RelayToDaemon));
      }
    });
    ws.on("close", () => {
      if (pair.viewports.delete(v) && pair.daemon.readyState === WebSocket.OPEN) {
        pair.daemon.send(JSON.stringify({ t: "close", v } satisfies RelayToDaemon));
      }
    });
  };

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "ws://relay");
    const pairId = url.searchParams.get(PAIR_PARAM) ?? "";
    const isDaemon = url.pathname === DAEMON_PATH;
    if (!isDaemon && url.pathname !== VIEWPORT_PATH) {
      socket.destroy();
      return;
    }
    const ip = clientIp(req);
    wss.handleUpgrade(req, socket, head, (ws) => {
      guard(ws);
      // Global capacity gate: the refused socket exists only long enough to
      // be told why (the client sees a clean CLOSE_OVERLOADED, not a hangup).
      if (connections >= cfg.maxConnections) {
        log(`connection cap reached (${cfg.maxConnections}) — refusing`);
        ws.close(CLOSE_OVERLOADED);
        return;
      }
      // Per-source gate: one host can't hold more than its share, so it can
      // neither exhaust the global budget nor squat every pair slot.
      if (cfg.maxConnectionsPerIp > 0 && (perIp.get(ip) ?? 0) >= cfg.maxConnectionsPerIp) {
        log(`per-IP cap reached (${cfg.maxConnectionsPerIp}) — refusing one source`);
        ws.close(CLOSE_OVERLOADED);
        return;
      }
      // Origin gate (viewports only): with an allowlist configured, a socket
      // from any other web origin is refused before it can pair. Daemons carry
      // no Origin and are never gated here.
      if (!isDaemon && !originAllowed(req)) {
        log(`viewport origin refused (${req.headers.origin ?? "none"})`);
        ws.close(CLOSE_FORBIDDEN_ORIGIN);
        return;
      }
      if (isDaemon) acceptDaemon(ws, pairId, ip);
      else acceptViewport(ws, pairId, ip);
    });
  });

  // Heartbeat reaper: ping every socket each interval; a socket that missed
  // the previous ping (dead TCP, sleeping phone with no FIN) is terminated so
  // it can't park a slot forever. Distinct from the daemon's app-level
  // zombie-viewport reaper — this one is about the transport being gone.
  const heartbeat =
    cfg.heartbeatMs > 0
      ? setInterval(() => {
          for (const pair of pairs.values()) {
            for (const ws of [pair.daemon, ...pair.viewports.values()]) {
              const m = meta.get(ws);
              if (!m) continue;
              if (!m.alive) {
                ws.terminate();
                continue;
              }
              m.alive = false;
              ws.ping();
            }
          }
        }, cfg.heartbeatMs)
      : null;
  if (heartbeat) heartbeat.unref?.();

  return new Promise((resolve) => {
    server.listen(opts.port ?? 0, host, () => {
      const port = (server.address() as { port: number }).port;
      log(`genui-relay listening on ${host}:${port}`);
      resolve({
        port,
        host,
        connections: () => connections,
        close: () =>
          new Promise((done) => {
            if (heartbeat) clearInterval(heartbeat);
            for (const pair of pairs.values()) {
              pair.daemon.terminate();
              for (const viewport of pair.viewports.values()) viewport.terminate();
            }
            server.close(() => done());
          }),
      });
    });
  });
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
