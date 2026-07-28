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

// The relay's stable close codes a VIEWPORT can be refused with. A small
// hand-mirror of server/relay/relay-protocol.ts (pinned there against the
// relay's own contract by the contract-guard itest) — relay-protocol.ts pulls
// in node:crypto and can't cross into the web bundle, so these three codes are
// duplicated with this note rather than shared through a module.
const VIEWPORT_CLOSE = {
  NO_DAEMON: 4003, // CLOSE_BAD_CODE — no daemon paired under this id
  OVERLOADED: 4004, // CLOSE_OVERLOADED — relay or this pair at capacity
  FORBIDDEN_ORIGIN: 4006, // CLOSE_FORBIDDEN_ORIGIN — this page's origin isn't allowed
} as const;

/** A relay close code that means this viewport was REFUSED (not a routine
 *  drop), mapped to a short line for the connection indicator. undefined = an
 *  ordinary disconnect → the plain "reconnecting…". Exported for the unit test.
 *  Surfaced visibly beside the status dot when down-with-reason (2026-07-28,
 *  Kyle's call), not just in the dot's tooltip. Note OVERLOADED can arrive
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
 * the browser, so the relay's HTTP logs can't see it. It's stashed on the
 * device (in-app navigation — fleet row links, history.replaceState — drops the
 * fragment) and scrubbed from the address bar. Shell-owned state: agent output
 * can never read or set it.
 *
 * The stash is localStorage, NOT sessionStorage (2026-07-25, Kyle's phone).
 * Per-tab storage does not reliably survive what a phone actually does to a
 * backgrounded tab: switch to another app for a few minutes, and the browser is
 * free to discard the tab and rebuild it on return. The URL is unchanged (the
 * fragment was scrubbed on first load, by design) — so a rebuilt tab with no
 * stored code has no way to reach the daemon at all, and lands on a shell that
 * looks like a fresh session: no transcript, Explorer disabled, no end button,
 * prompts going nowhere. Reproduced exactly by wiping the store and reloading.
 *
 * What persisting it costs: the code is a bearer credential — whoever holds it
 * reaches the sessions — so it now outlives the tab on that device. Two things
 * bound that: pairing codes are per-launch (a daemon restart makes every stored
 * code useless), and this stash expires on its own after PAIRING_MAX_AGE_MS.
 * sessionStorage is still READ, so a tab paired by an older build keeps working.
 *
 * Static-origin serving (R.4/R.5): the page may be served from a static origin
 * that is NOT the relay (app.mirafold.com serves the bundle; relay.mirafold.sh
 * carries the socket — the trust split: whoever serves the JS must not carry
 * the traffic, and vice versa). The fragment then also carries
 * relay=<ws(s) origin> saying where to dial. Same-origin remains the fallback
 * (dev, and a self-host that serves both from one host).
 */

/** Parses `#code=…[&relay=…]`. Exported for tests — pure, no storage/DOM.
 *  The relay origin is honored only as a well-formed ws:/wss: URL (normalized
 *  to its origin); anything else — a crafted link steering the socket at some
 *  other protocol — is dropped, falling back to same-origin. */
