import type { ClientMsg, WireMsg } from "@protocol";
import { CLIENT_VERSION } from "./version";
import { relayTargetFromPage, rememberPairing } from "./relay-pairing";
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

// The relay's stable close codes a VIEWPORT can be refused with. A small
// hand-mirror of the relay's contract (mirafold-relay contract.ts — 4006 has no
// constant in relay-protocol.ts at all) — relay-protocol.ts pulls in
// node:crypto and can't cross into the web bundle, so these three codes are
// duplicated. Pinned DIRECTLY against contract.ts by relay-service.itest.ts,
// which feeds each contract code through viewportRefusalReason.
const VIEWPORT_CLOSE = {
  NO_DAEMON: 4003, // CLOSE_BAD_CODE — no daemon paired under this id
  OVERLOADED: 4004, // CLOSE_OVERLOADED — relay or this pair at capacity
  FORBIDDEN_ORIGIN: 4006, // CLOSE_FORBIDDEN_ORIGIN — this page's origin isn't allowed
} as const;

/** A relay close code that means this viewport was REFUSED (not a routine
 *  drop), mapped to a short line for the connection indicator. undefined = an
 *  ordinary disconnect → the plain "reconnecting…". Exported for the unit test.
 *  Surfaced visibly beside the status dot when down-with-reason, not just in
 *  the dot's tooltip. Note OVERLOADED can arrive
 *  mid-session too, not only at the door: the relay closes a receiver whose
 *  socket buffered past its backpressure limit with the same code, so its
 *  wording stays true for both ("at capacity" covers shedding a stalled
 *  connection). */
export function viewportRefusalReason(code: number | undefined): string | undefined {
  switch (code) {
    case VIEWPORT_CLOSE.NO_DAEMON:
      return "Desktop not reachable — is Mirafold running there?";
    case VIEWPORT_CLOSE.OVERLOADED:
      return "Relay at capacity — retrying";
    case VIEWPORT_CLOSE.FORBIDDEN_ORIGIN:
      return "This page isn't allowed to connect to the relay";
    default:
      return undefined;
  }
}

// Heartbeat: a wifi blip with no FIN leaves the socket half-open and
// silently dead — the browser would wait forever. Ping on an interval and
// treat any inbound traffic as life; a ping that goes unanswered past the
// deadline closes the socket, which routes into the normal reconnect path.
export const PING_INTERVAL_MS = 25_000;
export const PONG_DEADLINE_MS = 8_000;
// Relay path only: how long an answered upgrade may sit handshake-pending
// before the socket is closed into the retry ladder (nothing else bounds
// that wait; see connect()).
export const HANDSHAKE_DEADLINE_MS = 15_000;
// Reconnect backoff: fast first retry (the daemon is local), capped so a
// long outage doesn't hammer; `online`/tab-visible events short-circuit it.
export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 5_000;

// Uncaught front-end errors ride the socket into the daemon's flight-recorder
// log — otherwise a front-end crash dies in the devtools console and the log a
// bug report attaches says nothing.
// Installed once per page, forwarding through the newest still-live
// SocketClient (whose pending queue survives disconnects). A session can now
// carry a supplemental cockpit watcher; keeping the live clients as a stack
// means closing that watcher restores the session socket instead of silently
// disabling later reports. Capped so an error loop can't flood the daemon,
// clipped so one giant message can't bloat a frame — the server re-caps and
// re-clips, trusting nothing.
const ERROR_REPORT_MAX = 20;
const ERROR_REPORT_CLIP = 2_000;
const errorSockets: SocketClient[] = [];
let errorReports = 0;
let errorForwardingInstalled = false;

function installErrorForwarding() {
  if (errorForwardingInstalled) return;
  errorForwardingInstalled = true;
  const forward = (message: string) => {
    // The newest socket that can send NOW; a supplemental watcher that is
    // refused or reconnecting must not swallow reports into a queue its
    // close() will discard while the session socket sits open beside it.
    const errorSocket =
      [...errorSockets].reverse().find((client) => client.isReady()) ??
      errorSockets[errorSockets.length - 1];
    if (!errorSocket || errorReports >= ERROR_REPORT_MAX) return;
    errorReports++;
    errorSocket.send({ type: "client_error", message: message.slice(0, ERROR_REPORT_CLIP) });
  };
  window.addEventListener("error", (e) =>
    forward(
      e.error instanceof Error
        ? (e.error.stack ?? e.message)
        : `${e.message} (${e.filename}:${e.lineno})`,
    ),
  );
  window.addEventListener("unhandledrejection", (e) => {
    const r: unknown = e.reason;
    forward(`unhandled rejection: ${r instanceof Error ? (r.stack ?? r.message) : String(r)}`);
  });
}

