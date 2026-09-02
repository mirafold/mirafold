import type { ChangeItem } from "./changes";
import { bellRefreshDelay } from "./folder-tree";

// A disk bell can immediately follow the query that opening the surface sent.
// Keep the follow-up outside the daemon's min-interval/git-in-flight window,
// and collapse bursts onto one fresh snapshot.
export const CHANGE_REFRESH_GAP_MS = 1_000;
// The daemon's per-viewport fs_diff floor is 250ms. Keep a little scheduling
// headroom and coalesce rapid navigation onto the newest requested file.
export const CHANGE_FILE_REQUEST_GAP_MS = 350;

type Timer = ReturnType<typeof setTimeout>;

export type ChangesRequestsDeps = {
  /** Send fs_changes; returns the correlation id the reply will echo. */
  requestChanges: () => string;
  /** Open one changed file in the diff presenter. */
  openFile: (item: ChangeItem) => void;
  now?: () => number;
  timers?: { set: (fn: () => void, ms: number) => Timer; clear: (t: Timer) => void };
};

/**
 * The Changes workspace's request lifecycle, held apart from React so it is
 * table-testable: one change-set request in flight at a time (a refresh
 * asked for meanwhile is queued and runs after the reply), disk bells and
 * turn ends coalesced onto one refresh outside the daemon's rate window,
 * and file opens coalesced onto the newest requested file. Every teardown
 * path drops the same scheduled work.
 */
export function createChangesRequests(deps: ChangesRequestsDeps) {
  const now = deps.now ?? Date.now;
  const timers = deps.timers ?? {
    set: (fn: () => void, ms: number) => setTimeout(fn, ms) as Timer,
    clear: (t: Timer) => clearTimeout(t),
  };
  let open = false;
  let sessionKey: string | undefined;
  let requestId: string | null = null;
  let pending = false;
  let lastRequestAt = 0;
  let refreshQueued = false;
  let refreshTimer: Timer | null = null;
  let queuedFile: ChangeItem | null = null;
  let fileTimer: Timer | null = null;
  let lastFileRequestAt = 0;

  const clearScheduled = () => {
    if (refreshTimer) timers.clear(refreshTimer);
    refreshTimer = null;
    if (fileTimer) timers.clear(fileTimer);
    fileTimer = null;
    queuedFile = null;
  };

  const requests = {
    /** Whether the surface is showing — scheduled work only fires while it is. */
    setOpen(value: boolean) {
      open = value;
    },
    /** The session this surface queries; none = nothing is ever requested. */
    setSession(key: string | undefined) {
      sessionKey = key;
    },
    get pending() {
      return pending;
    },
    /** Request the change set now. False when one is already in flight (a
     *  refresh is then queued behind it) or there is no session. */
    requestNow(): boolean {
      if (pending || !sessionKey) {
        if (pending) refreshQueued = true;
        return false;
      }
      pending = true;
      lastRequestAt = now();
      requestId = deps.requestChanges();
      return true;
    },
    /** Refresh soon: coalesced onto one request outside the daemon's rate
     *  window, or queued behind an in-flight one. */
    scheduleRefresh() {
      if (!open) return;
      if (pending) {
        refreshQueued = true;
        return;
      }
      if (refreshTimer) return;
      refreshTimer = timers.set(
        () => {
          refreshTimer = null;
          if (open) requests.requestNow();
        },
        bellRefreshDelay(now(), lastRequestAt, CHANGE_REFRESH_GAP_MS),
      );
    },
    /** Open this file's diff soon — rapid navigation lands on the newest ask. */
    queueFile(item: ChangeItem) {
      queuedFile = item;
      if (fileTimer) return;
      const run = () => {
        fileTimer = null;
        const next = queuedFile;
        queuedFile = null;
        if (!next || !open) return;
        lastFileRequestAt = now();
        deps.openFile(next);
      };
      const delay = bellRefreshDelay(now(), lastFileRequestAt, CHANGE_FILE_REQUEST_GAP_MS);
      if (delay === 0) run();
      else fileTimer = timers.set(run, delay);
    },
    /** A change-set reply arrived: true when it answers the request in
     *  flight (a stale or foreign id is ignored). */
    acceptReply(id: string): boolean {
      if (requestId !== id) return false;
      requestId = null;
      pending = false;
      return true;
    },
    /** After a reply was applied: run the refresh that queued behind it. */
    afterReply() {
      if (refreshQueued) {
        refreshQueued = false;
        requests.scheduleRefresh();
      }
    },
    /** Forget the in-flight request and every scheduled follow-up (a
     *  reconnect, a session switch, a panel close). */
    reset() {
      requestId = null;
      pending = false;
      refreshQueued = false;
      lastRequestAt = 0;
      lastFileRequestAt = 0;
      clearScheduled();
    },
    /** Drop scheduled work only (the panel closed); an in-flight request
     *  still completes so its reply is not mistaken for stale. */
    clearScheduled() {
      refreshQueued = false;
      clearScheduled();
    },
  };
  return requests;
}
