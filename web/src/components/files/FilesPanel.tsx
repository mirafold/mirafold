import { useEffect, useRef, useState } from "react";
import { useWorkspacePanelFrame } from "../../use-workspace-panel-frame";
import type { ZoneMsg } from "../../session-bus";
import { rootNameOf, shownListing } from "../../files-tree";
import { useEscapeKey } from "../../use-escape";
import { useFocusTrap } from "../../use-focus-trap";
import { useIsPhone } from "../../use-is-phone";
import { FileView } from "./FileView";
import { ExplorerChevron, ExplorerNodeGlyph } from "./ExplorerNodeGlyph";
import { DirChildren } from "./FilesTreeRows";
import { RefreshIcon } from "../RefreshIcon";
import { WorkspaceTabs, type WorkspaceSurface } from "../WorkspaceTabs";
import { useFileView } from "./use-file-view";
import { useFilesTree } from "./use-files-tree";

// The Explorer's shell-owned panel: a read-only browser of the session's
// working tree, built
// incrementally — one fs_listdir per directory, fetched on first expand and
// cached (files-tree.ts holds the store). Opening fetches the root and
// prefetches its first level; the client never sends the whole-tree
// fs_list (the server keeps answering it for older bundles). Interaction is
// drill-in on both platforms — the tree, then a file view laid OVER it with
// a back button — so a narrow surface never shows tree and file at once, the
// tree stays mounted underneath (its scroll survives a round trip), and the
// two platforms differ only in the frame: desktop = a docked LEFT column
// beside the transcript; phone (≤640px) = a full-screen dialog
// (focus-trapped, Esc = back one layer / close from the tree).
//
// SHELL-OWNED: it holds the bus (socket) and the agent paints nothing here.
// Replies are correlated by the echoed id (use-files-tree.ts for the
// directories, use-file-view.ts for the file); a stale reply (superseded
// click, since-switched session) is dropped, never rendered.

