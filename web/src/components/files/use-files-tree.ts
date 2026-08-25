import { useEffect, useRef, useState } from "react";
import type { WireMsg } from "@protocol";
import type { ZoneMsg } from "../../session-bus";
import {
  applyDirReply,
  beginDirFetch,
  bellRefreshDelay,
  childDirPaths,
  emptyDirStore,
  pruneDirStore,
  type DirStore,
} from "../../files-tree";

// The Explorer's tree controller — the fetch/refresh half of FilesPanel,
// beside the pure store in files-tree.ts. Owns the per-directory
// correlation ids, the open-panel prefetch, the refresh boundary, and the
// bell coalescing; the panel keeps the frame, the file view, and the rows.
// Replies are correlated by the echoed id — one outstanding id PER
// DIRECTORY (the lazy tree legitimately has several fetches in flight); a
// reply whose id doesn't match its directory's current id is stale and is
// dropped, never rendered.

type FsDir = Extract<WireMsg, { type: "fs_dir" }>;

// The open-panel prefetch fetches the root's child dirs so their first
// expand is instant — capped under the server's token bucket (default 32/s)
// so a many-repo Projects root can't drain it and starve the expand the
// user actually clicks.
const PREFETCH_MAX_DIRS = 24;

// Minimum gap between BELL-triggered refreshes. Bells arrive already
// server-debounced per session, but each refresh here spends one fs_listdir
// per shown directory — sustained bells over a many-dir tree would drain the
// token bucket. A bell during the gap coalesces onto one trailing refresh.
const BELL_REFRESH_MIN_GAP_MS = 1_000;

export function useFilesTree({
  open,
  subscribe,
  requestListdir,
  sessionKey,
}: {
  open: boolean;
  subscribe: (l: (m: ZoneMsg) => void) => () => void;
  requestListdir: (path: string) => string;
  /** meta.sessionId — a change means a different workspace: reset + refetch. */
  sessionKey?: string;
}) {
  const [store, setStore] = useState<DirStore>(emptyDirStore());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rootOpen, setRootOpen] = useState(true);

  const dirReqIds = useRef<Map<string, string>>(new Map());
  // When true, the next root reply fans out the first-level prefetch —
  // armed by opening (and session switch), not by turn-end refreshes.
  const prefetchArmed = useRef(false);
  // The subscribe effect below runs once; these refs let its handlers read
  // current panel state without re-subscribing.
  const openRef = useRef(open);
  openRef.current = open;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const fetchDir = (path: string) => {
    dirReqIds.current.set(path, requestListdir(path));
    setStore((s) => beginDirFetch(s, path));
  };

  // The refresh boundary (open, turn-end, the button): refetch the root
  // and every expanded dir in place (previous rows stay visible while the
  // replies swap them), and DROP cached-but-collapsed dirs — their next
  // expand fetches fresh instead of serving a pre-turn listing.
  const refreshTree = (prefetch: boolean) => {
    prefetchArmed.current = prefetch;
    const keep = expandedRef.current;
    for (const path of dirReqIds.current.keys()) {
      if (path !== "" && !keep.has(path)) dirReqIds.current.delete(path);
    }
    setStore((s) => pruneDirStore(s, keep));
    fetchDir("");
    for (const path of keep) fetchDir(path);
  };
  // Ref-stable mirror for the subscribe handler (it closes over the first
  // render otherwise).
  const refreshRef = useRef(refreshTree);
  refreshRef.current = refreshTree;

  // The doorbell's client half: one pending refresh at most, run when
  // the coalescing gap allows — an immediate first ring, trailing after.
  const bellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBellRefreshAt = useRef(0);
  const onBell = () => {
    if (!openRef.current || bellTimer.current) return;
    bellTimer.current = setTimeout(
      () => {
        bellTimer.current = null;
        lastBellRefreshAt.current = Date.now();
        // Re-checked at fire time — the panel may have closed during the gap.
        if (openRef.current) refreshRef.current(false);
      },
      bellRefreshDelay(Date.now(), lastBellRefreshAt.current, BELL_REFRESH_MIN_GAP_MS),
    );
  };

  // Subscribe once; the refs above make the handlers care only about the
  // latest requests. OutputZone ignores fs_* the same way (unknown to it).
  useEffect(
    () =>
      subscribe((m) => {
        if (m.type === "fs_dir") {
          const d = m as FsDir;
          if (dirReqIds.current.get(d.path) !== d.id) return; // stale per-dir
          dirReqIds.current.delete(d.path);
          setStore((s) => applyDirReply(s, d.path, d));
          // The open-panel prefetch: the root reply just named the first
          // level — fetch its child dirs so expanding them is instant.
          if (d.path === "" && prefetchArmed.current) {
            prefetchArmed.current = false;
            if (!d.error) {
              for (const p of childDirPaths("", d.entries).slice(0, PREFETCH_MAX_DIRS)) {
                if (!dirReqIds.current.has(p)) fetchDir(p);
              }
            }
          }
        } else if (m.type === "turn_end" && openRef.current) {
          // The agent likely just touched files — refetch the root and
          // the EXPANDED dirs only (the lazy refresh unit), pruning stale
          // collapsed cache. No prefetch: collapsed first-level dirs refetch
          // on their next expand. Through the bell's coalescing gap, not a
          // direct refresh: an attach/reconnect replays EVERY historical
          // turn_end in one burst, and one refresh per replayed turn would
          // drain the server's fs token bucket for nothing.
          onBell();
        } else if (m.type === "fs_changed") {
          // Disk changed behind the UI — same refresh unit as turn-end
          // (root + expanded; a new file in a collapsed, unfetched dir
          // rightly causes no fetch), coalesced through the gap above. A
          // status-ready signal uses the same refresh without claiming a disk
          // mutation. The watcher hint isn't consulted: refetch what you show.
          onBell();
        }
      }),
    [subscribe],
  );

  // A pending bell refresh must not fire into an unmounted panel.
  useEffect(
    () => () => {
      if (bellTimer.current) clearTimeout(bellTimer.current);
      bellTimer.current = null;
    },
    [],
  );

  // A session switch means a different workspace — clear everything, expanded
  // dirs included. (Kept separate from the open effect below so expanded state
  // SURVIVES a close/reopen within one session.)
  useEffect(() => {
    // The ref mirror is cleared alongside the state: the open effect below
    // runs in the same commit and reads expandedRef — it must not refetch
    // the OLD session's expanded dirs against the new root.
    const cleared = new Set<string>();
    setExpanded(cleared);
    expandedRef.current = cleared;
    setRootOpen(true);
    setStore(emptyDirStore());
    dirReqIds.current.clear();
    prefetchArmed.current = false;
  }, [sessionKey]);

  // Opening (or a session switch while open) fetches root + expanded dirs and
  // arms the first-level prefetch, leaving expanded dirs intact across a
  // close/reopen.
  useEffect(() => {
    if (!open || !sessionKey) return;
    refreshRef.current(true);
  }, [open, sessionKey, requestListdir]);

  const toggleDir = (path: string) => {
    const opening = !expanded.has(path);
    setExpanded((s) => {
      const next = new Set(s);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
    // First expand (or expand after an error/invalidation) fetches; a cached
    // re-expand renders from the store with no request.
    if (opening) {
      const st = store.get(path);
      if ((!st || st.phase === "error") && !dirReqIds.current.has(path)) fetchDir(path);
    }
  };

  return { store, expanded, rootOpen, setRootOpen, toggleDir, refreshTree };
}
