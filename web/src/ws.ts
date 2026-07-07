import type { ClientMsg, WireMsg } from "@protocol";

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
 * The default endpoint: same-origin /ws. Two Phase-R additions, both inert on
 * a local page: wss: when the page itself is https (the deployed relay), and
 * the pairing code — a remote page arrives as /?code=<pairing code>, and
 * in-app navigation (fleet row links, history.replaceState) drops the query,
 * so the code is kept per-tab in sessionStorage and re-attached to every
 * (re)connect URL. Shell-owned state: agent output can never read or set it.
 */
function defaultWsUrl(): string {
  const fromUrl = new URLSearchParams(location.search).get("code");
  if (fromUrl) sessionStorage.setItem("genui-relay-code", fromUrl);
  const code = fromUrl ?? sessionStorage.getItem("genui-relay-code");
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws${code ? `?code=${encodeURIComponent(code)}` : ""}`;
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
 */
export class SocketClient {
  private ws!: WebSocket;
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

  constructor(private url = defaultWsUrl()) {
    this.connect();
    // A returning network or a re-focused tab shouldn't wait out the backoff.
    window.addEventListener("online", this.reconnectNow);
    document.addEventListener("visibilitychange", this.onVisible);
  }

  private onVisible = () => {
    if (document.visibilityState === "visible") this.reconnectNow();
  };

  private reconnectNow = () => {
    if (this.closedByUs || this.ws.readyState === WebSocket.OPEN) return;
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
    sock.onopen = () => {
      if (this.ws !== sock) return;
      this.backoff = BACKOFF_MIN_MS;
      for (const cb of this.openListeners) cb();
      const hello = this.hello?.();
      if (hello) sock.send(JSON.stringify(hello));
      for (const msg of this.pending.splice(0)) sock.send(JSON.stringify(msg));
      this.startHeartbeat();
    };
    sock.onmessage = (e) => {
      if (this.ws !== sock) return;
      this.alive(); // any traffic proves the pipe
      let msg: WireMsg;
      try {
        msg = JSON.parse(e.data as string) as WireMsg;
      } catch {
        return;
      }
      if (typeof msg.seq === "number") this.lastSeq = msg.seq;
      if (msg.type === "pong") return; // liveness only, not for the app
      for (const l of this.listeners) l(msg);
    };
    sock.onclose = () => {
      if (this.ws !== sock) return;
      this.stopHeartbeat();
      for (const cb of this.closeListeners) cb();
      if (!this.closedByUs) {
        this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX_MS);
      }
    };
  }

  private startHeartbeat() {
    // A superseded socket skips stopHeartbeat (its onclose is inert), so a
    // fresh open must clear whatever timers the previous socket left running.
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(JSON.stringify({ type: "ping" } satisfies ClientMsg));
      this.pongTimer ??= setTimeout(() => {
        // Half-open: nothing came back in time. Close → reconnect path.
        this.pongTimer = null;
        this.ws.close();
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

  send(msg: ClientMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    else this.pending.push(msg);
  }

  close() {
    this.closedByUs = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    window.removeEventListener("online", this.reconnectNow);
    document.removeEventListener("visibilitychange", this.onVisible);
    this.ws.close();
  }
}
