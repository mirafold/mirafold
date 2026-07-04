import type { ClientMsg, WireMsg } from "@protocol";

type Listener = (msg: WireMsg) => void;

/**
 * The shell's WebSocket client. Lives in the trusted shell — agent output
 * never touches it. Reconnects automatically on drop (Phase 0 stub; real
 * session resume is Phase 4).
 */
export class SocketClient {
  private ws!: WebSocket;
  private listeners = new Set<Listener>();
  private pending: ClientMsg[] = [];
  private closedByUs = false;

  constructor(private url = `ws://${location.host}/ws`) {
    this.connect();
  }

  private connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
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

  onMessage(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
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
