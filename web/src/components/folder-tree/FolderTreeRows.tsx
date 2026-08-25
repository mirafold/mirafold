import { shownListing, type DirStore } from "../../folder-tree";
import { changeStatus } from "../../changes";
import { FolderTreeChevron, FolderTreeNodeGlyph, FolderTreeNodeSpacer } from "./FolderTreeNodeGlyph";

// The folder tree tree's ROWS — the pure recursive renderer split out of
// FolderTreePanel (which keeps the panel: frame, bus wiring, refresh policy).
// Everything here derives from props; no bus, no effects.

/** Quiet vertical hierarchy guides, like the optional guides in established
 * IDE project trees. The width keeps the established 12px-per-depth rhythm;
 * the lazy tree's data and interaction model do not know about them. */
function FolderTreeIndent({ depth }: { depth: number }) {
  return (
    <span
      className="folder-tree-indent-guides"
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

// One directory's children, rendered from the store — recursion IS the
// tree: an expanded child dir renders its own DirChildren, which shows a
// loading row until its fs_dir lands, then its listing. The wire stays
// non-recursive; nesting exists only here.
export function DirChildren({
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
  const dirState = store.get(path);
  if (!dirState) return null;
  const pad = { paddingLeft: `${depth * 12 + 6}px` };
  const listing = shownListing(dirState);
  if (!listing) {
    // Nothing usable yet: an inline loading row while the fetch flies, an
    // error row if it refused. Non-interactive rows are aria-disabled
    // treeitems — still part of the tree for the reading order.
    return (
      <ul className="folder-tree-ul" role="group">
        <li role="treeitem" aria-disabled="true" className="folder-tree-note-row" style={pad}>
          {dirState.phase === "error" ? dirState.error : "…"}
        </li>
      </ul>
    );
  }
  return (
    <ul className="folder-tree-ul" role="group">
      {listing.entries.length === 0 && (
        <li role="treeitem" aria-disabled="true" className="folder-tree-note-row" style={pad}>
          (empty)
        </li>
      )}
      {listing.entries.map((entry) => {
        const entryPath = path ? `${path}/${entry.name}` : entry.name;
        if (entry.kind === "dir") {
          const isOpen = expanded.has(entryPath);
          return (
            <li key={entry.name} role="treeitem" aria-expanded={isOpen}>
              <button className="folder-tree-row folder-tree-dir" onClick={() => onToggleDir(entryPath)}>
                <FolderTreeIndent depth={depth} />
                <span className="folder-tree-caret">
                  <FolderTreeChevron open={isOpen} />
                </span>
                <FolderTreeNodeSpacer />
                <span className="folder-tree-name">{entry.name}</span>
              </button>
              {isOpen && (
                <DirChildren
                  path={entryPath}
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
        // Files and symlinks are both leaves; a symlink
        // click goes through fs_read like any file — the daemon's jail
        // decides whether its target is readable.
        return (
          <li key={entry.name} role="treeitem">
            <button
              className="folder-tree-row folder-tree-file-row"
              onClick={() => onOpenFile(entryPath, entry.status)}
            >
              <FolderTreeIndent depth={depth} />
              <span className="folder-tree-caret" />
              <FolderTreeNodeGlyph name={entry.name} entryKind={entry.kind} />
              <span className="folder-tree-name">{entry.name}</span>
              {entry.status && (
                <span
                  className={`folder-tree-status folder-tree-status-${entry.status}`}
                  title={statusLabel(entry.status)}
                >
                  {entry.status}
                </span>
              )}
            </button>
          </li>
        );
      })}
      {listing.truncated && (
        <li role="treeitem" aria-disabled="true" className="folder-tree-note-row" style={pad}>
          …more entries than can be listed
        </li>
      )}
    </ul>
  );
}
