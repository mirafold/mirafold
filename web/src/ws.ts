import type { ClientMsg, WireMsg } from "@protocol";
import { CLIENT_VERSION } from "./version";
import {
  derivePair,
  frameCiphers,
  openHandshake,
  randomBytes,
  sealHandshake,
  type FrameCipher,
  type PairSecret,
} from "@relay-crypto";

type Listener = (msg: WireMsg) => void;

// Heartbeat (4.4): a wifi blip with no FIN leaves the socket half-open and
// silently dead — the browser would wait forever. Ping on an interval and
// treat any inbound traffic as life; a ping that goes unanswered past the
// deadline closes the socket, which routes into the normal reconnect path.
export const PING_INTERVAL_MS = 25_000;
export const PONG_DEADLINE_MS = 8_000;
// Reconnect backoff: fast first retry (the daemon is local), capped so a
// long outage doesn't hammer; `online`/tab-visible events short-circuit it.
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 5_000;

/**
 * Phase R.3 — the remote (relay) path. A remote page is opened as
 * /#code=<pairing code>: the code rides the URL FRAGMENT, which never leaves
 * the browser, so the relay's HTTP logs can't see it. It's stashed per-tab in
 * sessionStorage (in-app navigation — fleet row links, history.replaceState —
 * drops the fragment) and scrubbed from the address bar. Shell-owned state:
 * agent output can never read or set it.
 */
