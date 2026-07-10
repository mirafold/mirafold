// #10 (viewport leak): a local viewport is detached only when its WebSocket
// fires `close`. A half-open socket (tab navigated away, laptop slept, network
// dropped) may never deliver `close`, so its viewport lingers attached — over-
// counting viewports and keeping the session from ever reaching its idle
// reaper (which only fires at zero viewports). The cure is a server-side
// ping/pong heartbeat: browsers auto-answer protocol pings, so a socket that
// misses a round is dead and gets terminated (which finally fires `close` →
// detach). This module is the pure per-tick decision, kept apart from the
// socket wiring in index.ts so it can be unit-tested without real sockets.

export interface Pingable {
  ping(): void;
  terminate(): void;
}

interface AliveMap<T> {
  get(key: T): boolean | undefined;
  set(key: T, value: boolean): unknown;
}

/**
 * One heartbeat tick over the currently-open sockets. A socket still marked
 * not-alive from the previous tick never ponged back — terminate it (that
 * fires its `close`, which detaches the viewport). Every other socket is
 * pinged and marked pending until its pong flips it back to alive. Returns how
 * many sockets were reaped, for logging/tests.
 */
export function sweepLiveness<T extends Pingable>(clients: Iterable<T>, alive: AliveMap<T>): number {
  let reaped = 0;
  // Snapshot first: terminate() removes the socket from a live wss.clients Set,
  // which would mutate the collection mid-iteration.
  for (const ws of Array.from(clients)) {
    if (alive.get(ws) === false) {
      ws.terminate();
      reaped++;
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
  return reaped;
}
