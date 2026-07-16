import type { ComponentProps } from "@registry-spec";

export type TreeNode = {
  name: string;
  isDir: boolean;
  note?: string;
  children: TreeNode[];
};

// Flat slash-separated paths → nested tree. The flatness is deliberate: it
// keeps the wire schema non-recursive, so nesting exists only client-side.
// Display order is first appearance; a parent becomes a dir the moment any
// path reaches through it, and a trailing "/" marks a childless dir.
export function buildTree(paths: { path: string; note?: string }[]): TreeNode[] {
  const roots: TreeNode[] = [];
  for (const { path, note } of paths) {
    const segs = path.split("/").filter(Boolean);
    if (segs.length === 0) continue;
    const explicitDir = path.endsWith("/");
    let level = roots;
    let node: TreeNode | undefined;
    for (let i = 0; i < segs.length; i++) {
      const name = segs[i]!;
      const isLast = i === segs.length - 1;
      node = level.find((n) => n.name === name);
      if (!node) {
        node = { name, isDir: !isLast || explicitDir, children: [] };
        level.push(node);
      } else if (!isLast) {
        node.isDir = true;
      } else if (explicitDir) {
        node.isDir = true;
      }
      level = node.children;
    }
    if (node && note) node.note = note;
  }
  return roots;
}

function Branch({ nodes }: { nodes: TreeNode[] }) {
  return (
    <ul>
      {nodes.map((n) => (
        <li key={n.name}>
          <div className="rc-tree-row">
            <span className={n.isDir ? "rc-tree-name rc-tree-dir" : "rc-tree-name"}>
              {n.name}
              {n.isDir ? "/" : ""}
            </span>
            {n.note && <span className="rc-tree-note">{n.note}</span>}
          </div>
          {n.children.length > 0 && <Branch nodes={n.children} />}
        </li>
      ))}
    </ul>
  );
}

export function FileTree({ title, paths }: ComponentProps<"file-tree">) {
  return (
    <div className="rc rc-tree">
      {title && <div className="rc-title">{title}</div>}
      <Branch nodes={buildTree(paths)} />
    </div>
  );
}
