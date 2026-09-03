// The live tree's doorbell: one filesystem watcher per session,
// alive only while a viewport is attached. Doorbell, not precision: any
// change under the session root fires ONE coalesced callback per window,
// carrying a best-effort, capped list of touched paths — consumers must
// tolerate a truncated (or someday absent) hint and treat the bell as
// "something changed → refetch". @parcel/watcher does the native work; its
// exclusion globs keep node_modules and .git/objects from consuming inotify
// watches at all, while the REST of .git stays watched — HEAD/index/refs are
// what move on a commit or branch switch, which changes statuses without
// touching a single working file. (That coverage holds when the session root
// IS the repo root. A session scoped to a SUBDIRECTORY of a repo has its
// `.git` above the watched root, so out-of-band commits ring nothing there;
// turn-end refresh and the button remain the floor, as they are for every
// missed event.) Failure is fail-open: any error stops this watcher and
// reports once via onError; the turn-end refresh and the manual button
// remain the floor.
//
// One backend wart, healed here: the inotify backend misses a subtree
// created faster than it can register watches — `mkdir -p a/b` reports only
// `a`, and everything ever written under `a/b` afterward is silent (proven
// against 2.6.0; the staged create works, the recursive one doesn't). So a
// window that saw a directory CREATED triggers one resubscribe — a fresh
// bounded crawl, the same work as starting the watch. It must be
// unsubscribe-THEN-subscribe: the native layer shares one watcher per
// directory, so an overlapping second subscription attaches to the same
// stale watch set and never crawls (also probed). The brief unwatched gap
// is covered by ringing one synthetic truncated bell once the new
// subscription is live — "something may have changed, refetch". Dirs
// created DURING a crawl ring their own create event, which triggers the
// next resubscribe, until the tree is stable and covered.

import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import watcher from "@parcel/watcher";
import { envInt } from "../../../env";

// One bell at most per window: the FIRST event arms the timer, later events
// only accumulate. A fixed window from the first event — not a trailing
// debounce — so an agent writing continuously can never starve the bell.
const FS_WATCH_DEBOUNCE_MS = envInt("FS_WATCH_DEBOUNCE_MS", 400);
// The paths hint stays small on the wire; past the cap the bell rings
// with `truncated` and the client refetches everything it shows anyway.
// Capped on COUNT and BYTES both: a path may be thousands
// of characters, so a count-only cap would let one bell carry a quarter
// megabyte — bandwidth a phone viewport pays for over the relay, every
// window. Real projects never approach either bound.
const FS_WATCH_MAX_PATHS = envInt("FS_WATCH_MAX_PATHS", 64);
const FS_WATCH_MAX_PATH_BYTES = envInt("FS_WATCH_MAX_PATH_BYTES", 16_000);

// Subtrees whose churn nobody browses — excluded so they never consume
// watches (the reason this dependency exists; Node's recursive fs.watch has
// no exclusions). Both glob shapes per name: the bare form prunes the
// directory itself, the /** form catches events beneath it.
const IGNORE_GLOBS = [
  "**/node_modules",
  "**/node_modules/**",
  "**/.git/objects",
  "**/.git/objects/**",
];

export type FsChange = { paths: string[]; truncated: boolean };

/** Still a directory right now? A created-then-deleted path is simply no. */
const isDir = (abs: string): boolean => {
  try {
    return lstatSync(abs).isDirectory();
  } catch {
    return false;
  }
};

export type FsWatchHandle = {
  /** Resolves once the subscription is live (or has already failed via
   *  onError) — it never rejects. Callers that only stop() can ignore it. */
  ready: Promise<void>;
  /** Idempotent; safe before ready settles (the subscription is dropped
   *  the moment it arrives). */
  stop: () => void;
};

/**
 * Watch `root` and ring `onChange` with coalesced, root-relative paths.
 * Synchronous facade over the async subscribe so lifecycle callers
 * (attach/detach) never await: stop() before the subscription lands simply
 * unsubscribes it on arrival. Any error — bad root, subscribe failure, a
 * runtime watcher error (ENOSPC watch exhaustion) — stops the watcher and
 * calls onError exactly once; onChange never fires after either.
 */