/**
 * The shell's WebSocket client. Lives in the trusted shell — agent output
 * never touches it. Reconnects automatically on drop; every (re)open first
 * sends the hello (attach/create) so the connection is a viewport
 * on the right session before anything else flows.
 *
 * Tracks the last broadcast `seq` seen so the hello can ask for a
 * tail-only resume, heartbeats to catch half-open sockets, and backs off
 * between attempts (with instant retry when the network returns).
 *
 * With a pairing code present, the connection is end-to-end
 * encrypted — the relay sees only the code's derived pairId in the URL and
 * ciphertext frames. Each (re)connect performs the handshake before the
 * hello, and any frame that fails to authenticate closes the socket (fail
 * closed → normal reconnect → fresh handshake). A local page has no code and
 * none of this engages.
 */
/** The shape every frame must have before the app sees it: an object with a
 *  string `type`, and — for the frames whose text the transcript projection
 *  trims and splits — string text fields. A corrupt replay or a buggy adapter
 *  used to wedge the whole projection with one non-string `text` (audit
 *  2026-08-26); now that frame is dropped and the session goes on. Exported
 *  for the Tier-1 pin. */
export function admitWireFrame(parsed: unknown): WireMsg | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const m = parsed as Record<string, unknown>;
  if (typeof m["type"] !== "string") return null;
  for (const field of ["text", "message", "data", "html"]) {
    if (field in m && typeof m[field] !== "string") return null;
  }
  return parsed as WireMsg;
}

export class SocketClient {
  private ws?: WebSocket;
  private listeners = new Set<Listener>();
  private openListeners = new Set<() => void>();
  private closeListeners = new Set<(refusal?: string) => void>();
  private pending: ClientMsg[] = [];
  private closedByUs = false;
  private backoff = BACKOFF_MIN_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  // Returns the join message (attach/create) for this open, or null to send
  // nothing yet — agent picker waits until the user picks an agent.
  private hello: (() => ClientMsg | null) | null = null;
  /** Last broadcast seq seen — the resume cursor sent as attach.afterSeq. */
  lastSeq: number | null = null;

  private url!: string;
  // A fresh fragment pairing awaiting its first successful handshake.
  private unremembered?: { code: string; ws: string | null };
  private pair: PairSecret | null = null;
  /** Open AND (on the relay path) handshaken — the app may talk. */
  private ready = false;
  /** Per-socket sender, swapped in connect(); queues until a socket exists. */
  private transmit: (msg: ClientMsg) => void = (m) => this.pending.push(m);

  constructor(url?: string) {
    errorSockets.push(this);
    installErrorForwarding();
    // A returning network or a re-focused tab shouldn't wait out the backoff.
    window.addEventListener("online", this.reconnectNow);
    document.addEventListener("visibilitychange", this.onVisible);
    window.addEventListener("pagehide", this.onPageHide);
    if (url) {
      this.url = url;
      this.connect();
      return;
    }
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const target = relayTargetFromPage();
    if (!target) {
      this.url = `${proto}://${location.host}/ws`;
      this.connect();
      return;
    }
    // Remote mode: key derivation is async; sends queue in `pending` until
    // the first connect. Only the derived id ever reaches a URL. The socket
    // dials the fragment's relay origin when one was given (static-origin
    // serving), else this page's own host (dev / self-host fallback).
    if (target.fresh) this.unremembered = target;
    void derivePair(target.code).then((pair) => {
      if (this.closedByUs) return;
      this.pair = pair;
      const base = target.ws ?? `${proto}://${location.host}`;
      this.url = `${base}/ws?pair=${pair.id}`;
      this.connect();
    });
  }

  private onVisible = () => {
    if (document.visibilityState === "visible") this.reconnectNow();
  };

  // Navigating away (the home button is a full page navigation) must hand the
  // daemon a clean close, or the viewport lingers attached — and the fleet's
  // count stays stale — until the server heartbeat reaps the half-open socket
  // (30–60s). Only the raw socket closes, NOT close(): a page restored from
  // the back/forward cache must come back through the normal reconnect path.
  private onPageHide = () => {
    this.ws?.close();
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
    // A superseded socket's onclose is inert and never ran stopHeartbeat, so
    // its still-armed pong deadline would otherwise outlive it and fire
    // against the SUCCESSOR socket mid-connect — clear the previous life's
    // timers before dialing.
    this.stopHeartbeat();
    // Each handler checks it still belongs to the current socket: a superseded
    // socket's late onclose must not kill the new heartbeat, fire close
    // listeners, or schedule an extra connect (the duplicate-viewport race).
    const sock = new WebSocket(this.url);
    this.ws = sock;
    this.ready = false;

    // Per-connection channel state. Send/receive each chain their async
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
      sendChain = sendChain
        .then(async () => {
          if (this.ws === sock && cipher && sock.readyState === WebSocket.OPEN) {
            sock.send(await cipher.seal(text));
          } else {
            // Accepted by send() while ready, but the socket died before this
            // chained seal ran — requeue instead of vanishing: `pending` is
            // the queue that survives disconnects.
            this.pending.push(msg);
          }
        })
        .catch(() => {
          // A failed seal would otherwise reject the chain and silently skip
          // every later send on this socket. Fail closed like the receive
          // side: drop the socket into the ordinary retry ladder.
          if (this.ws === sock) sock.close();
        });
    };

