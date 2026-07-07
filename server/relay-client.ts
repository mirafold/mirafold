import WebSocket from "ws";
import type { SessionRegistry } from "./registry";
import { openConnection, type Connection } from "./connection";
import { DAEMON_PATH, type DaemonToRelay, type RelayToDaemon } from "./relay-protocol";

// Dial-out backoff: a down relay is routine (offline laptop, relay deploy) —
// it must cost nothing but a quiet, widening retry.
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// Inbound envelope cap: one client frame (bounded by the same ceiling as the
// local socket) plus envelope overhead — same no-unbounded-allocation posture.
const MAX_ENVELOPE = Number(process.env.MAX_WS_PAYLOAD ?? 1_000_000) + 4_096;

export type RelayClient = { stop: () => void };

/**
 * Phase R.1: serve the registry THROUGH an outbound connection. The daemon
 * dials the relay — no listening port is ever opened for remote access — and
 * every remote viewport the relay announces becomes an ordinary Connection,
 * the same code path as a local WebSocket, so 4.2 fan-out, replay, and 4.4
 * resume work unchanged. Payloads are opaque strings to the relay; the
 * pairing code travels nowhere except inside this dial URL. Until R.3's
 * per-pair E2E encryption lands, frames cross the relay as plaintext — the
 * local stub is the only sanctioned relay for now.
 */
export function startRelayClient(opts: {
  url: string;
  code: string;
  registry: SessionRegistry;
}): RelayClient {
  let stopped = false;
  let backoff = RECONNECT_MIN_MS;
  let sock: WebSocket | null = null;
  const conns = new Map<string, Connection>();

  const dropAll = () => {
    for (const c of conns.values()) c.close();
    conns.clear();
  };

  const dial = () => {
    if (stopped) return;
    const ws = new WebSocket(
      `${opts.url}${DAEMON_PATH}?code=${encodeURIComponent(opts.code)}`,
      { maxPayload: MAX_ENVELOPE },
    );
    sock = ws;
    let wasOpen = false;
    const sendEnv = (env: DaemonToRelay) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(env));
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
          if (typeof env.v === "string" && !conns.has(env.v)) {
            const v = env.v;
            conns.set(
              v,
              openConnection(
                opts.registry,
                (msg) => sendEnv({ t: "frame", v, p: JSON.stringify(msg) }),
                "relay",
              ),
            );
          }
          break;
        case "frame":
          if (typeof env.p === "string") conns.get(env.v)?.handleMessage(env.p);
          break;
        case "close":
          conns.get(env.v)?.close();
          conns.delete(env.v);
          break;
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
      const t = setTimeout(dial, backoff);
      t.unref();
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    });
  };

  dial();
  return {
    stop: () => {
      stopped = true;
      dropAll();
      sock?.close();
    },
  };
}
