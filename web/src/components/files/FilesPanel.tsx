import { useEffect, useRef, useState } from "react";
import type { FsEntry, WireMsg } from "@protocol";
import type { ZoneMsg } from "../../session-bus";
import { buildFileTree, type FileNode } from "../../files-tree";
import { useEscapeKey } from "../../use-escape";
import { useFocusTrap } from "../../use-focus-trap";
import { useIsPhone } from "../../use-is-phone";
import { FileView, type FileViewState } from "./FileView";

// The Explorer's shell-owned panel (E.3 desktop, E.4 phone): a read-only
// browser of the session's working tree. Interaction is drill-in on both
// platforms — the tree, then a file view laid OVER it with a back button —
// so a narrow surface never shows tree and file at once, the tree stays
// mounted underneath (its scroll survives a round trip), and the two
// platforms differ only in the frame: desktop = a docked LEFT column beside
// the transcript; phone (≤640px) = a full-screen dialog (focus-trapped, Esc
// = back one layer / close from the tree — the A.3 discipline the other
// overlays use).
//
// SHELL-OWNED: it holds the bus (socket) and the agent paints nothing here.
// Replies are correlated by the echoed id (a stale reply from a superseded
// click or a since-switched session is dropped, never rendered).

type FsTree = Extract<WireMsg, { type: "fs_tree" }>;
type FsFile = Extract<WireMsg, { type: "fs_file" }>;
type FsFileDiff = Extract<WireMsg, { type: "fs_file_diff" }>;

/** Accept a reply only when it answers the request we're currently awaiting —
 *  a superseded click or a since-switched session mints a new id, so its late
 *  reply is dropped, never rendered (E.3). Pure, for Tier-1. */
export const isCurrentReply = (awaited: string | null, replyId: string): boolean =>
  awaited !== null && awaited === replyId;

/** The root row shows just the checked-out folder's NAME; the full ~-path
 *  stays in its tooltip. Pure, for Tier-1. */
export const rootNameOf = (rootLabel?: string): string =>
  rootLabel?.replace(/\/+$/, "").split("/").pop() || rootLabel || "files";