export function relayTargetFromFragment(hash: string): { code: string; ws: string | null } | null {
  const code = hash.match(/(?:^#|&)code=([A-Za-z0-9_-]+)/);
  if (!code) return null;
  const raw = hash.match(/(?:^#|&)relay=([^&]+)/);
  let ws: string | null = null;
  if (raw) {
    try {
      const u = new URL(decodeURIComponent(raw[1]));
      if (u.protocol === "ws:" || u.protocol === "wss:") ws = u.origin;
    } catch {
      /* malformed — same-origin fallback */
    }
  }
  return { code: code[1], ws };
}

/** Parses the pairing fragment's session hint (`…&s=<id>`) — the session the
 *  QR was made from, so a paired device lands IN it rather than on the fleet.
 *  Honored only as a full `[\w-]+` token (the router's own id shape); anything
 *  else is dropped → mission control, today's behavior. One-shot intent for
 *  THIS load: unlike the code beside it, it is never stashed in storage —
 *  persisting it would bounce the device back into the session on every tap
 *  of home. Pure, exported for tests. */
export function sessionHintFromFragment(hash: string): string | null {
  return hash.match(/(?:^#|&)s=([\w-]+)(?:&|$)/)?.[1] ?? null;
}

const CODE_KEY = "mirafold-relay-code";
const WS_KEY = "mirafold-relay-ws";
const PAIRED_AT_KEY = "mirafold-relay-paired-at";
/** A stored pairing goes stale on its own — see the storage note above. */
const PAIRING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Reads the device's stored pairing, dropping one that has aged out. Falls
 *  back to sessionStorage for tabs paired before the store moved. Exported for
 *  tests — takes its stores, touches no DOM. */
export function storedPairing(
  store: Storage,
  legacy: Storage | null = null,
  now: number = Date.now(),
): { code: string; ws: string | null } | null {
  const code = store.getItem(CODE_KEY);
  if (code) {
    const pairedAt = Number(store.getItem(PAIRED_AT_KEY) ?? 0);
    if (now - pairedAt <= PAIRING_MAX_AGE_MS) return { code, ws: store.getItem(WS_KEY) };
    for (const k of [CODE_KEY, WS_KEY, PAIRED_AT_KEY]) store.removeItem(k);
  }
  const carried = legacy?.getItem(CODE_KEY);
  return carried ? { code: carried, ws: legacy!.getItem(WS_KEY) } : null;
}

function relayTargetFromPage(): { code: string; ws: string | null } | null {
  const target = relayTargetFromFragment(location.hash);
  if (target) {
    localStorage.setItem(CODE_KEY, target.code);
    localStorage.setItem(PAIRED_AT_KEY, String(Date.now()));
    // A fresh #code with no relay param must also CLEAR a stale stored origin —
    // the new pairing decides where to dial, not a leftover from the last one.
    if (target.ws) localStorage.setItem(WS_KEY, target.ws);
    else localStorage.removeItem(WS_KEY);
    history.replaceState(null, "", location.pathname + location.search);
    return target;
  }
  return storedPairing(localStorage, sessionStorage);
}

/** The href for the "new session" affordance, which opens a FRESH TAB. A new
 *  tab inherits neither the URL fragment nor — reliably, and never on a
 *  `noopener` open or on mobile — the opener's sessionStorage. So on the relay
 *  path the pairing target must be re-encoded into the new tab's fragment, or
 *  that tab finds no code, falls back to a local `ws://` origin with no daemon
 *  behind it, and hangs on "connecting" forever with the picker never arriving
 *  (the mobile new-session bug, 2026-07-24). The fragment stays client-side
 *  exactly as the QR's did — it is never sent to the relay, and the new tab
 *  scrubs it on load. A local page has no stored code and gets the plain URL.
 *  Reads storage lazily so tests can drive it; `base` defaults to the real
 *  new-session URL. */
export function newSessionHref(base = "/?new=1", storage: Storage = localStorage): string {
  const code = storage.getItem(CODE_KEY);
  if (!code) return base;
  const ws = storage.getItem(WS_KEY);
  const frag = ws
    ? `#code=${encodeURIComponent(code)}&relay=${encodeURIComponent(ws)}`
    : `#code=${encodeURIComponent(code)}`;
  return base + frag;
}

/**
 * The shell's WebSocket client. Lives in the trusted shell — agent output
 * never touches it. Reconnects automatically on drop; every (re)open first
 * sends the hello (attach/create, Step 4.2) so the connection is a viewport
 * on the right session before anything else flows.
 *
 * Tracks the last broadcast `seq` seen so the hello can ask for a
 * tail-only resume, heartbeats to catch half-open sockets, and backs off
 * between attempts (with instant retry when the network returns).
 *
 * Phase R.3: with a pairing code present, the connection is end-to-end
 * encrypted — the relay sees only the code's derived pairId in the URL and
 * ciphertext frames. Each (re)connect performs the handshake before the
 * hello, and any frame that fails to authenticate closes the socket (fail
 * closed → normal reconnect → fresh handshake). A local page has no code and
 * none of this engages (4.4).
 */
// Uncaught front-end errors ride the socket into the daemon's flight-recorder
// log — otherwise a front-end crash dies in the devtools console and the log a
// bug report attaches says nothing (R.4g follow-through, 2026-07-23).
// Installed once per page, forwarding through the most recent SocketClient
// (whose pending queue survives disconnects). Capped so an error loop can't
// flood the daemon, clipped so one giant message can't bloat a frame — the
// server re-caps and re-clips, trusting nothing.
const ERROR_REPORT_MAX = 20;
const ERROR_REPORT_CLIP = 2_000;
let errorSocket: SocketClient | null = null;
let errorReports = 0;
let errorForwardingInstalled = false;

function installErrorForwarding() {
  if (errorForwardingInstalled) return;
  errorForwardingInstalled = true;
  const forward = (message: string) => {
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
    errorSocket = this;
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
    sock.onclose = (ev?: CloseEvent) => {
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
  // the daemon can log a skewed pair — one choke point, no caller threads it (R.4g).
  private stamp(msg: ClientMsg): ClientMsg {
    return msg.type === "attach" || msg.type === "create" || msg.type === "client_error"
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
    window.removeEventListener("pagehide", this.onPageHide);
    this.ws?.close();
  }
}