export function FilesPanel({
  open,
  subscribe,
  requestListdir,
  requestRead,
  requestDiff,
  onClose,
  onSwitch,
  rootLabel,
  sessionKey,
}: {
  open: boolean;
  subscribe: (l: (m: ZoneMsg) => void) => () => void;
  requestListdir: (path: string) => string;
  requestRead: (path: string) => string;
  requestDiff: (path: string) => string;
  onClose: () => void;
  /** Phone drawer view switch (Files ⇄ Changes); rendered in the head on
   *  ≤640px only — desktop's rail owns the choice there. */
  onSwitch?: (surface: WorkspaceSurface) => void;
  /** ~-abbreviated session root — its basename names the tree's root row,
   *  the full path lives in that row's tooltip. */
  rootLabel?: string;
  /** meta.sessionId — a change means a different workspace: reset + refetch. */
  sessionKey?: string;
}) {
  const { store, expanded, rootOpen, setRootOpen, toggleDir, refreshTree } = useFilesTree({
    open,
    subscribe,
    requestListdir,
    sessionKey,
  });
  const file = useFileView({ subscribe, requestRead, requestDiff, scopeKey: sessionKey });
  const { selected, mode, view, openFile } = file;
  // The deliberate desktop enlarge — the file box lifted out of the
  // narrow column into a near-full-screen lightbox over the dimmed
  // workspace. User-initiated only (the ⤢ button); every path that closes
  // the file view drops it too.
  const [maximized, setMaximized] = useState(false);

  // Closing the file view ALWAYS drops the enlarge with it — the invariant
  // behind every close path (back button, phone Esc drill-back, session
  // switch, panel open). Setters only, so any render's copy is current.
  const closeFile = () => {
    file.close();
    setMaximized(false);
  };

  const resetFile = () => {
    file.reset();
    setMaximized(false);
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
  // Esc on phone drills back one layer, then closes from the tree — the
  // stacked-layer contract. closeFile, not bare setSelected: a drill-back is
  // a close path, and leaving `maximized` armed here would let a
  // desktop→phone→desktop resize dance re-enlarge the NEXT opened file.
  const frame = useWorkspacePanelFrame({
    panelRef,
    phone,
    open,
    onEscape: selected ? closeFile : onClose,
  });
  // The enlarged frame exists only while a file is open on DESKTOP — phone is
  // already full-screen, so a breakpoint crossing mid-enlarge just re-frames
  // to the phone dialog with no extra state. While enlarged it is a modal
  // layer like the phone dialog: focus-trapped, and Esc restores it
  // exclusively (a restore must not also reach Shell's busy interrupt).
  const maxi = maximized && !phone && selected !== null;
  const fileRef = useRef<HTMLDivElement>(null);
  useFocusTrap(fileRef, maxi);
  useEscapeKey(maxi ? () => setMaximized(false) : undefined, { exclusive: true });

  // A session switch drops the enlarge with everything else (the tree's own
  // reset lives in useFilesTree).
  useEffect(() => setMaximized(false), [sessionKey]);

  // Opening (or a session switch while open) returns to the tree view.
  useEffect(() => {
    if (open && sessionKey) resetFile();
  }, [open, sessionKey]);

  if (!open) return null;

  const refresh = () => {
    refreshTree(true);
    if (selected) openFile(selected.path, selected.status, mode);
  };

  const rootState = store.get("");
  const rootListing = rootState && shownListing(rootState);
  const rootName = rootNameOf(rootLabel);

  return (
    <aside className="files-panel" aria-label="Files" ref={panelRef} {...frame}>
      {/* The tree stays mounted; the file view (when a file is open) is laid
          over it, so back reveals the tree at its prior scroll. */}
      <div className="files-main">
        <div className="files-tree">
          {/* Phone head: back chevron LEADING (top-left, thumb-reachable —
              the same exit Changes has; a top-right × would be the odd one
              out), then the drawer's Files/Changes switch in the
              title's place. Desktop keeps the plain title, no close. */}
          <header className="files-panel-head">
            {phone && (
              <button
                className="files-panel-action files-panel-back"
                onClick={onClose}
                title="Back to conversation"
                aria-label="Back to conversation"
              >
                ‹
              </button>
            )}
            {phone && onSwitch ? (
              <WorkspaceTabs active="files" onSwitch={onSwitch} />
            ) : (
              <h2 className="files-panel-title">Files</h2>
            )}
            <div className="files-panel-actions">
              <button
                className="files-panel-action files-refresh"
                onClick={refresh}
                title="Refresh"
                aria-label="Refresh files"
              >
                <RefreshIcon className="files-action-icon" />
              </button>
            </div>
          </header>
          {/* The session's checked-out root leads the tree as its top node
              (VS Code convention) — the title bar above is panel chrome, not
              a duplicate path header; the full ~-path lives in this row's
              tooltip. ARIA:
              it's a disclosure button OVER the tree widget, not a treeitem
              inside it — role=tree owns only treeitems/groups (axe). */}
          <div className="files-root">
            <button
              className="files-row files-dir files-root-row"
              onClick={() => setRootOpen((o) => !o)}
              title={rootLabel}
              aria-expanded={rootOpen}
            >
              <span className="files-caret">
                <ExplorerChevron open={rootOpen} />
              </span>
              <ExplorerNodeGlyph name={rootName} entryKind="dir" open={rootOpen} />
              <span className="files-name">{rootName}</span>
            </button>
          </div>
          {rootOpen &&
            (rootState?.phase === "error" && !rootListing ? (
              <div className="files-empty files-error">{rootState.error}</div>
            ) : rootListing && rootListing.entries.length === 0 ? (
              <div className="files-empty">(no files)</div>
            ) : rootListing ? (
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

        {selected && (
          <>
            {/* The lightbox backdrop: the whole workspace dimmed but visible
                behind the lifted box — clicking it is the universal "put it
                back". Below the box, above everything the box floats over. */}
            {maxi && (
              <div className="files-dim" onClick={() => setMaximized(false)} aria-hidden="true" />
            )}
            {/* One node in BOTH frames — enlarging toggles a class, never
                remounts, so the view's scroll position survives the round
                trip in each direction. */}
            <div
              className={"files-file" + (maxi ? " is-maximized" : "")}
              ref={fileRef}
              role={maxi ? "dialog" : undefined}
              aria-modal={maxi ? true : undefined}
              tabIndex={maxi ? -1 : undefined}
            >
              <div className="files-file-path">
                <button
                  className="files-back"
                  onClick={closeFile}
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
              {/* tabIndex + a named region because this div SCROLLS
                  (02-explorer.css `.files-view { overflow: auto }`): without a tab
                  stop, a keyboard-only user could open a file or a diff and
                  never scroll it — axe `scrollable-region-focusable`, serious.
                  A focusable region needs an accessible name, hence
                  role + label. Costs one tab stop in the Explorer, which is
                  the point: the content is reachable. */}
              <div
                className="files-view"
                tabIndex={0}
                role="region"
                aria-label={`${selected.path} — ${mode === "diff" ? "diff" : "contents"}`}
              >
                <FileView state={view} />
              </div>
              {/* Desktop-only (the phone frame is already full-screen): floats
                  in the box's bottom-right corner — the refresh idiom, other
                  corner — and stays under the pointer across a toggle. */}
              {!phone && (
                <button
                  className="files-btn files-enlarge"
                  onClick={() => setMaximized((m) => !m)}
                  title={maxi ? "Restore size" : "Enlarge"}
                  aria-label={maxi ? "Restore file view size" : "Enlarge file view"}
                >
                  {maxi ? "⤡" : "⤢"}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}



