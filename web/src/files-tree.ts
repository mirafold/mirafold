import type { FsEntry } from "@protocol";

// Shell-owned flat→nested tree for the Explorer (E.3). The registry's
// FileTree.buildTree is agent surface (driven by agent output) — this is the
// same idea copied deliberately, not imported, with the differences the shell
// panel needs: full paths on every node (so a click knows what to request),
// a git status char carried on file nodes, and dirs-first ordering (the IDE
// convention). The wire stays non-recursive; nesting exists only here.

export type FileNode = {
  name: string;
  /** Root-relative /-separated path — what a click sends as fs_read/fs_diff. */
  path: string;
  isDir: boolean;
  status?: string;
  children: FileNode[];
};

export function buildFileTree(entries: FsEntry[]): FileNode[] {
  const roots: FileNode[] = [];
  for (const { path, status } of entries) {
    const segs = path.split("/").filter(Boolean);
    if (segs.length === 0) continue;
    let level = roots;
    let acc = "";
    for (let i = 0; i < segs.length; i++) {
      const name = segs[i]!;
      acc = acc ? `${acc}/${name}` : name;
      const isLast = i === segs.length - 1;
      let node = level.find((n) => n.name === name);
      if (!node) {
        node = { name, path: acc, isDir: !isLast, children: [] };
        level.push(node);
      } else if (!isLast) {
        node.isDir = true; // a deeper path proves an earlier leaf is a dir
      }
      if (isLast && status) node.status = status;
      level = node.children;
    }
  }
  sortTree(roots);
  return roots;
}

// Dirs before files, alphabetical within each — VS Code's ordering. The wire
// arrives alphabetical-flat; this is the display-time regroup.
function sortTree(nodes: FileNode[]): void {
  nodes.sort((a, b) =>
    a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const n of nodes) sortTree(n.children);
}