export function startWatch(
  root: string,
  onChange: (change: FsChange) => void,
  opts: {
    debounceMs?: number;
    maxPaths?: number;
    maxPathBytes?: number;
    onError?: (err: unknown) => void;
  } = {},
): FsWatchHandle {
  const debounceMs = opts.debounceMs ?? FS_WATCH_DEBOUNCE_MS;
  const maxPaths = opts.maxPaths ?? FS_WATCH_MAX_PATHS;
  const maxPathBytes = opts.maxPathBytes ?? FS_WATCH_MAX_PATH_BYTES;
  let stopped = false;
  let sub: watcher.AsyncSubscription | undefined;
  let timer: NodeJS.Timeout | undefined;
  const pending = new Set<string>();
  let pendingBytes = 0;
  let truncated = false;
  // The resubscribe latch (see the header): a window that saw a new
  // directory needs a fresh crawl; one runs at a time, and a need that
  // arises mid-crawl runs after it rather than being lost.
  let sawNewDir = false;
  let resubRunning = false;
  let resubPending = false;

  const stop = (): void => {
    stopped = true;
    clearTimeout(timer);
    timer = undefined;
    pending.clear();
    const s = sub;
    sub = undefined;
    if (s) void s.unsubscribe().catch(() => {});
  };

  const fail = (err: unknown): void => {
    if (stopped) return;
    stop();
    opts.onError?.(err);
  };

  // Event paths come back kernel-real; realpath the root once so they
  // relativize cleanly when the caller named it through a symlink.
  let real: string;
  try {
    real = realpathSync(root);
  } catch (err) {
    // Async like every other failure — the caller holds the handle first.
    queueMicrotask(() => fail(err));
    return { ready: Promise.resolve(), stop };
  }

  // Every subscribe gets its OWN closure: the library keys unsubscribe on
  // (dir, callback, opts), so a re-subscribed shared handler would be
  // indistinguishable from the one just torn down.
  const subscribe = () =>
    watcher.subscribe(real, (err, events) => onEvents(err, events), { ignore: IGNORE_GLOBS });

  const resubscribe = async (): Promise<void> => {
    if (resubRunning) {
      resubPending = true;
      return;
    }
    resubRunning = true;
    do {
      resubPending = false;
      try {
        // Tear down first — see the header: only a fully released directory
        // gets a fresh crawl from the next subscribe.
        const old = sub;
        sub = undefined;
        if (old) await old.unsubscribe();
        if (stopped) break;
        const next = await subscribe();
        if (stopped) {
          void next.unsubscribe().catch(() => {});
          break;
        }
        sub = next;
        // Whatever happened in the gap went unseen — one honest bell with an
        // empty, truncated hint tells consumers to refetch regardless.
        onChange({ paths: [], truncated: true });
      } catch (err) {
        fail(err);
        break;
      }
    } while (resubPending && !stopped);
    resubRunning = false;
  };

  const fire = (): void => {
    timer = undefined;
    const paths = [...pending].sort();
    const wasTruncated = truncated;
    pending.clear();
    pendingBytes = 0;
    truncated = false;
    const needResub = sawNewDir;
    sawNewDir = false;
    onChange({ paths, truncated: wasTruncated });
    if (needResub && !stopped) void resubscribe();
  };

  const onEvents: watcher.SubscribeCallback = (err, events) => {
    if (stopped) return;
    if (err) return fail(err);
    for (const e of events) {
      // Checked on EVERY event — before the hint caps can cut the loop short —
      // because missing one created dir mutes its subtree for good.
      if (!sawNewDir && e.type === "create" && isDir(e.path)) sawNewDir = true;
      if (pending.size >= maxPaths || pendingBytes >= maxPathBytes) {
        truncated = true;
        continue;
      }
      const rel = path.relative(real, e.path).split(path.sep).join("/");
      if (rel.startsWith("..")) continue; // never happens; never trust it anyway
      const hint = rel === "" ? "." : rel;
      if (pending.has(hint)) continue; // a repeated path costs no new budget
      pending.add(hint);
      pendingBytes += Buffer.byteLength(hint, "utf8");
    }
    if (timer === undefined) timer = setTimeout(fire, debounceMs);
  };

  const ready = subscribe()
    .then((s) => {
      if (stopped) void s.unsubscribe().catch(() => {});
      else sub = s;
    })
    .catch(fail)
    .then(() => undefined);

  return { ready, stop };
}
