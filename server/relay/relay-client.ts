import WebSocket from "ws";
import type { SessionRegistry } from "../sessions/registry";
import { openConnection, type Connection } from "../sessions/connection";
import { createLogger } from "../log";
import {
  CLOSE_CODE_TAKEN,
  CLOSE_OVERLOADED,
  CLOSE_UNENTITLED,
  DAEMON_PATH,
  ENTITLEMENT_HEADER,
  HANDSHAKE_TIMEOUT_MS,
  isRelayToDaemon,
  PAIR_PARAM,
  type DaemonToRelay,
} from "./relay-protocol";
import {
  derivePair,
  frameCiphers,
  openHandshake,
  randomBytes,
  sealHandshake,
  type FrameCipher,
  type PairSecret,
} from "./relay-crypto";
import { envInt } from "../env";

const log = createLogger("relay");

/** A relay dial-out close code that means the connection was REFUSED (not a
 *  routine drop), mapped to an actionable line for the user's terminal. null =
 *  not a known refusal → treat as an ordinary connection loss. Exported for the
 *  unit test; the daemon never SENDS these, only interprets them. */
export function relayRefusalReason(code: number): string | null {
  switch (code) {
    case CLOSE_UNENTITLED:
      return "remote access needs a valid subscription (entitlement missing or expired)";
    case CLOSE_OVERLOADED:
      return "the relay is at capacity";
    case CLOSE_CODE_TAKEN:
      return "this pairing is already held by another daemon";
    default:
      return null;
  }
}

// Dial-out backoff: a down relay is routine (offline laptop, relay deploy) —
// it must cost nothing but a quiet, widening retry. Env-tunable for the unit
// test only; the defaults are the product values.
const RECONNECT_MIN_MS = envInt("RELAY_RECONNECT_MIN_MS", 1_000);
const RECONNECT_MAX_MS = envInt("RELAY_RECONNECT_MAX_MS", 30_000);
// The relay refuses AFTER accepting the WS upgrade, so a healthy pairing is
// "opened and NOT immediately closed". Staying open this long earns the
// "paired" log — but NOT the backoff reset. That decision waits for the close,
// where the close code is known: in production a proxy (Fly's) can deliver a
// refusal close ~5 s after open (locally it's ms), long past any sane confirm
// window, and a timer-based reset there meant an invalid/lapsed license
// churn-dialed at ~6 s forever — false "paired", reset, refused, repeat
// (found 2026-07-30, live against production). A refusal close never resets
// backoff; a confirmed connection's ordinary drop still reconnects fast.
const PAIR_CONFIRM_MS = envInt("RELAY_PAIR_CONFIRM_MS", 400);
// Inbound envelope cap. Must cover the relay's own per-frame cap
// (RELAY_MAX_PAYLOAD_BYTES — 8 MB default in the service and the stub alike),
// NOT the local socket's: a frame the relay forwards but this socket refuses
// is a ws protocol violation, and ws closes the WHOLE dial-out connection —
// dropping every remote viewport, not the one that misbehaved (2026-07-29
// bughunt: a >1.13 MB phone paste killed the entire pairing). Envelope
// wrapping overhead rides on top; the bound stays finite, which is all the
// no-unbounded-allocation posture needs. Exported for the alignment pin in
// relay.itest.ts.
export const MAX_ENVELOPE = envInt("RELAY_MAX_PAYLOAD_BYTES", 8_000_000) + 16_384;
// Ceilings on what the relay can make the daemon hold. The relay is untrusted
// for resource pressure too (R.2 adds relay-side caps, but the daemon must
// survive a hostile one): viewport announcements past the cap are refused
// outright, and a handshaken viewport that goes silent past the idle window
// is dropped. The web client heartbeats every 25s, so only a dead peer — or a
// replayed handshake hello, which can never send an authentic frame — stays
// quiet that long.
const MAX_REMOTE_VIEWPORTS = envInt("MAX_REMOTE_VIEWPORTS", 16);
const VIEWPORT_IDLE_MS = envInt("RELAY_VIEWPORT_IDLE_MS", 90_000);