function relayCodeFromPage(): string | null {
  const m = location.hash.match(/(?:^#|&)code=([A-Za-z0-9_-]+)/);
  if (m) {
    sessionStorage.setItem("genui-relay-code", m[1]);
    history.replaceState(null, "", location.pathname + location.search);
  }
  return m?.[1] ?? sessionStorage.getItem("genui-relay-code");
}

/**
 * The shell's WebSocket client. Lives in the trusted shell — agent output
 * never touches it. Reconnects automatically on drop; every (re)open first
 * sends the hello (attach/create, Step 4.2) so the connection is a viewport
 * on the right session before anything else flows.
 *
 * Step 4.4: tracks the last broadcast `seq` seen so the hello can ask for a
 * tail-only resume, heartbeats to catch half-open sockets, and backs off
 * between attempts (with instant retry when the network returns).
 *
 * Phase R.3: with a pairing code present, the connection is end-to-end
 * encrypted — the relay sees only the code's derived pairId in the URL and
 * ciphertext frames. Each (re)connect performs the handshake before the
 * hello, and any frame that fails to authenticate closes the socket (fail
 * closed → normal reconnect → fresh handshake). A local page has no code and
 * none of this engages.
 */
export class SocketClient {
  private ws?: WebSocket;
  private listeners = new Set<Listener>();
  private openListeners = new Set<() => void>();
  private closeListeners = new Set<() => void>();
  private pending: ClientMsg[] = [];
  private closedByUs = false;
  private backoff = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  // Returns the join message (attach/create) for this open, or null to send
  // nothing yet — P.4 waits at onboarding until the user picks an agent.
  private hello: (() => ClientMsg | null) | null = null;
  /** Last broadcast seq seen — the resume cursor sent as attach.afterSeq. */
  lastSeq: number | null = null;

  private url!: string;
  private pair: PairSecret | null = null;
  /** Open AND (on the relay path) handshaken — the app may talk. */
  private ready = false;
  /** Per-socket sender, swapped in connect(); queues until a socket exists. */
  private transmit: (msg: ClientMsg) => void = (m) => this.pending.push(m);

  constructor(url?: string) {
    // A returning network or a re-focused tab shouldn't wait out the backoff.
    window.addEventListener("online", this.reconnectNow);
    document.addEventListener("visibilitychange", this.onVisible);
    if (url) {
      this.url = url;
      this.connect();
      return;
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const code = relayCodeFromPage();
    if (!code) {
      this.url = `${proto}://${location.host}/ws`;
      this.connect();
      return;
    }
    // Remote mode: key derivation is async; sends queue in `pending` until
    // the first connect. Only the derived id ever reaches a URL.
    void derivePair(code).then((pair) => {
      if (this.closedByUs) return;
      this.pair = pair;
      this.url = `${proto}://${location.host}/ws?pair=${pair.id}`;
      this.connect();
    });
  }

  private onVisible = () => {
    if (document.visibilityState === "visible") this.reconnectNow();
  };

  private reconnectNow = () => {
    if (this.closedByUs || !this.ws || this.ws.readyState === WebSocket.OPEN) return;
    if (this.ws.readyState === WebSocket.CONNECTING) return;
    // CLOSING falls through on purpose: the heartbeat's close() of a dead pipe
    // can take seconds to complete, and a returning network shouldn't wait for
    // it — connect() supersedes, and the old socket's handlers go inert.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.backoff = BACKOFF_MIN_MS;
    this.connect();
  };

  private connect() {
    if (this.closedByUs) return; // a queued reconnect must not outlive close()
    // Each handler checks it still belongs to the current socket: a superseded
    // socket's late onclose must not kill the new heartbeat, fire close
    // listeners, or schedule an extra connect (the duplicate-viewport race).
    const sock = new WebSocket(this.url);
    this.ws = sock;
    this.ready = false;

    // R.3 per-connection channel state. Send/receive each chain their async
    // seal/open so frame ORDER is preserved — the strict +1 counters make
    // order part of the security contract, not just a nicety.
    const pair = this.pair;
    let cipher: FrameCipher | null = null;
    let clientNonce: Uint8Array<ArrayBuffer> | null = null;
    let sendChain: Promise<void> = Promise.resolve();
    let recvChain: Promise<void> = Promise.resolve();

    this.transmit = (msg: ClientMsg) => {
      const text = JSON.stringify(msg);
      if (!pair) {
        if (sock.readyState === WebSocket.OPEN) sock.send(text);
        return;
      }
      sendChain = sendChain.then(async () => {
        if (this.ws === sock && cipher && sock.readyState === WebSocket.OPEN) {
          sock.send(await cipher.seal(text));
        }
      });
    };

    sock.onopen = () => {
      if (this.ws !== sock) return;
      this.backoff = BACKOFF_MIN_MS;
      if (!pair) {
        this.finishOpen();
        return;
      }
      // Handshake first; the hello and everything else wait for the reply.
      clientNonce = randomBytes(32);
      void sealHandshake(pair, "c", clientNonce).then((frame) => {
        if (this.ws === sock && sock.readyState === WebSocket.OPEN) sock.send(frame);
      });
    };
    sock.onmessage = (e) => {
      if (this.ws !== sock) return;
      this.alive(); // any traffic proves the pipe
      if (!pair) {
        this.dispatch(e.data as string);
        return;
      }
      recvChain = recvChain.then(async () => {
        if (this.ws !== sock) return;
        try {
          if (!cipher) {
            const daemonNonce = await openHandshake(pair, "d", e.data as string);
            cipher = await frameCiphers(pair, clientNonce!, daemonNonce, "c");
            this.finishOpen();
          } else {
            this.dispatch(await cipher.open(e.data as string));
          }
        } catch {
          // Fail closed: an unauthentic frame kills the channel; the normal
          // reconnect path starts over with a fresh handshake.
          sock.close();
        }
      });
    };
    sock.onclose = () => {
      if (this.ws !== sock) return;
      this.ready = false;
      this.stopHeartbeat();
      for (const cb of this.closeListeners) cb();
      if (!this.closedByUs) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
      }
    };
  }

  /** The channel is usable (handshaken, on the relay path) — start the app flow. */
  private finishOpen() {
    this.ready = true;
    for (const cb of this.openListeners) cb();
    const hello = this.hello?.();
    if (hello) this.transmit(this.stamp(hello));
    for (const msg of this.pending.splice(0)) this.transmit(msg);
    this.startHeartbeat();
  }

  /** One decrypted/plain wire frame → the app. */
  private dispatch(text: string) {
    let msg: WireMsg;
    try {
      msg = JSON.parse(text) as WireMsg;
    } catch {
      return;
    }
    if (typeof msg.seq === "number") this.lastSeq = msg.seq;
    if (msg.type === "pong") return; // liveness only, not for the app
    for (const l of this.listeners) l(msg);
  }

  private startHeartbeat() {
    // A superseded socket skips stopHeartbeat (its onclose is inert), so a
    // fresh open must clear whatever timers the previous socket left running.
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
      this.transmit({ type: "ping" } satisfies ClientMsg);
      this.pongTimer ??= setTimeout(() => {
        // Half-open: nothing came back in time. Close → reconnect path.
        this.pongTimer = null;
        this.ws?.close();
      }, PONG_DEADLINE_MS);
    }, PING_INTERVAL_MS);
  }

  private alive() {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private stopHeartbeat() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.alive();
  }

  /** Evaluated and sent first on every open — how a viewport joins its session. */
  setHello(fn: () => ClientMsg | null) {
    this.hello = fn;
  }

  onOpen(cb: () => void): () => void {
    this.openListeners.add(cb);
    return () => {
      this.openListeners.delete(cb);
    };
  }

  onClose(cb: () => void): () => void {
    this.closeListeners.add(cb);
    return () => {
      this.closeListeners.delete(cb);
    };
  }

  onMessage(l: Listener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  // R.4g: attach/create announce this bundle's build (additive field) so the
  // daemon can log a skewed pair — one choke point, no caller threads it.
  private stamp(msg: ClientMsg): ClientMsg {
    return msg.type === "attach" || msg.type === "create"
      ? { ...msg, clientVersion: CLIENT_VERSION }
      : msg;
  }

  send(msg: ClientMsg) {
    msg = this.stamp(msg);
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.transmit(msg);
    else this.pending.push(msg);
  }

  close() {
    this.closedByUs = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    window.removeEventListener("online", this.reconnectNow);
    document.removeEventListener("visibilitychange", this.onVisible);
    this.ws?.close();
  }
}
