import type { FsDirEntry } from "@protocol";

// The Explorer's lazy per-directory store (E2.2) — the client half of the
// fs_listdir/fs_dir pair. The panel no longer holds one flat whole-tree
// listing; it holds one DirState per directory it has asked about, keyed by
// root-relative /-separated path ("" = the session root), and fetches a
// directory the first time it's expanded. Pure data + pure transitions here
// (Tier-1 testable); FilesPanel owns the correlation-id bookkeeping and the
// actual requests.
//
// A directory is one of: absent from the map (unfetched — expanding it must
// fetch), loading with nothing yet (show a loading row), loaded (entries +
// honest truncated flag), refetching (loading with the PREVIOUS entries kept
// visible — a turn-end refresh must never read as a collapse), or errored.

export type DirState = {
  /** A fetch is in flight. With `entries` present this is a refetch — keep
   *  showing what we have; the reply swaps it. */
  loading: boolean;
  /** The last successful listing; absent until the first reply lands. */
  entries?: FsDirEntry[];
  /** The last reply's per-directory cap flag — honest, per E2.1. */
  truncated?: boolean;
  /** The last reply was an error. Kept beside stale `entries` if we had any
   *  (showing a known-good listing beats a bare error row on a throttled
   *  refetch); the panel shows the error row only when there's nothing else. */
  error?: string;
};

/** Immutable map, replaced wholesale on every transition — React state. */
export type DirStore = ReadonlyMap<string, DirState>;

export const emptyDirStore = (): DirStore => new Map();

/** Mark `path` as fetching. Previous entries (and truncation) stay visible;
 *  a previous error is cleared — the new reply decides. */
export function beginDirFetch(store: DirStore, path: string): DirStore {
  const next = new Map(store);
  const prev = store.get(path);
  next.set(path, {
    loading: true,
    ...(prev?.entries ? { entries: prev.entries, truncated: prev.truncated } : {}),
  });
  return next;
}

/** Apply an fs_dir reply body to `path`. The caller has already dropped
 *  stale replies (per-dir correlation ids live in the panel); this is only
 *  the state transition. An error keeps prior entries (see DirState.error). */
export function applyDirReply(
  store: DirStore,
  path: string,
  reply: { entries: FsDirEntry[]; truncated?: boolean; error?: string },
): DirStore {
  const next = new Map(store);
  const prev = store.get(path);
  if (reply.error) {
    next.set(path, {
      loading: false,
      error: reply.error,
      ...(prev?.entries ? { entries: prev.entries, truncated: prev.truncated } : {}),
    });
  } else {
    next.set(path, {
      loading: false,
      entries: reply.entries,
      truncated: Boolean(reply.truncated),
    });
  }
  return next;
}

/** Drop every cached directory that isn't in `keep` (nor the root). Used at
 *  refresh boundaries (open, turn-end, the button): expanded dirs refetch in
 *  place, and anything cached-but-collapsed is invalidated so its next
 *  expand fetches fresh instead of serving a listing from before the turn. */
export function pruneDirStore(store: DirStore, keep: ReadonlySet<string>): DirStore {
  const next = new Map<string, DirState>();
  for (const [path, state] of store) {
    if (path === "" || keep.has(path)) next.set(path, state);
  }
  return next;
}

/** How long a bell-triggered refresh must wait (W.2): immediately when the
 *  last one is at least `gapMs` old, else the remainder of the gap — the
 *  client-side coalescing that keeps a busy disk (bells are server-debounced
 *  but each refresh spends one request per shown directory) from draining
 *  the server's token bucket. Pure, for Tier-1. */
export const bellRefreshDelay = (nowMs: number, lastRefreshMs: number, gapMs: number): number =>
  Math.max(0, lastRefreshMs + gapMs - nowMs);

/** The child-directory paths of one listing — what the open-panel prefetch
 *  walks (fetch the first level so expanding it is instant). Symlinks are
 *  leaves by kind (E2.1's rule), so only `dir` children qualify. */
export function childDirPaths(parent: string, entries: FsDirEntry[]): string[] {
  return entries
    .filter((e) => e.kind === "dir")
    .map((e) => (parent ? `${parent}/${e.name}` : e.name));
}
