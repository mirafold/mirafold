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
import { useEscapeKey } from "../../use-escape";
import { useFocusTrap } from "../../use-focus-trap";
import { useIsPhone } from "../../use-is-phone";
import { FileView, fileToState, diffToState, type FileViewState } from "./FileView";

// The Explorer's shell-owned panel (E.3 desktop, E.4 phone; lazy since
// E2.2): a read-only browser of the session's working tree, built
// incrementally — one fs_listdir per directory, fetched on first expand and
// cached (files-tree.ts holds the store). Opening fetches the root and
// prefetches its first level; the whole-tree fs_list is retired from the
// client (the server keeps answering it for older bundles). Interaction is
// drill-in on both platforms — the tree, then a file view laid OVER it with
// a back button — so a narrow surface never shows tree and file at once, the
// tree stays mounted underneath (its scroll survives a round trip), and the
// two platforms differ only in the frame: desktop = a docked LEFT column
// beside the transcript; phone (≤640px) = a full-screen dialog
// (focus-trapped, Esc = back one layer / close from the tree).
//
// SHELL-OWNED: it holds the bus (socket) and the agent paints nothing here.
// Replies are correlated by the echoed id — one outstanding id PER DIRECTORY
// (dirReqIds) plus one for the file view; a stale reply (superseded click,
// since-switched session) is dropped, never rendered.

type FsDir = Extract<WireMsg, { type: "fs_dir" }>;

/** Accept a reply only when it answers the request we're currently awaiting —
 *  a superseded click or a since-switched session mints a new id, so its late
 *  reply is dropped, never rendered (E.3). Pure, for Tier-1. */
export const isCurrentReply = (awaited: string | null, replyId: string): boolean =>
  awaited !== null && awaited === replyId;

/** The root row shows just the checked-out folder's NAME; the full ~-path
 *  stays in its tooltip. Pure, for Tier-1. */
export const rootNameOf = (rootLabel?: string): string =>
  rootLabel?.replace(/\/+$/, "").split("/").pop() || rootLabel || "files";

// The open-panel prefetch fetches the root's child dirs so their first
// expand is instant — capped under the server's token bucket (default 32/s)
// so a many-repo Projects root can't drain it and starve the expand the
// user actually clicks.
const PREFETCH_MAX_DIRS = 24;

// Minimum gap between BELL-triggered refreshes (W.2). Bells arrive already
// server-debounced per session, but each refresh here spends one fs_listdir
// per shown directory — sustained bells over a many-dir tree would drain the
// token bucket. A bell during the gap coalesces onto one trailing refresh.
const BELL_REFRESH_MIN_GAP_MS = 1_000;

