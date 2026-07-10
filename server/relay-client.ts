import WebSocket from "ws";
import type { SessionRegistry } from "./registry";
import { openConnection, type Connection } from "./connection";
import {
  DAEMON_PATH,
  HANDSHAKE_TIMEOUT_MS,
  PAIR_PARAM,
  type DaemonToRelay,
  type RelayToDaemon,
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

// Dial-out backoff: a down relay is routine (offline laptop, relay deploy) —
// it must cost nothing but a quiet, widening retry.
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// Inbound envelope cap: one client frame (bounded by the same ceiling as the
// local socket), sealed (~4/3 base64) plus envelope overhead — same
// no-unbounded-allocation posture.
const MAX_ENVELOPE = Math.ceil(Number(process.env.MAX_WS_PAYLOAD ?? 1_000_000) * 1.5) + 8_192;
// Ceilings on what the relay can make the daemon hold. The relay is untrusted
// for resource pressure too (R.2 adds relay-side caps, but the daemon must
// survive a hostile one): viewport announcements past the cap are refused
// outright, and a handshaken viewport that goes silent past the idle window
// is dropped. The web client heartbeats every 25s, so only a dead peer — or a
// replayed handshake hello, which can never send an authentic frame — stays
// quiet that long.
const MAX_REMOTE_VIEWPORTS = Number(process.env.MAX_REMOTE_VIEWPORTS ?? 16);
const VIEWPORT_IDLE_MS = Number(process.env.RELAY_VIEWPORT_IDLE_MS ?? 90_000);

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
 * R.3: the relay never sees the pairing code (only its derived pairId rides
 * the dial URL) and never sees a plaintext frame. Each viewport must open
 * with a valid E2E handshake under the code-derived key; every later frame
 * is AES-GCM under that channel's fresh directional keys. Anything that
 * fails to authenticate — wrong code, tampered, replayed — drops the
 * viewport: fail closed, never fail open.
 */
export function startRelayClient(opts: {
  url: string;
  code: string;
  registry: SessionRegistry;
}): RelayClient {
  let stopped = false;
  let backoff = RECONNECT_MIN_MS;
  let sock: WebSocket | null = null;
  const remotes = new Map<string, Remote>();

  const dropAll = () => {
    for (const r of remotes.values()) {
      clearTimeout(r.timer);
      r.conn?.close();
    }
    remotes.clear();
  };

  const dial = (pair: PairSecret) => {
    if (stopped) return;
    const ws = new WebSocket(`${opts.url}${DAEMON_PATH}?${PAIR_PARAM}=${pair.id}`, {
      maxPayload: MAX_ENVELOPE,
    });
    sock = ws;
    let wasOpen = false;
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
      backoff = RECONNECT_MIN_MS;
      console.log(`[relay] paired with ${opts.url}`);
    });
    ws.on("message", (data) => {
      let env: RelayToDaemon;
      try {
        env = JSON.parse(String(data)) as RelayToDaemon;
      } catch {
        return;
      }
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
                  "relay",
                  undefined, // no pairing info crosses the relay path
                  true, // R.4i: remote viewport — subject to the relay gate
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
    ws.on("close", () => {
      if (sock !== ws) return;
      sock = null;
      dropAll();
      if (stopped) return;
      if (wasOpen) console.log(`[relay] connection lost — retrying`);
      const t = setTimeout(() => dial(pair), backoff);
      t.unref();
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    });
  };

  void derivePair(opts.code).then((pair) => dial(pair));
  return {
    stop: () => {
      stopped = true;
      dropAll();
      sock?.close();
    },
  };
}
