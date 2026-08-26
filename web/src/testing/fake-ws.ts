// Test doubles for the browser edge — a stubbed WebSocket, window/document
// listener registries, and an in-memory Storage — so the connection layer
// and the session bus can be driven in plain Node with no browser and no
// jsdom (the zero-test-dependency rule). Not a test file: importing a suite
// from another suite would re-register its tests.

/** In-memory Storage stub for newSessionHref (which takes storage injected). */
export function fakeStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  } as Storage;
}

// L.2b3: the reconnect state machine, driven through a stubbed WebSocket —
// no browser, no jsdom. The stub exposes what the client touches (readyState,
// handler props, send/close) plus test-side controls to open a socket,
// deliver a frame, and complete a close. Every instance is tracked so the
// core invariant — at most one live socket, ever — is directly observable.

export class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWS[] = [];
  readyState = FakeWS.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    // Browser semantics: close() only starts the handshake; onclose comes
    // later (finishClose) — the CLOSING window the duplicate-socket race
    // lived in.
    if (this.readyState === FakeWS.CONNECTING || this.readyState === FakeWS.OPEN) {
      this.readyState = FakeWS.CLOSING;
    }
  }
  open() {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  /** A frame that is ALREADY a wire string (sealed handshake/ciphertext). */
  receiveRaw(data: string) {
    this.onmessage?.({ data });
  }
  finishClose(code?: number) {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.(code === undefined ? undefined : { code });
  }
  parsedSent(): { type: string }[] {
    return this.sent.map((s) => JSON.parse(s) as { type: string });
  }
  pings(): number {
    return this.parsedSent().filter((m) => m.type === "ping").length;
  }
}

type Handler = () => void;

/** window/document stand-ins: real listener registries so tests can fire
 * online/visibilitychange and assert removal on close(). */
export function shimDom() {
  const win = new Map<string, Set<Handler>>();
  const doc = new Map<string, Set<Handler>>();
  const listeners = (m: Map<string, Set<Handler>>) => ({
    addEventListener: (type: string, fn: Handler) => {
      if (!m.has(type)) m.set(type, new Set());
      m.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: Handler) => {
      m.get(type)?.delete(fn);
    },
  });
  const g = globalThis as Record<string, unknown>;
  g.window = listeners(win);
  g.document = { ...listeners(doc), visibilityState: "visible" };
  return {
    online: () => {
      for (const fn of win.get("online") ?? []) fn();
    },
    visible: () => {
      for (const fn of doc.get("visibilitychange") ?? []) fn();
    },
    pagehide: () => {
      for (const fn of win.get("pagehide") ?? []) fn();
    },
    listenerCount: () =>
      (win.get("online")?.size ?? 0) +
      (doc.get("visibilitychange")?.size ?? 0) +
      (win.get("pagehide")?.size ?? 0),
  };
}