export type RelayClient = { stop: () => void };

/** One remote viewport's channel state behind the dial-out socket. */
type Remote = {
  conn?: Connection;
  cipher?: FrameCipher;
  // Per-direction promise chains: seal/open are async, and frame order is
  // part of the security contract (strict +1 counters) — a reordered await
  // would kill the channel.
  sendChain: Promise<void>;
  recvChain: Promise<void>;
  // Handshake deadline first, then rearmed as the idle reaper on every
  // authenticated inbound frame.
  timer: NodeJS.Timeout;
};

/**
 * Phase R.1/R.3: serve the registry THROUGH an outbound connection. The
 * daemon dials the relay — no listening port is ever opened for remote
 * access — and every remote viewport the relay announces becomes an ordinary
 * Connection, the same code path as a local WebSocket, so 4.2 fan-out,
 * replay, and 4.4 resume work unchanged.
 *
 * The relay never sees the pairing code (only its derived pairId rides
 * the dial URL) and never sees a plaintext frame. Each viewport must open
 * with a valid E2E handshake under the code-derived key; every later frame
 * is AES-GCM under that channel's fresh directional keys. Anything that
 * fails to authenticate — wrong code, tampered, replayed — drops the
 * viewport: fail closed, never fail open (R.3).
 */
export function startRelayClient(opts: {
  url: string;
  code: string;
  registry: SessionRegistry;
  /** R.5 entitlement token source (see entitlement.ts). Resolved fresh per
   *  dial; `refresh: true` after an unentitled refusal so an expired token is
   *  re-exchanged before the retry. undefined token = dial with no header (a
   *  gated relay refuses; an ungated one doesn't care). */
  token?: (opts: { refresh: boolean }) => Promise<string | undefined>;
}): RelayClient {
  let stopped = false;
  let backoff = RECONNECT_MIN_MS;
  let sock: WebSocket | null = null;
  // Set by a CLOSE_UNENTITLED refusal: the next dial force-refreshes its token
  // first (the cached one just proved stale/refused).
  let refreshTokenNext = false;
  const remotes = new Map<string, Remote>();

  const dropAll = () => {
    for (const r of remotes.values()) {
      clearTimeout(r.timer);
      r.conn?.close();
    }
    remotes.clear();
  };

  const dial = async (pair: PairSecret) => {
    if (stopped) return;
    // Token first (may hit the billing endpoint), socket second — and re-check
    // stopped across the await so stop() during the fetch never leaks a socket.
    const token = opts.token ? await opts.token({ refresh: refreshTokenNext }) : undefined;
    refreshTokenNext = false;
    if (stopped) return;
    const ws = new WebSocket(`${opts.url}${DAEMON_PATH}?${PAIR_PARAM}=${pair.id}`, {
      maxPayload: MAX_ENVELOPE,
      ...(token ? { headers: { [ENTITLEMENT_HEADER]: token } } : {}),
    });
    sock = ws;
    let wasOpen = false;
    let confirmed = false;
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    const sendEnv = (env: DaemonToRelay) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(env));
    };
    // Fail closed: tell the relay the viewport is gone and forget it.
    const drop = (v: string) => {
      const r = remotes.get(v);
      if (!r) return;
      clearTimeout(r.timer);
      r.conn?.close();
      remotes.delete(v);
      sendEnv({ t: "close", v });
    };
    const rearm = (r: Remote, v: string, ms: number) => {
      clearTimeout(r.timer);
      r.timer = setTimeout(() => drop(v), ms);
    };
    ws.on("open", () => {
      wasOpen = true;
      // Staying open earns the "paired" log only (see PAIR_CONFIRM_MS): the
      // backoff reset is decided at close, where the close code says whether
      // this was ever a healthy pairing — a slow-arriving refusal (Fly's
      // proxy: ~5 s) must not have already reset it.
      confirmTimer = setTimeout(() => {
        confirmed = true;
        log.info(`paired with ${opts.url}`);
      }, PAIR_CONFIRM_MS);
    });
    ws.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!isRelayToDaemon(parsed)) return;
      const env = parsed;
      switch (env.t) {
        case "open":
          if (typeof env.v === "string" && !remotes.has(env.v)) {
            const v = env.v;
            if (remotes.size >= MAX_REMOTE_VIEWPORTS) {
              sendEnv({ t: "close", v });
              break;
            }
            remotes.set(v, {
              sendChain: Promise.resolve(),
              recvChain: Promise.resolve(),
              timer: setTimeout(() => drop(v), HANDSHAKE_TIMEOUT_MS),
            });
          }
          break;
        case "frame": {
          const r = remotes.get(env.v);
          if (!r || typeof env.p !== "string") break;
          const { v, p } = env;
          r.recvChain = r.recvChain.then(async () => {
            if (!remotes.has(v) || sock !== ws) return;
            try {
              if (!r.cipher) {
                // First frame must be the client's handshake hello; a wrong
                // pairing code dies here, before any session state exists.
                const nonceC = await openHandshake(pair, "c", p);
                const nonceD = randomBytes(32);
                sendEnv({ t: "frame", v, p: await sealHandshake(pair, "d", nonceD) });
                r.cipher = await frameCiphers(pair, nonceC, nonceD, "d");
                rearm(r, v, VIEWPORT_IDLE_MS);
                r.conn = openConnection(
                  opts.registry,
                  (msg) => {
                    r.sendChain = r.sendChain.then(async () => {
                      if (remotes.has(v) && r.cipher && ws.readyState === WebSocket.OPEN) {
                        sendEnv({ t: "frame", v, p: await r.cipher.seal(JSON.stringify(msg)) });
                      }
                    });
                  },
                  // No pairing info crosses the relay path; a remote viewport
                  // is subject to the relay gate.
                  { label: "relay", remote: true },
                );
              } else {
                const text = await r.cipher.open(p); // throws → drop below
                rearm(r, v, VIEWPORT_IDLE_MS);
                r.conn!.handleMessage(text);
              }
            } catch {
              drop(v); // tampered/replayed/wrong-key — never processed
            }
          });
          break;
        }
        case "close": {
          const r = remotes.get(env.v);
          if (r) {
            clearTimeout(r.timer);
            r.conn?.close();
            remotes.delete(env.v);
          }
          break;
        }
        case "ping":
          sendEnv({ t: "pong" });
          break;
      }
    });
    // Frame contents are never logged on this path — only connection state.
    ws.on("error", () => {});
    ws.on("close", (code: number) => {
      if (sock !== ws) return;
      sock = null;
      clearTimeout(confirmTimer); // a close before confirm ⇒ this was never a healthy pairing
      dropAll();
      if (stopped) return;
      const refusal = relayRefusalReason(code);
      if (refusal) log.info(`refused: ${refusal} — retrying`);
      else if (wasOpen) log.info(`connection lost — retrying`);
      if (code === CLOSE_UNENTITLED) refreshTokenNext = true;
      // A confirmed connection that ended in an ordinary drop was healthy —
      // the next dial starts from the floor. A REFUSAL never resets, however
      // long the close took to arrive (a wall it can't beat, e.g. a lapsed
      // license, keeps widening toward RECONNECT_MAX_MS instead of churning).
      if (confirmed && !refusal) backoff = RECONNECT_MIN_MS;
      const t = setTimeout(() => void dial(pair), backoff);
      t.unref();
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    });
  };

  void derivePair(opts.code).then((pair) => void dial(pair));
  return {
    stop: () => {
      stopped = true;
      dropAll();
      sock?.close();
    },
  };
}