export function FilesPanel({
  open,
  subscribe,
  requestListdir,
  requestRead,
  requestDiff,
  onClose,
  rootLabel,
  sessionKey,
}: {
  open: boolean;
  subscribe: (l: (m: ZoneMsg) => void) => () => void;
  requestListdir: (path: string) => string;
  requestRead: (path: string) => string;
  requestDiff: (path: string) => string;
  onClose: () => void;
  /** ~-abbreviated session root — its basename names the tree's root row,
   *  the full path lives in that row's tooltip. */
  rootLabel?: string;
  /** meta.sessionId — a change means a different workspace: reset + refetch. */
  sessionKey?: string;
}) {
  const [store, setStore] = useState<DirStore>(emptyDirStore());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rootOpen, setRootOpen] = useState(true);
  const [selected, setSelected] = useState<{ path: string; status?: string } | null>(null);
  const [mode, setMode] = useState<"content" | "diff">("content");
  const [view, setView] = useState<FileViewState>({ kind: "empty" });

  // Correlation ids: one outstanding fs_listdir PER DIRECTORY (the E.3-era
  // single listId ref is gone — the lazy tree legitimately has several
  // fetches in flight), one for the file view. A reply whose id doesn't
  // match its directory's current id is stale and is ignored.
  const dirReqIds = useRef<Map<string, string>>(new Map());
  const fileId = useRef<string | null>(null);
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

  // The refresh boundary (open, E.5 turn-end, the button): refetch the root
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

  // The doorbell's client half (W.2): one pending refresh at most, run when
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

  // Phone = a full-screen dialog; desktop = a docked column. Live (not the
  // module-load constant) so a resize across the breakpoint re-frames it.
  const phone = useIsPhone();
  const panelRef = useRef<HTMLDivElement>(null);
  // Trap focus only while it's an OPEN modal dialog (phone). Gating on `open`
  // matters: this component is always mounted (it returns null when closed),
  // so without `open` in the active flag the trap's effect would run once at
  // mount — closed, a no-op — and never re-fire when the panel actually opens.
  // On desktop the panel is a docked column beside a usable transcript — no trap.
  const modal = phone && open;
  useFocusTrap(panelRef, modal);
  // Esc on phone drills back one layer, then closes from the tree — the
  // stacked-layer contract, and it owns the key while open (exclusive: a
  // drill-back must not also reach Shell's busy interrupt). Desktop leaves
  // Esc to Shell (busy = interrupt).
  useEscapeKey(modal ? (selected ? () => setSelected(null) : onClose) : undefined, {
    exclusive: true,
  });

  // Subscribe once; the refs above make the handlers care only about the
  // latest requests. RenderZone ignores fs_* the same way (unknown to it).
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
        } else if (m.type === "fs_file") {
          if (!isCurrentReply(fileId.current, m.id)) return;
          setView(fileToState(m));
        } else if (m.type === "fs_file_diff") {
          if (!isCurrentReply(fileId.current, m.id)) return;
          setView(diffToState(m));
        } else if (m.type === "turn_end" && openRef.current) {
          // E.5: the agent likely just touched files — refetch the root and
          // the EXPANDED dirs only (the lazy refresh unit), pruning stale
          // collapsed cache. No prefetch: collapsed first-level dirs refetch
          // on their next expand. The server throttle bounds the burst.
          refreshRef.current(false);
        } else if (m.type === "fs_changed") {
          // W.2: disk changed behind the UI — same refresh unit as turn-end
          // (root + expanded; a new file in a collapsed, unfetched dir
          // rightly causes no fetch), coalesced through the gap above. The
          // hint isn't consulted: doorbell contract, refetch what you show.
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
  // SURVIVES a close/reopen within one session — E.5.)
  useEffect(() => {
    setSelected(null);
    setView({ kind: "empty" });
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
  // arms the first-level prefetch. Returns to the tree view, but leaves
  // expanded dirs intact across a close/reopen.
  useEffect(() => {
    if (!open || !sessionKey) return;
    setSelected(null);
    setView({ kind: "empty" });
    refreshRef.current(true);
  }, [open, sessionKey, requestListdir]);

  if (!open) return null;

  const refresh = () => {
    refreshTree(true);
    if (selected) openFile(selected.path, selected.status, mode);
  };

  const openFile = (path: string, status: string | undefined, m: "content" | "diff") => {
    setSelected({ path, status });
    setMode(m);
    setView({ kind: "loading", path });
    fileId.current = m === "diff" ? requestDiff(path) : requestRead(path);
  };

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
      if ((!st || st.error) && !dirReqIds.current.has(path)) fetchDir(path);
    }
  };

  const rootState = store.get("");

  return (
    <aside
      className="files-panel"
      aria-label="Files"
      ref={panelRef}
      // Phone frames it as a modal dialog; desktop is a plain docked column.
      role={phone ? "dialog" : undefined}
      aria-modal={phone ? true : undefined}
      tabIndex={phone ? -1 : undefined}
    >
      {/* The tree stays mounted; the file view (when a file is open) is laid
          over it, so back reveals the tree at its prior scroll (E.4). */}
      <div className="files-main">
        <div className="files-tree">
          {/* The session's checked-out root leads the tree as its top node
              (VS Code convention) — no path header; the full ~-path lives in
              the row's tooltip. The panel's actions ride the same row. ARIA:
              it's a disclosure button OVER the tree widget, not a treeitem
              inside it — role=tree owns only treeitems/groups (axe, C.2). */}
          <div className="files-root">
            <button
              className="files-row files-dir files-root-row"
              onClick={() => setRootOpen((o) => !o)}
              title={rootLabel}
              aria-expanded={rootOpen}
            >
              <span className="files-caret">{rootOpen ? "▾" : "▸"}</span>
              <span className="files-name">{rootNameOf(rootLabel)}</span>
            </button>
            {/* Desktop closes from the activity-bar toggle; the phone dialog
                still needs its own close. */}
            {phone && (
              <button className="files-btn" onClick={onClose} title="Close files" aria-label="Close files">
                ✕
              </button>
            )}
          </div>
          {rootOpen &&
            (rootState?.error && !rootState.entries ? (
              <div className="files-empty files-error">{rootState.error}</div>
            ) : rootState?.entries && rootState.entries.length === 0 ? (
              <div className="files-empty">(no files)</div>
            ) : rootState?.entries ? (
              <div role="tree" aria-label="Working tree">
                <DirChildren
                  path=""
                  depth={1}
                  store={store}
                  expanded={expanded}
                  onToggleDir={toggleDir}
                  onOpenFile={(path, status) =>
                    // A changed file leads with its diff — that's what you want
                    // to see; an unchanged file has only content.
                    openFile(path, status, status ? "diff" : "content")
                  }
                />
              </div>
            ) : (
              <div className="files-empty">…</div>
            ))}
        </div>

        {/* Pinned to the panel's bottom-left corner, floating over the tree;
            the file-view overlay (z-index above) covers it, same as the tree. */}
        <button
          className="files-btn files-refresh"
          onClick={refresh}
          title="Refresh"
          aria-label="Refresh files"
        >
          ⟳
        </button>

        {selected && (
          <div className="files-file">
            <div className="files-file-path">
              <button
                className="files-back"
                onClick={() => setSelected(null)}
                title="Back to files"
                aria-label="Back to files"
              >
                ‹
              </button>
              <span className="files-file-name" title={selected.path}>
                {selected.path}
              </span>
              {selected.status && (
                <span className="files-file-tabs">
                  <button
                    className={"files-tab" + (mode === "content" ? " is-active" : "")}
                    onClick={() => openFile(selected.path, selected.status, "content")}
                  >
                    file
                  </button>
                  <button
                    className={"files-tab" + (mode === "diff" ? " is-active" : "")}
                    onClick={() => openFile(selected.path, selected.status, "diff")}
                  >
                    diff
                  </button>
                </span>
              )}
            </div>
            <div className="files-view">
              <FileView state={view} />
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

// One directory's children, rendered from the store — recursion IS the tree
// (E2.2): an expanded child dir renders its own DirChildren, which shows a
// loading row until its fs_dir lands, then its listing. The wire stays
// non-recursive; nesting exists only here.
function DirChildren({
  path,
  depth,
  store,
  expanded,
  onToggleDir,
  onOpenFile,
}: {
  path: string;
  depth: number;
  store: DirStore;
  expanded: Set<string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string, status?: string) => void;
}) {
  const st = store.get(path);
  const pad = { paddingLeft: `${depth * 12 + 6}px` };
  if (!st?.entries) {
    // Nothing usable yet: an inline loading row while the fetch flies, an
    // error row if it refused. Non-interactive rows are aria-disabled
    // treeitems — still part of the tree for the reading order.
    if (!st) return null;
    return (
      <ul className="files-ul" role="group">
        <li role="treeitem" aria-disabled="true" className="files-note-row" style={pad}>
          {st.loading ? "…" : (st.error ?? "…")}
        </li>
      </ul>
    );
  }
  return (
    <ul className="files-ul" role="group">
      {st.entries.length === 0 && (
        <li role="treeitem" aria-disabled="true" className="files-note-row" style={pad}>
          (empty)
        </li>
      )}
      {st.entries.map((e) => {
        const p = path ? `${path}/${e.name}` : e.name;
        if (e.kind === "dir") {
          const isOpen = expanded.has(p);
          return (
            <li key={e.name} role="treeitem" aria-expanded={isOpen}>
              <button className="files-row files-dir" style={pad} onClick={() => onToggleDir(p)}>
                <span className="files-caret">{isOpen ? "▾" : "▸"}</span>
                <span className="files-name">{e.name}</span>
              </button>
              {isOpen && (
                <DirChildren
                  path={p}
                  depth={depth + 1}
                  store={store}
                  expanded={expanded}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                />
              )}
            </li>
          );
        }
        // Files and symlinks are both leaves (E2.1's kind rule); a symlink
        // click goes through fs_read like any file — the daemon's jail
        // decides whether its target is readable.
        return (
          <li key={e.name} role="treeitem">
            <button
              className="files-row files-file-row"
              style={pad}
              onClick={() => onOpenFile(p, e.status)}
            >
              <span className="files-caret" />
              <span className="files-name">{e.name}</span>
              {e.status && (
                <span className={`files-status files-status-${e.status}`} title={statusLabel(e.status)}>
                  {e.status}
                </span>
              )}
            </button>
          </li>
        );
      })}
      {st.truncated && (
        <li role="treeitem" aria-disabled="true" className="files-note-row" style={pad}>
          …more entries than can be listed
        </li>
      )}
    </ul>
  );
}

const statusLabel = (s: string) =>
  ({ M: "modified", A: "added", D: "deleted", U: "untracked" })[s] ?? s;