    // A handshake the daemon never answers must not wedge forever: the
    // heartbeat only starts at finishOpen and reconnectNow bails on an OPEN
    // socket, so nothing else bounds this wait. The deadline closes the
    // socket into the ordinary retry ladder.
    let handshakeTimer: ReturnType<typeof setTimeout> | null = null;

    sock.onopen = () => {
      if (this.ws !== sock) return;
      if (!pair) {
        this.finishOpen();
        return;
      }
      // Handshake first; the hello and everything else wait for the reply.
      clientNonce = randomBytes(32);
      handshakeTimer = setTimeout(() => {
        if (this.ws === sock && !this.ready) sock.close();
      }, HANDSHAKE_DEADLINE_MS);
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
            // The socket can close while those awaits ran — onclose fires
            // synchronously, this chained continuation later. Finishing the
            // open anyway would flash "connected" on a dead socket and splice
            // `pending` into sends that all fail their readyState guard —
            // every queued message destroyed.
            if (this.ws !== sock || sock.readyState !== WebSocket.OPEN) return;
            if (handshakeTimer) clearTimeout(handshakeTimer);
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
    sock.onclose = (ev?: CloseEvent) => {
      if (handshakeTimer) clearTimeout(handshakeTimer);
      if (this.ws !== sock) return;
      this.ready = false;
      this.stopHeartbeat();
      // A relay refusal (no daemon / at capacity / origin) arrives as a close
      // CODE — surface WHY, so a refused viewport isn't an endless mystery
      // "reconnecting…". Anything else stays an ordinary drop (undefined).
      const refusal = viewportRefusalReason(ev?.code);
      for (const cb of this.closeListeners) cb(refusal);
      if (!this.closedByUs) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
      }
    };
  }

  /** The channel is usable (handshaken, on the relay path) — start the app flow. */
  private finishOpen() {
    // A fresh `#code=` pairing is remembered only now that its handshake
    // succeeded (relay-pairing.ts rememberPairing).
    if (this.unremembered) {
      rememberPairing(this.unremembered);
      this.unremembered = undefined;
    }
    // Backoff resets HERE, not in onopen: a relay refusal is a close CODE,
    // which requires a completed upgrade — resetting on open would let a
    // permanently-refused viewport (dead pairing, at-capacity relay)
    // redial at BACKOFF_MIN forever, ~2 Hz, with the ladder never
    // climbing. Only a channel that actually became usable is evidence of
    // health.
    this.backoff = BACKOFF_MIN_MS;
    this.ready = true;
    for (const cb of this.openListeners) cb();
    const hello = this.hello?.();
    if (hello) this.transmit(this.stamp(hello));
    for (const msg of this.pending.splice(0)) this.transmit(msg);
    this.startHeartbeat();
  }

  /** One decrypted/plain wire frame → the app. */
  private dispatch(text: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const msg = admitWireFrame(parsed);
    if (!msg) return;
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
      // The deadline closes the socket it was armed FOR — closing `this.ws`
      // would let a stale deadline from a superseded socket kill its
      // successor.
      const sock = this.ws;
      this.transmit({ type: "ping" } satisfies ClientMsg);
      this.pongTimer ??= setTimeout(() => {
        // Half-open: nothing came back in time. Close → reconnect path.
        this.pongTimer = null;
        if (this.ws === sock) sock.close();
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

  onClose(cb: (refusal?: string) => void): () => void {
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

  // attach/create/client_error announce this bundle's build (additive field) so
  // the daemon can log a skewed pair — one choke point, no caller threads it.
  private stamp(msg: ClientMsg): ClientMsg {
    return msg.type === "attach" || msg.type === "create" || msg.type === "client_error"
      ? { ...msg, clientVersion: CLIENT_VERSION }
      : msg;
  }

  /** Open and (on the relay path) handshaken: a send goes out now, not to `pending`. */
  isReady(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  private transmitIfOpen(msg: ClientMsg): boolean {
    if (!this.isReady()) return false;
    this.transmit(msg);
    return true;
  }

  send(msg: ClientMsg) {
    msg = this.stamp(msg);
    if (!this.transmitIfOpen(msg)) this.pending.push(msg);
  }

  /** Send a user-gesture side effect only while the channel is usable. Unlike
   *  send(), this never queues a click to run after a later reconnect. The
   *  native folder dialog is local-only, so transmit is synchronous here. */
  sendIfOpen(msg: ClientMsg): boolean {
    return this.transmitIfOpen(this.stamp(msg));
  }

  close() {
    this.closedByUs = true;
    // Stop being an error-forwarding candidate: reports after close would
    // only queue on a client that never reconnects. Removing this entry also
    // restores the preceding live socket when a supplemental watcher closes.
    const errorIndex = errorSockets.lastIndexOf(this);
    if (errorIndex !== -1) errorSockets.splice(errorIndex, 1);
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    window.removeEventListener("online", this.reconnectNow);
    document.removeEventListener("visibilitychange", this.onVisible);
    window.removeEventListener("pagehide", this.onPageHide);
    this.ws?.close();
  }
}
