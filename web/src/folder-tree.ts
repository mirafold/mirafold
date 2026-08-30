import type { FsDirEntry } from "@protocol";

// The folder tree's lazy per-directory store — the client half of the
// fs_listdir/fs_dir pair. The panel holds no flat whole-tree listing;
// it holds one DirState per directory it has asked about, keyed by
// root-relative /-separated path ("" = the session root), and fetches a
// directory the first time it's expanded. Pure data + pure transitions here
// (Tier-1 testable); FolderTreePanel owns the correlation-id bookkeeping and the
// actual requests.
//
// A directory is one of: absent from the map (unfetched — expanding it must
// fetch), loading with nothing yet (show a loading row), loaded (entries +
// honest truncated flag), refetching (loading with the PREVIOUS entries kept
// visible — a turn-end refresh must never read as a collapse), or errored.

/** One successful fs_dir reply: the entries plus the per-directory cap flag. */
export type DirListing = { entries: FsDirEntry[]; truncated: boolean };

export type DirState =
  /** A fetch is in flight. `stale` is the previous listing of a refetch —
   *  keep showing it; the reply swaps it. */
  | { phase: "loading"; stale?: DirListing }
  | { phase: "ready"; listing: DirListing }
  /** The last reply was an error. `stale` keeps a known-good listing beside
   *  it (better than a bare error row on a throttled refetch); the panel
   *  shows the error row only when there's nothing else. */
  | { phase: "error"; error: string; stale?: DirListing };

/** What the tree renders for a directory: the live listing when ready, else
 *  whatever a refetch or error carried forward; undefined when nothing has
 *  ever landed. */
export const shownListing = (state: DirState): DirListing | undefined =>
  state.phase === "ready" ? state.listing : state.stale;

/** Immutable map, replaced wholesale on every transition — React state. */
export type DirStore = ReadonlyMap<string, DirState>;

export const emptyDirStore = (): DirStore => new Map();

/** The carry-forward half of a transition: a prior listing stays visible
 *  until the new reply decides. */
const carried = (prev: DirState | undefined): { stale?: DirListing } => {
  const stale = prev && shownListing(prev);
  return stale ? { stale } : {};
};

/** Mark `path` as fetching. Previous entries (and truncation) stay visible;
 *  a previous error is cleared — the new reply decides. */
export function beginDirFetch(store: DirStore, path: string): DirStore {
  const next = new Map(store);
  const prev = store.get(path);
  next.set(path, { phase: "loading", ...carried(prev) });
  return next;
}

/** Apply an fs_dir reply body to `path`. The caller has already dropped
 *  stale replies (per-dir correlation ids live in the panel); this is only
 *  the state transition. An error keeps a prior listing as `stale`. */
export function applyDirReply(
  store: DirStore,
  path: string,
  reply: { entries: FsDirEntry[]; truncated?: boolean; error?: string },
): DirStore {
  const next = new Map(store);
  const prev = store.get(path);
  if (reply.error) {
    next.set(path, { phase: "error", error: reply.error, ...carried(prev) });
  } else {
    next.set(path, {
      phase: "ready",
      listing: { entries: reply.entries, truncated: Boolean(reply.truncated) },
    });
  }
  return next;
}

/** Drop every cached directory that isn't in `keep` (nor the root). Used at
 *  refresh boundaries (open, turn-end, the button): expanded dirs refetch in
 *  place, and anything cached-but-collapsed is invalidated so its next
 *  expand fetches fresh instead of serving a listing from before the turn. */
export function pruneDirStore(store: DirStore, keep: ReadonlySet<string>): DirStore {
  return new Map([...store].filter(([path]) => path === "" || keep.has(path)));
}

/** How long a bell-triggered refresh must wait: immediately when the
 *  last one is at least `gapMs` old, else the remainder of the gap — the
 *  client-side coalescing that keeps a busy disk (bells are server-debounced
 *  but each refresh spends one request per shown directory) from draining
 *  the server's token bucket. Pure, for Tier-1. */
export const bellRefreshDelay = (nowMs: number, lastRefreshMs: number, gapMs: number): number =>
  Math.max(0, lastRefreshMs + gapMs - nowMs);

/** The child-directory paths of one listing — what the open-panel prefetch
 *  walks (fetch the first level so expanding it is instant). Symlinks are
 *  leaves by kind, so only `dir` children qualify. */
export function childDirPaths(parent: string, entries: FsDirEntry[]): string[] {
  return entries
    .filter((e) => e.kind === "dir")
    .map((e) => (parent ? `${parent}/${e.name}` : e.name));
}

/** The root row shows just the checked-out folder's NAME; the full ~-path
 *  stays in its tooltip. Pure, for Tier-1. */
export const rootNameOf = (rootLabel?: string): string => {
  if (!rootLabel) return "files";
  const windowsStyle =
    /^[A-Za-z]:[\\/]/.test(rootLabel) || rootLabel.startsWith("\\\\") || rootLabel.startsWith("~\\");
  const trimmed = windowsStyle
    ? rootLabel.replace(/[\\/]+$/, "")
    : rootLabel.replace(/\/+$/, "");
  if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) return rootLabel;
  return trimmed.split(windowsStyle ? /[\\/]/ : /\//).pop() || rootLabel;
};