export function FilesPanel({
  open,
  subscribe,
  requestList,
  requestRead,
  requestDiff,
  onClose,
  rootLabel,
  sessionKey,
}: {
  open: boolean;
  subscribe: (l: (m: ZoneMsg) => void) => () => void;
  requestList: () => string;
  requestRead: (path: string) => string;
  requestDiff: (path: string) => string;
  onClose: () => void;
  /** ~-abbreviated session root — its basename names the tree's root row,
   *  the full path lives in that row's tooltip. */
  rootLabel?: string;
  /** meta.sessionId — a change means a different workspace: reset + refetch. */
  sessionKey?: string;
}) {
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [git, setGit] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [rootOpen, setRootOpen] = useState(true);
  const [selected, setSelected] = useState<{ path: string; status?: string } | null>(null);
  const [mode, setMode] = useState<"content" | "diff">("content");
  const [view, setView] = useState<FileViewState>({ kind: "empty" });

  // The reply this panel is currently waiting on, per surface. A reply whose
  // id doesn't match is stale (a superseded click, a since-switched session)
  // and is ignored.
  const listId = useRef<string | null>(null);
  const fileId = useRef<string | null>(null);
  // The subscribe effect below runs once; this ref lets its turn_end handler
  // (E.5 auto-refresh) read whether the panel is open without re-subscribing.
  const openRef = useRef(open);
  openRef.current = open;

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
  // stacked-layer contract. Desktop leaves Esc to Shell (busy = interrupt).
  useEscapeKey(modal ? (selected ? () => setSelected(null) : onClose) : undefined);

  // Subscribe once; the refs above make the handler care only about the
  // latest request. RenderZone ignores fs_* the same way (unknown to it).
  useEffect(
    () =>
      subscribe((m) => {
        if (m.type === "fs_tree") {
          const t = m as FsTree;
          if (!isCurrentReply(listId.current, t.id)) return;
          if (t.error) {
            setTreeError(t.error);
            setEntries([]);
          } else {
            setTreeError(null);
            setEntries(t.entries);
            setGit(t.git);
            setTruncated(Boolean(t.truncated));
          }
        } else if (m.type === "fs_file") {
          const f = m as FsFile;
          if (!isCurrentReply(fileId.current, f.id)) return;
          setView(fileToState(f));
        } else if (m.type === "fs_file_diff") {
          const f = m as FsFileDiff;
          if (!isCurrentReply(fileId.current, f.id)) return;
          setView(diffToState(f));
        } else if (m.type === "turn_end" && openRef.current) {
          // E.5: the agent likely just touched files — refresh the TREE so
          // statuses and new/deleted entries reflect reality. Tree only (no
          // scroll-jank on an open file view); the server throttle bounds it.
          listId.current = requestList();
        }
      }),
    [subscribe, requestList],
  );

  // A session switch means a different workspace — clear everything, expanded
  // dirs included. (Kept separate from the open effect below so expanded state
  // SURVIVES a close/reopen within one session — E.5.)
  useEffect(() => {
    setSelected(null);
    setView({ kind: "empty" });
    setExpanded(new Set());
    setRootOpen(true);
  }, [sessionKey]);

  // Opening (or a session switch while open) fetches the tree. Returns to the
  // tree view, but leaves expanded dirs intact across a close/reopen.
  useEffect(() => {
    if (!open || !sessionKey) return;
    setSelected(null);
    setView({ kind: "empty" });
    listId.current = requestList();
  }, [open, sessionKey, requestList]);

  if (!open) return null;

  const refresh = () => {
    listId.current = requestList();
    if (selected) openFile(selected.path, selected.status, mode);
  };

  const openFile = (path: string, status: string | undefined, m: "content" | "diff") => {
    setSelected({ path, status });
    setMode(m);
    setView({ kind: "loading", path });
    fileId.current = m === "diff" ? requestDiff(path) : requestRead(path);
  };

  const toggleDir = (path: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const tree = buildFileTree(entries);

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
            <button className="files-btn" onClick={refresh} title="Refresh" aria-label="Refresh files">
              ⟳
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
            (treeError ? (
              <div className="files-empty files-error">{treeError}</div>
            ) : entries.length === 0 ? (
              <div className="files-empty">(no files)</div>
            ) : (
              <>
                <div role="tree" aria-label="Working tree">
                  <TreeNodes
                    nodes={tree}
                    depth={1}
                    git={git}
                    expanded={expanded}
                    onToggleDir={toggleDir}
                    onOpenFile={(node) =>
                      // A changed file leads with its diff — that's what you want
                      // to see; an unchanged file has only content.
                      openFile(node.path, node.status, git && node.status ? "diff" : "content")
                    }
                  />
                </div>
                {truncated && (
                  <div className="files-empty files-truncated">
                    …tree truncated (too many files to list all)
                  </div>
                )}
              </>
            ))}
        </div>

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
              {git && selected.status && (
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

function TreeNodes({
  nodes,
  depth,
  git,
  expanded,
  onToggleDir,
  onOpenFile,
}: {
  nodes: FileNode[];
  depth: number;
  git: boolean;
  expanded: Set<string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (node: FileNode) => void;
}) {
  return (
    <ul className="files-ul" role="group">
      {nodes.map((n) => {
        const isOpen = expanded.has(n.path);
        const pad = { paddingLeft: `${depth * 12 + 6}px` };
        return (
          <li key={n.path} role="treeitem" aria-expanded={n.isDir ? isOpen : undefined}>
            {n.isDir ? (
              <button className="files-row files-dir" style={pad} onClick={() => onToggleDir(n.path)}>
                <span className="files-caret">{isOpen ? "▾" : "▸"}</span>
                <span className="files-name">{n.name}</span>
              </button>
            ) : (
              <button className="files-row files-file-row" style={pad} onClick={() => onOpenFile(n)}>
                <span className="files-caret" />
                <span className="files-name">{n.name}</span>
                {git && n.status && (
                  <span className={`files-status files-status-${n.status}`} title={statusLabel(n.status)}>
                    {n.status}
                  </span>
                )}
              </button>
            )}
            {n.isDir && isOpen && n.children.length > 0 && (
              <TreeNodes
                nodes={n.children}
                depth={depth + 1}
                git={git}
                expanded={expanded}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

const statusLabel = (s: string) =>
  ({ M: "modified", A: "added", D: "deleted", U: "untracked" })[s] ?? s;

function fileToState(f: FsFile): FileViewState {
  if (f.error) return { kind: "error", path: f.path, message: f.error };
  if (f.binary) return { kind: "binary", path: f.path, size: f.size };
  return {
    kind: "content",
    path: f.path,
    content: f.content ?? "",
    truncatedBytes: f.truncatedBytes,
  };
}

function diffToState(f: FsFileDiff): FileViewState {
  if (f.error) return { kind: "error", path: f.path, message: f.error };
  if (f.binary) return { kind: "binary", path: f.path };
  return {
    kind: "diff",
    path: f.path,
    before: f.before ?? "",
    after: f.after ?? "",
    beforeTruncatedBytes: f.beforeTruncatedBytes,
    afterTruncatedBytes: f.afterTruncatedBytes,
  };
}
