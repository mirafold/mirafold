import { useEffect, useRef, useState } from "react";
import type { FsEntry, WireMsg } from "@protocol";
import type { ZoneMsg } from "../../session-bus";
import { buildFileTree, type FileNode } from "../../files-tree";
import { FileView, type FileViewState } from "./FileView";

// The Explorer's shell-owned panel (E.3): a read-only browser of the
// session's working tree. Desktop mounts it as a collapsible LEFT column
// beside the transcript; the phone container (E.4) reuses this same component
// full-screen. Interaction is drill-in on both — tree, then a file view with
// a back button — so a narrow column never has to show tree and file at once,
// and the two platforms differ only in their frame.
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
  /** ~-abbreviated session root, for the header. */
  rootLabel?: string;
  /** meta.sessionId — a change means a different workspace: reset + refetch. */
  sessionKey?: string;
}) {
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [git, setGit] = useState(false);
  const [truncated, setTruncated] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<{ path: string; status?: string } | null>(null);
  const [mode, setMode] = useState<"content" | "diff">("content");
  const [view, setView] = useState<FileViewState>({ kind: "empty" });

  // The reply this panel is currently waiting on, per surface. A reply whose
  // id doesn't match is stale (a superseded click, a since-switched session)
  // and is ignored.
  const listId = useRef<string | null>(null);
  const fileId = useRef<string | null>(null);

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
        }
      }),
    [subscribe],
  );

  // Open (or switch sessions while open) → refetch the tree from scratch.
  useEffect(() => {
    if (!open || !sessionKey) return;
    setSelected(null);
    setView({ kind: "empty" });
    setExpanded(new Set());
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
    <aside className="files-panel" aria-label="Files">
      <div className="files-head">
        {selected ? (
          <button className="files-back" onClick={() => setSelected(null)} title="Back to files">
            ‹ files
          </button>
        ) : (
          <span className="files-title" title={rootLabel}>
            {rootLabel ?? "Files"}
          </span>
        )}
        <span className="files-head-spacer" />
        <button className="files-btn" onClick={refresh} title="Refresh" aria-label="Refresh files">
          ⟳
        </button>
        <button className="files-btn" onClick={onClose} title="Hide files" aria-label="Hide files">
          ✕
        </button>
      </div>

      {selected ? (
        <div className="files-file">
          <div className="files-file-path">
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
      ) : (
        <div className="files-tree" role="tree" aria-label="Working tree">
          {treeError ? (
            <div className="files-empty files-error">{treeError}</div>
          ) : entries.length === 0 ? (
            <div className="files-empty">(no files)</div>
          ) : (
            <>
              <TreeNodes
                nodes={tree}
                depth={0}
                git={git}
                expanded={expanded}
                onToggleDir={toggleDir}
                onOpenFile={(node) =>
                  // A changed file leads with its diff — that's what you want
                  // to see; an unchanged file has only content.
                  openFile(node.path, node.status, git && node.status ? "diff" : "content")
                }
              />
              {truncated && (
                <div className="files-empty files-truncated">
                  …tree truncated (too many files to list all)
                </div>
              )}
            </>
          )}
        </div>
      )}
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
