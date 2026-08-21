import type { DirStore } from "../../files-tree";
import { changeStatus } from "../../changes";
import { ExplorerChevron, ExplorerNodeGlyph } from "./ExplorerNodeGlyph";

// The Explorer tree's ROWS — the pure recursive renderer split out of
// FilesPanel (which keeps the panel: frame, bus wiring, refresh policy).
// Everything here derives from props; no bus, no effects.

/** Quiet vertical hierarchy guides, like the optional guides in established
 * IDE project trees. The width keeps the established 12px-per-depth rhythm;
 * the lazy tree's data and interaction model do not know about them. */
function ExplorerIndent({ depth }: { depth: number }) {
  return (
    <span
      className="files-indent-guides"
      style={{ width: `${depth * 12}px` }}
      aria-hidden="true"
    />
  );
}

// The tooltip's lowercase view over the shared status vocabulary; an
// unknown status char shows itself rather than a guessed word.
const statusLabel = (s: string) => {
  const { code, label } = changeStatus(s);
  return code === "?" ? s : label.toLowerCase();
};

// One directory's children, rendered from the store — recursion IS the tree
// (E2.2): an expanded child dir renders its own DirChildren, which shows a
// loading row until its fs_dir lands, then its listing. The wire stays
// non-recursive; nesting exists only here.
export function DirChildren({
  path,
  depth,
  store,
  expanded,
  onToggleDir,
  onOpenFile,
  onOpenFullView,
}: {
  path: string;
  depth: number;
  store: DirStore;
  expanded: Set<string>;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string, status: string | undefined, opener: HTMLButtonElement) => void;
  /** Desktop-only escape hatch for the established Explorer drill-in and
   * its enlarged lightbox. Absent on phone, where the row itself drills in. */
  onOpenFullView?: (path: string, status?: string) => void;
}) {
  const dirState = store.get(path);
  const pad = { paddingLeft: `${depth * 12 + 6}px` };
  if (!dirState?.entries) {
    // Nothing usable yet: an inline loading row while the fetch flies, an
    // error row if it refused. Non-interactive rows are aria-disabled
    // treeitems — still part of the tree for the reading order.
    if (!dirState) return null;
    return (
      <ul className="files-ul" role="group">
        <li role="treeitem" aria-disabled="true" className="files-note-row" style={pad}>
          {dirState.loading ? "…" : (dirState.error ?? "…")}
        </li>
      </ul>
    );
  }
  return (
    <ul className="files-ul" role="group">
      {dirState.entries.length === 0 && (
        <li role="treeitem" aria-disabled="true" className="files-note-row" style={pad}>
          (empty)
        </li>
      )}
      {dirState.entries.map((entry) => {
        const entryPath = path ? `${path}/${entry.name}` : entry.name;
        if (entry.kind === "dir") {
          const isOpen = expanded.has(entryPath);
          return (
            <li key={entry.name} role="treeitem" aria-expanded={isOpen}>
              <button className="files-row files-dir" onClick={() => onToggleDir(entryPath)}>
                <ExplorerIndent depth={depth} />
                <span className="files-caret">
                  <ExplorerChevron open={isOpen} />
                </span>
                <ExplorerNodeGlyph name={entry.name} entryKind="dir" open={isOpen} />
                <span className="files-name">{entry.name}</span>
              </button>
              {isOpen && (
                <DirChildren
                  path={entryPath}
                  depth={depth + 1}
                  store={store}
                  expanded={expanded}
                  onToggleDir={onToggleDir}
                  onOpenFile={onOpenFile}
                  onOpenFullView={onOpenFullView}
                />
              )}
            </li>
          );
        }
        // Files and symlinks are both leaves (E2.1's kind rule); a symlink
        // click goes through fs_read like any file — the daemon's jail
        // decides whether its target is readable.
        return (
          <li key={entry.name} role="treeitem" className="files-leaf-row">
            <button
              className="files-row files-file-row"
              aria-label={onOpenFullView ? `Open ${entryPath} in pane` : undefined}
              title={onOpenFullView ? "Open in pane" : undefined}
              onClick={(event) => onOpenFile(entryPath, entry.status, event.currentTarget)}
            >
              <ExplorerIndent depth={depth} />
              <span className="files-caret" />
              <ExplorerNodeGlyph name={entry.name} entryKind={entry.kind} />
              <span className="files-name">{entry.name}</span>
              {entry.status && (
                <span
                  className={`files-status files-status-${entry.status}`}
                  title={statusLabel(entry.status)}
                >
                  {entry.status}
                </span>
              )}
            </button>
            {onOpenFullView && (
              <button
                type="button"
                className="files-full-view"
                title="Open full view"
                aria-label={`Open ${entryPath} in full view`}
                onClick={() => onOpenFullView(entryPath, entry.status)}
              >
                ⤢
              </button>
            )}
          </li>
        );
      })}
      {dirState.truncated && (
        <li role="treeitem" aria-disabled="true" className="files-note-row" style={pad}>
          …more entries than can be listed
        </li>
      )}
    </ul>
  );
}
