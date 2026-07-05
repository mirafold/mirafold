import type { ClientMsg, WireMsg } from "@protocol";

type Listener = (msg: WireMsg) => void;

/**
 * The shell's WebSocket client. Lives in the trusted shell — agent output
 * never touches it. Reconnects automatically on drop; every (re)open first
 * sends the hello (attach/create, Step 4.2) so the connection is a viewport
 * on the right session before anything else flows.
 */
export class SocketClient {
  private ws!: WebSocket;
  private listeners = new Set<Listener>();
  private openListeners = new Set<() => void>();
  private pending: ClientMsg[] = [];
  private closedByUs = false;
  private hello: (() => ClientMsg) | null = null;

  constructor(private url = `ws://${location.host}/ws`) {
    this.connect();
  }

  private connect() {
    if (this.closedByUs) return; // a queued reconnect must not outlive close()
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      for (const cb of this.openListeners) cb();
      if (this.hello) this.ws.send(JSON.stringify(this.hello()));
      for (const msg of this.pending.splice(0)) this.ws.send(JSON.stringify(msg));
    };
    this.ws.onmessage = (e) => {
      let msg: WireMsg;
      try {
        msg = JSON.parse(e.data as string) as WireMsg;
      } catch {
        return;
      }
      for (const l of this.listeners) l(msg);
    };
    this.ws.onclose = () => {
      if (!this.closedByUs) setTimeout(() => this.connect(), 1000);
    };
  }

  /** Evaluated and sent first on every open — how a viewport joins its session. */
  setHello(fn: () => ClientMsg) {
    this.hello = fn;
  }

  onOpen(cb: () => void): () => void {
    this.openListeners.add(cb);
    return () => {
      this.openListeners.delete(cb);
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
    this.ws.close();
  }
}
